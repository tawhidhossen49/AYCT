-- The AYCT 2027 format, from the official guidebook.
--
-- * A Selection Round (Swiss, on Lichess) ranks the 32 qualifiers 1 to 32.
--   Groups are filled by rank: A = 1, 9, 17, 25; B = 2, 10, 18, 26; ...;
--   H = 8, 16, 24, 32. A player's rank is therefore (seed - 1) * 8 + group.
-- * Groups: double round robin at 5+0 (every pair twice, colours reversed).
-- * Knockout: every tie is a series. Round of 16 10+0, quarterfinals 10+5,
--   semifinals 15+5, third place 15+10 (2 games each); the final is 4 games
--   at 25+2, all played. The lower rank number has White in game 1.
-- * A level series gets one 3+2 tiebreak game with the colours of the last
--   game reversed. Still level: one 3+2 decider; the lower-ranked player
--   picks the colour, and a draw sends the higher-ranked player through.
-- * No first move by White within 5 minutes of the start, or by Black
--   within 5 minutes of White's first move: that player forfeits. If nobody
--   turned up at all, both forfeit (result 0-0).
--
-- How a knockout tie is stored: the bracket row (stage r16 to final, no
-- series_id) is the tie itself and is never played. Its games are rows with
-- series_id pointing to it, game_no 1..n, and game_kind game, tiebreak or
-- decider. The tie gets its winner_id when the series is decided.

-- ---------------------------------------------------------------- columns

alter table public.tournaments
  add column if not exists format jsonb not null default '{
    "group":    {"minutes": 5,  "increment": 0,  "games": 2},
    "r16":      {"minutes": 10, "increment": 0,  "games": 2},
    "qf":       {"minutes": 10, "increment": 5,  "games": 2},
    "sf":       {"minutes": 15, "increment": 5,  "games": 2},
    "third":    {"minutes": 15, "increment": 10, "games": 2},
    "final":    {"minutes": 25, "increment": 2,  "games": 4},
    "tiebreak": {"minutes": 3,  "increment": 2}
  }'::jsonb;

alter table public.matches
  add column if not exists series_id uuid references public.matches (id) on delete cascade,
  add column if not exists game_no int,
  add column if not exists game_kind text check (game_kind in ('game', 'tiebreak', 'decider')),
  add column if not exists choose_by uuid references public.profiles (id) on delete set null,
  add column if not exists draw_winner_id uuid references public.profiles (id) on delete set null;
create index if not exists matches_series_idx on public.matches (series_id);
create index if not exists matches_choose_by_idx on public.matches (choose_by);
create index if not exists matches_draw_winner_idx on public.matches (draw_winner_id);

-- 0-0: both players forfeited.
alter table public.matches drop constraint if exists matches_result_check;
alter table public.matches add constraint matches_result_check check (result in ('1-0', '0-1', '1/2-1/2', '0-0'));

-- ---------------------------------------------------------------- helpers

-- A player's Selection Round rank, from where they sit in the groups.
create or replace function private.rank_of(p_tournament uuid, p_player uuid)
returns int language sql stable security definer set search_path = '' as $$
  select (gp.seed - 1) * 8 + (ascii(g.label) - 64)
  from public.group_players gp join public.groups g on g.id = gp.group_id
  where gp.tournament_id = p_tournament and gp.player_id = p_player
$$;

-- "Round of 16 · Game 2", "Semifinal · Tiebreak", "Group stage · Round 4".
create or replace function private.game_label(p_stage public.match_stage, p_kind text, p_no int, p_round int)
returns text language sql immutable set search_path = '' as $$
  select private.stage_name(p_stage, false)
    || case
         when p_stage = 'group' and p_round is not null then ' · Round ' || p_round
         when p_kind = 'tiebreak' then ' · Tiebreak'
         when p_kind = 'decider' then ' · Decider'
         when p_kind = 'game' then ' · Game ' || p_no
         else ''
       end
$$;

create or replace function private.result_text(p_result text, p_reason text, p_draw_odds boolean)
returns text language sql immutable set search_path = '' as $$
  select case p_result when '1-0' then 'White won' when '0-1' then 'Black won' when '0-0' then 'Both players forfeited' else 'Drawn' end
    || case
         when p_reason is null or p_result = '0-0' then ''
         when p_reason = 'timeout' then ' on time'
         when p_reason = 'timeout vs insufficient material' then ' (out of time, but the opponent can''t mate)'
         when p_reason in ('checkmate', 'stalemate', 'insufficient material', 'threefold repetition', 'resignation', 'agreement', 'forfeit') then ' by ' || p_reason
         when p_reason = 'fifty-move rule' then ' by the fifty-move rule'
         when p_reason = 'result recorded by staff' then ' (result entered by the organisers)'
         when p_reason = 'test simulation' then ' (test simulation)'
         when p_reason = 'arbiter decision' then ' by arbiter''s decision'
         else ' (arbiter: ' || p_reason || ')'
       end
    || '.'
    || case when p_result = '1/2-1/2' and coalesce(p_draw_odds, false) then ' Black goes through on draw odds.' else '' end
$$;

-- Puts the better-ranked player (lower number) on White in the tie row.
create or replace function private.order_tie(p_tie uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
begin
  select * into t from public.matches where id = p_tie;
  if t.white_id is null or t.black_id is null then return; end if;
  if coalesce(private.rank_of(t.tournament_id, t.white_id), 99) > coalesce(private.rank_of(t.tournament_id, t.black_id), 99) then
    update public.matches set white_id = t.black_id, black_id = t.white_id where id = p_tie;
  end if;
end;
$$;

-- Creates the games of a tie once both players are known: 2 games (4 in
-- the final), colours alternating, the better-ranked player White first.
create or replace function private.make_series(p_tie uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
  f jsonb;
  n int;
  i int;
begin
  perform private.order_tie(p_tie);
  select * into t from public.matches where id = p_tie;
  if t.white_id is null or t.black_id is null then return; end if;
  if exists (select 1 from public.matches where series_id = p_tie) then return; end if;
  select format -> t.stage::text into f from public.tournaments where id = t.tournament_id;
  n := coalesce((f ->> 'games')::int, 2);
  for i in 1..n loop
    insert into public.matches (tournament_id, stage, bracket_slot, series_id, game_no, game_kind,
                                white_id, black_id, white_base_ms, black_base_ms, increment_ms, rated)
    values (t.tournament_id, t.stage, t.bracket_slot, p_tie, i, 'game',
            case when i % 2 = 1 then t.white_id else t.black_id end,
            case when i % 2 = 1 then t.black_id else t.white_id end,
            coalesce((f ->> 'minutes')::int, 10) * 60000, coalesce((f ->> 'minutes')::int, 10) * 60000,
            coalesce((f ->> 'increment')::int, 0) * 1000, false);
  end loop;
end;
$$;

-- A player's score in one game: 1, 0.5 or 0 (a double forfeit is 0 each).
create or replace function private.score_of(p_result text, p_white uuid, p_black uuid, p_player uuid)
returns numeric language sql immutable set search_path = '' as $$
  select case
    when p_result = '1/2-1/2' then 0.5
    when p_result = '1-0' and p_player = p_white then 1
    when p_result = '0-1' and p_player = p_black then 1
    else 0 end::numeric
$$;

-- Looks at a tie after one of its games ends: decides it, or adds the
-- tiebreak game, or the decider.
create or replace function private.settle_series(p_tie uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  t record;
  tn record;
  f jsonb;
  lg record;
  tb record;
  dc record;
  a_score numeric := 0;
  b_score numeric := 0;
  r record;
  winner uuid;
  chooser uuid;
  better uuid;
  mins int;
  inc int;
  wait int;
  new_id uuid;
begin
  select * into t from public.matches where id = p_tie;
  if t.id is null or t.winner_id is not null or t.white_id is null or t.black_id is null then return; end if;
  if exists (select 1 from public.matches where series_id = p_tie and game_kind = 'game' and status <> 'completed') then return; end if;

  for r in select * from public.matches where series_id = p_tie and game_kind = 'game' loop
    a_score := a_score + private.score_of(r.result, r.white_id, r.black_id, t.white_id);
    b_score := b_score + private.score_of(r.result, r.white_id, r.black_id, t.black_id);
  end loop;

  select * into tn from public.tournaments where id = t.tournament_id;
  f := tn.format -> 'tiebreak';
  mins := coalesce((f ->> 'minutes')::int, 3);
  inc := coalesce((f ->> 'increment')::int, 2);
  wait := coalesce(tn.tiebreak_delay_minutes, 10);

  if a_score <> b_score then
    winner := case when a_score > b_score then t.white_id else t.black_id end;
  elsif not tn.auto_tiebreak then
    -- Tiebreaks switched off: the organisers set the tie's winner.
    return;
  else
    select * into tb from public.matches where series_id = p_tie and game_kind = 'tiebreak';
    if tb.id is null then
      -- Level: one tiebreak game, the colours of the last game reversed.
      select * into lg from public.matches where series_id = p_tie and game_kind = 'game' order by game_no desc limit 1;
      insert into public.matches (tournament_id, stage, bracket_slot, series_id, game_kind, white_id, black_id,
                                  scheduled_at, white_base_ms, black_base_ms, increment_ms, rated)
      values (t.tournament_id, t.stage, t.bracket_slot, p_tie, 'tiebreak', lg.black_id, lg.white_id,
              now() + make_interval(mins => wait), mins * 60000, mins * 60000, inc * 1000, false)
      returning id into new_id;
      perform private.notify(lg.black_id, 'tiebreak', private.stage_name(t.stage, false) || ': tiebreak game',
        'The series is level. You play White in a ' || mins || '+' || inc || ' tiebreak, starting in ' || wait || case when wait = 1 then ' minute.' else ' minutes.' end, 'play.html?id=' || new_id);
      perform private.notify(lg.white_id, 'tiebreak', private.stage_name(t.stage, false) || ': tiebreak game',
        'The series is level. You play Black in a ' || mins || '+' || inc || ' tiebreak, starting in ' || wait || case when wait = 1 then ' minute.' else ' minutes.' end, 'play.html?id=' || new_id);
      return;
    elsif tb.status <> 'completed' then
      return;
    elsif tb.result in ('1-0', '0-1') then
      winner := tb.winner_id;
    else
      select * into dc from public.matches where series_id = p_tie and game_kind = 'decider';
      if dc.id is null then
        -- Still level: the decider. The lower-ranked player (higher number)
        -- picks the colour; a draw sends the higher-ranked player through.
        better := t.white_id;  -- order_tie keeps the better rank on White in the tie row
        chooser := t.black_id;
        insert into public.matches (tournament_id, stage, bracket_slot, series_id, game_kind, white_id, black_id,
                                    choose_by, draw_winner_id, scheduled_at, white_base_ms, black_base_ms, increment_ms, rated)
        values (t.tournament_id, t.stage, t.bracket_slot, p_tie, 'decider', chooser, better,
                chooser, better, now() + make_interval(mins => wait), mins * 60000, mins * 60000, inc * 1000, false)
        returning id into new_id;
        perform private.notify(chooser, 'tiebreak', private.stage_name(t.stage, false) || ': decider game',
          'Still level after the tiebreak. Choose your colour for the ' || mins || '+' || inc || ' decider in the Arena; a draw sends ' || private.player_name(better) || ' through. It starts in ' || wait || case when wait = 1 then ' minute.' else ' minutes.' end, 'play.html?id=' || new_id);
        perform private.notify(better, 'tiebreak', private.stage_name(t.stage, false) || ': decider game',
          'Still level after the tiebreak. ' || private.player_name(chooser) || ' chooses the colours for the ' || mins || '+' || inc || ' decider; a draw is enough for you. It starts in ' || wait || case when wait = 1 then ' minute.' else ' minutes.' end, 'play.html?id=' || new_id);
        return;
      elsif dc.status <> 'completed' then
        return;
      else
        winner := coalesce(dc.winner_id, dc.draw_winner_id);
      end if;
    end if;
  end if;

  update public.matches set winner_id = winner, status = 'completed', ended_at = now() where id = p_tie;
end;
$$;

-- ---------------------------------------------------------------- group table: 0-0 counts nothing

create or replace function public.group_table(p_group uuid)
returns table (player_id uuid, played int, wins int, draws int, losses int, points numeric, sb numeric, rating int, rank int)
language sql stable security definer set search_path = '' as $$
  with members as (
    select gp.player_id, gp.seed from public.group_players gp where gp.group_id = p_group
  ), games as (
    select * from public.matches m
    where m.group_id = p_group and m.stage = 'group' and m.status = 'completed' and m.result is not null
  ), scores as (
    select g.id, g.white_id as pid, g.black_id as opp, private.score_of(g.result, g.white_id, g.black_id, g.white_id) as s from games g
    union all
    select g.id, g.black_id, g.white_id, private.score_of(g.result, g.white_id, g.black_id, g.black_id) from games g
  ), base as (
    select m.player_id, m.seed,
           count(s.id)::int as played,
           (count(s.id) filter (where s.s = 1))::int as wins,
           (count(s.id) filter (where s.s = 0.5))::int as draws,
           (count(s.id) filter (where s.s = 0))::int as losses,
           coalesce(sum(s.s), 0) as points
    from members m left join scores s on s.pid = m.player_id
    group by m.player_id, m.seed
  ), withsb as (
    select b.*, coalesce((select sum(s.s * ob.points) from scores s join base ob on ob.player_id = s.opp where s.pid = b.player_id), 0) as sb
    from base b
  ), mini as (
    select w.*, coalesce((
      select sum(s.s) from scores s join withsb t2 on t2.player_id = s.opp
      where s.pid = w.player_id and t2.points = w.points and t2.sb = w.sb and t2.wins = w.wins
    ), 0) as mini
    from withsb w
  )
  select mi.player_id, mi.played, mi.wins, mi.draws, mi.losses, mi.points, mi.sb, p.rating,
         (row_number() over (order by mi.points desc, mi.sb desc, mi.wins desc, mi.mini desc, mi.seed asc))::int
  from mini mi join public.profiles p on p.id = mi.player_id
$$;
revoke execute on function public.group_table(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- the bracket (guidebook pairings)

create or replace function private.build_knockout(p_tournament uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q jsonb := '{}'::jsonb;
  g record;
  r record;
  final_id uuid := gen_random_uuid();
  sf uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  qf uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  -- M1 A1 v H2, M2 H1 v A2, M3 D1 v E2, M4 E1 v D2, M5 C1 v F2, M6 F1 v C2, M7 B1 v G2, M8 G1 v B2
  pairs text[] := array['A1:H2','H1:A2','D1:E2','E1:D2','C1:F2','F1:C2','B1:G2','G1:B2'];
  i int;
  a uuid;
  b uuid;
  tie uuid;
begin
  for g in select id, label from public.groups where tournament_id = p_tournament loop
    for r in select * from public.group_table(g.id) where rank <= 2 loop
      q := q || jsonb_build_object(g.label || r.rank, r.player_id);
    end loop;
  end loop;

  delete from public.matches where tournament_id = p_tournament and stage in ('r16', 'qf', 'sf', 'final', 'third');

  -- The final first: its third-place tie is created with it (matches_after_insert).
  insert into public.matches (id, tournament_id, stage, bracket_slot) values (final_id, p_tournament, 'final', 1);
  for i in 1..2 loop
    insert into public.matches (id, tournament_id, stage, bracket_slot, next_match_id, next_color)
    values (sf[i], p_tournament, 'sf', i, final_id, case when i = 1 then 'white' else 'black' end);
  end loop;
  for i in 1..4 loop
    insert into public.matches (id, tournament_id, stage, bracket_slot, next_match_id, next_color)
    values (qf[i], p_tournament, 'qf', i, sf[(i + 1) / 2], case when i % 2 = 1 then 'white' else 'black' end);
  end loop;
  for i in 1..8 loop
    a := (q ->> split_part(pairs[i], ':', 1))::uuid;
    b := (q ->> split_part(pairs[i], ':', 2))::uuid;
    insert into public.matches (tournament_id, stage, bracket_slot, next_match_id, next_color, white_id, black_id)
    values (p_tournament, 'r16', i, qf[(i + 1) / 2], case when i % 2 = 1 then 'white' else 'black' end, a, b)
    returning id into tie;
    perform private.make_series(tie);
    perform private.notify(a, 'advanced', 'Through to the Round of 16',
      'You qualified as ' || split_part(pairs[i], ':', 1) || ' and meet ' || private.player_name(b) || ' in a two-game series.', 'bracket.html');
    perform private.notify(b, 'advanced', 'Through to the Round of 16',
      'You qualified as ' || split_part(pairs[i], ':', 2) || ' and meet ' || private.player_name(a) || ' in a two-game series.', 'bracket.html');
  end loop;

  update public.tournaments set status = 'knockout' where id = p_tournament;
end;
$$;
revoke execute on function private.build_knockout(uuid) from public, anon, authenticated;

-- The third-place tie belongs to the final tie (not to the final's games).
create or replace function public.matches_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.stage = 'final' and new.tiebreak_of is null and new.series_id is null then
    insert into public.matches (tournament_id, stage, bracket_slot, companion_of)
    values (new.tournament_id, 'third', 1, new.id);
  end if;
  return new;
end;
$$;
revoke execute on function public.matches_after_insert() from public, anon, authenticated;

-- ---------------------------------------------------------------- before update: winners

create or replace function public.matches_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.updated_at := now();

  if new.scheduled_at is distinct from old.scheduled_at then
    new.reminded := false;
  end if;

  if new.result is distinct from old.result and new.result is not null then
    if new.result = '1-0' then
      new.winner_id := new.white_id;
    elsif new.result = '0-1' then
      new.winner_id := new.black_id;
    elsif new.draw_winner_id is not null then
      new.winner_id := new.draw_winner_id;   -- decider: a draw sends the higher-ranked player through
    elsif new.draw_odds then
      new.winner_id := new.black_id;          -- old Armageddon games
    else
      new.winner_id := null;                  -- a draw, or both forfeited
    end if;
  end if;

  if new.result is null and old.result is not null then
    new.winner_id := null;
  end if;

  if old.ratings_applied then
    update public.profiles set rating = rating - coalesce(old.white_rating_delta, 0) where id = old.white_id;
    update public.profiles set rating = rating - coalesce(old.black_rating_delta, 0) where id = old.black_id;
    new.ratings_applied := false;
    new.white_rating_delta := null;
    new.black_rating_delta := null;
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    new.ended_at := coalesce(new.ended_at, now());
  end if;

  return new;
end;
$$;
revoke execute on function public.matches_before_update() from public, anon, authenticated;

-- ---------------------------------------------------------------- after update: notifications, series, bracket

create or replace function public.matches_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  link text := 'play.html?id=' || new.id;
  is_tie boolean := new.stage in ('r16', 'qf', 'sf', 'third', 'final') and new.series_id is null;
  label text := private.game_label(new.stage, new.game_kind, new.game_no, new.round);
  score text := replace(coalesce(new.result, ''), '1/2-1/2', '½-½');
  p uuid;
begin
  select * into t from public.tournaments where id = new.tournament_id;

  -- A tie gets its players. A newcomer hears they are through; once both
  -- are known, both hear who they meet.
  if is_tie then
    foreach p in array array[new.white_id, new.black_id] loop
      if p is not null and p is distinct from old.white_id and p is distinct from old.black_id then
        perform private.notify(p, 'advanced',
          case when new.stage = 'third' then 'You play for third place' else 'Through to the ' || private.stage_name(new.stage, false) end,
          case when new.white_id is null or new.black_id is null then 'Your opponent is still to be decided.'
               else 'You meet ' || private.player_name(case when p = new.white_id then new.black_id else new.white_id end)
                    || case when new.stage = 'final' then ' in a four-game series.' else ' in a two-game series.' end end,
          'bracket.html');
      elsif p is not null and new.white_id is not null and new.black_id is not null and (old.white_id is null or old.black_id is null) then
        perform private.notify(p, 'advanced', 'Your ' || lower(private.stage_name(new.stage, false)) || ' opponent',
          'You meet ' || private.player_name(case when p = new.white_id then new.black_id else new.white_id end)
          || case when new.stage = 'final' then ' in a four-game series.' else ' in a two-game series.' end, 'bracket.html');
      end if;
    end loop;
    return new;
  end if;

  -- Scheduled or moved: both players hear about it.
  if new.scheduled_at is distinct from old.scheduled_at and new.scheduled_at is not null and new.status = 'scheduled' then
    perform private.notify(new.white_id, 'scheduled', label || ': game scheduled',
      'You play White against ' || private.player_name(new.black_id) || '.', link);
    perform private.notify(new.black_id, 'scheduled', label || ': game scheduled',
      'You play Black against ' || private.player_name(new.white_id) || '.', link);
  end if;

  -- The organisers changed a result that had already been announced.
  if new.status = 'completed' and old.status = 'completed' and new.result is not null and new.result is distinct from old.result then
    perform private.notify(new.white_id, 'result', label || ': result corrected to ' || score, private.result_text(new.result, new.end_reason, false), link);
    perform private.notify(new.black_id, 'result', label || ': result corrected to ' || score, private.result_text(new.result, new.end_reason, false), link);
    if new.series_id is not null then perform private.settle_series(new.series_id); end if;
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    perform private.notify(new.white_id, 'result', label || ': ' || score, private.result_text(new.result, new.end_reason, false), link);
    perform private.notify(new.black_id, 'result', label || ': ' || score, private.result_text(new.result, new.end_reason, false), link);

    if new.series_id is not null then
      perform private.settle_series(new.series_id);
    end if;

    -- Last group game done: build the bracket.
    if new.stage = 'group' and t.auto_knockout and t.status = 'groups'
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage = 'group' and status <> 'completed')
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage in ('r16', 'qf', 'sf', 'third', 'final')) then
      perform private.build_knockout(new.tournament_id);
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.matches_automation() from public, anon, authenticated;

-- A decided tie moves its winner on; semifinal losers go to the third-place
-- tie; the final's winner completes the tournament. Only tie rows do this.
create or replace function public.matches_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  loser uuid;
  third uuid;
begin
  if new.series_id is not null or new.stage not in ('r16', 'qf', 'sf', 'third', 'final') then
    return new;
  end if;

  if new.winner_id is distinct from old.winner_id and new.winner_id is not null then
    if new.next_match_id is not null then
      if new.next_color = 'white' then
        update public.matches set white_id = new.winner_id where id = new.next_match_id and winner_id is null;
      else
        update public.matches set black_id = new.winner_id where id = new.next_match_id and winner_id is null;
      end if;
      perform private.make_series(new.next_match_id);
    end if;

    if new.stage = 'sf' then
      loser := case when new.winner_id = new.white_id then new.black_id else new.white_id end;
      select id into third from public.matches
      where tournament_id = new.tournament_id and stage = 'third' and series_id is null and tiebreak_of is null limit 1;
      if third is not null then
        if new.bracket_slot = 1 then
          update public.matches set white_id = loser where id = third and winner_id is null;
        else
          update public.matches set black_id = loser where id = third and winner_id is null;
        end if;
        perform private.make_series(third);
      end if;
    end if;

    if new.stage = 'final' then
      update public.tournaments set status = 'complete' where id = new.tournament_id;
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.matches_after_update() from public, anon, authenticated;

-- ---------------------------------------------------------------- forfeits and timeouts (every 20 seconds)

create or replace function private.finalize_timeouts()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  turn text;
  left_ms numeric;
  opp text;
  cannot_mate boolean;
  res text;
  why text;
  black_here boolean;
begin
  for r in
    select m.*, t.time_control_minutes
    from public.matches m join public.tournaments t on t.id = m.tournament_id
    where m.paused_at is null and m.white_id is not null and m.black_id is not null
      and m.scheduled_at <= now()
      and (m.status = 'live' or (m.status = 'scheduled' and m.move_count = 0))
  loop
    -- First-move deadlines (no clock runs before them): White 5 minutes
    -- after the start, Black 5 minutes after White's first move. The game
    -- server applies the same rule when someone acts in the game.
    if r.move_count < 2 then
      continue when now() <= coalesce(case when r.status = 'live' then r.clock_started_at end, r.scheduled_at) + interval '5 minutes' + interval '1.5 seconds';
      if r.move_count = 1 then
        res := '1-0'; why := 'forfeit';
      else
        black_here := exists (select 1 from public.game_events e where e.match_id = r.id and e.user_id = r.black_id and e.kind = 'joined')
                      or exists (select 1 from public.profiles p where p.id = r.black_id and p.is_bot);
        if black_here then
          res := '0-1'; why := 'forfeit';
        else
          res := '0-0'; why := 'double forfeit';
        end if;
      end if;
    else
      turn := coalesce(nullif(split_part(r.fen, ' ', 2), ''), 'w');
      left_ms := (case when turn = 'w' then r.white_ms else r.black_ms end) - extract(epoch from now() - r.clock_started_at) * 1000;
      continue when left_ms is null or left_ms > -1500;
      opp := case when turn = 'w' then regexp_replace(split_part(r.fen, ' ', 1), '[^pnbrq]', '', 'g')
                  else regexp_replace(split_part(r.fen, ' ', 1), '[^PNBRQ]', '', 'g') end;
      cannot_mate := length(opp) = 0 or lower(opp) in ('n', 'b');
      res := case when cannot_mate then '1/2-1/2' when turn = 'w' then '0-1' else '1-0' end;
      why := case when cannot_mate then 'timeout vs insufficient material' else 'timeout' end;
    end if;

    update public.matches set
      status = 'completed',
      result = res,
      end_reason = why,
      started_at = coalesce(started_at, scheduled_at),
      white_ms = case when why like 'timeout%' and turn = 'w' then 0 else coalesce(white_ms, white_base_ms, r.time_control_minutes * 60000) end,
      black_ms = case when why like 'timeout%' and turn = 'b' then 0 else coalesce(black_ms, black_base_ms, r.time_control_minutes * 60000) end,
      draw_offer_by = null,
      choose_by = null,
      ended_at = now()
    where id = r.id and move_count = r.move_count and status = r.status;

    if found then
      insert into public.game_events (match_id, user_id, kind, detail)
      values (r.id, null, 'game_over', jsonb_build_object('result', res, 'reason', why));
    end if;
  end loop;
end;
$$;
revoke execute on function private.finalize_timeouts() from public, anon, authenticated;

revoke execute on function private.rank_of(uuid, uuid) from public, anon, authenticated;
revoke execute on function private.game_label(public.match_stage, text, int, int) from public, anon, authenticated;
revoke execute on function private.order_tie(uuid) from public, anon, authenticated;
revoke execute on function private.make_series(uuid) from public, anon, authenticated;
revoke execute on function private.score_of(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function private.settle_series(uuid) from public, anon, authenticated;
revoke execute on function private.result_text(text, text, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------- reminders and the group update

-- Players are asked to be online 15 minutes before the start, so the
-- reminder comes then, naming the game ("Semifinal · Game 2").
create or replace function private.send_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select * from public.matches
    where status = 'scheduled' and not reminded and white_id is not null and black_id is not null
      and scheduled_at > now() and scheduled_at <= now() + interval '15 minutes'
  loop
    perform private.notify(r.white_id, 'reminder', private.game_label(r.stage, r.game_kind, r.game_no, r.round) || ': starts soon',
      'You play White against ' || private.player_name(r.black_id) || '. Open the Arena now: you have 5 minutes from the start to make your first move.', 'play.html?id=' || r.id);
    perform private.notify(r.black_id, 'reminder', private.game_label(r.stage, r.game_kind, r.game_no, r.round) || ': starts soon',
      'You play Black against ' || private.player_name(r.white_id) || '. Open the Arena now: you have 5 minutes after White''s first move to reply.', 'play.html?id=' || r.id);
    update public.matches set reminded = true where id = r.id;
  end loop;
end;
$$;
revoke execute on function private.send_reminders() from public, anon, authenticated;

create or replace function public.group_players_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lbl text;
begin
  select label into lbl from public.groups where id = new.group_id;
  perform private.notify(new.player_id, 'draw', 'You are in Group ' || lbl,
    'Selection Round rank ' || ((new.seed - 1) * 8 + ascii(lbl) - 64) || '. Everyone in your group plays everyone twice, once with each colour. The top two reach the round of 16.', 'groups.html');
  return new;
end;
$$;
revoke execute on function public.group_players_notify() from public, anon, authenticated;
