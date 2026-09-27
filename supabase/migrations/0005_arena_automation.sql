-- Arena and tournament automation.
--
-- Rules follow the FIDE Online Chess Regulations: the platform declares
-- draws itself, a flag fall loses unless the opponent cannot mate, the clock
-- keeps running through disconnections, arbiters may pause and add time.
-- Knockout draws are settled by an Armageddon game (White 5 min, Black 4,
-- +2 s; Black has draw odds).

-- ---------------------------------------------------------------- columns

alter table public.matches
  add column if not exists tiebreak_of uuid references public.matches (id) on delete cascade,
  add column if not exists white_base_ms int,
  add column if not exists black_base_ms int,
  add column if not exists increment_ms int,
  add column if not exists draw_odds boolean not null default false,
  add column if not exists paused_at timestamptz,
  add column if not exists clocks int[] not null default '{}',
  add column if not exists reminded boolean not null default false;
create index if not exists matches_tiebreak_idx on public.matches (tiebreak_of);

alter table public.tournaments
  add column if not exists auto_knockout boolean not null default true,
  add column if not exists auto_tiebreak boolean not null default true,
  add column if not exists tiebreak_delay_minutes int not null default 10 check (tiebreak_delay_minutes between 1 and 1440),
  add column if not exists draw_offer_min_moves int not null default 0 check (draw_offer_min_moves between 0 and 100);

-- ---------------------------------------------------------------- notifications (the players' updates feed)

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null,
  title text not null,
  body text,
  link text,
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;

create policy "read own or staff reads all" on public.notifications
  for select to authenticated using (user_id = (select auth.uid()) or (select private.is_staff()));
create policy "mark own as read" on public.notifications
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "staff send messages" on public.notifications
  for insert to authenticated with check ((select private.is_staff()));
create policy "delete own" on public.notifications
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- game events (fair-play and arbiter log)

create table if not exists public.game_events (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  kind text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index if not exists game_events_match_idx on public.game_events (match_id, created_at);
create index if not exists game_events_user_idx on public.game_events (user_id);
alter table public.game_events enable row level security;

create policy "staff read all, players read own" on public.game_events
  for select to authenticated using ((select private.is_staff()) or user_id = (select auth.uid()));
-- Players may only log their own attention events in their own games.
create policy "players log own attention" on public.game_events
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and kind in ('joined', 'tab_hidden', 'tab_visible')
    and exists (select 1 from public.matches m where m.id = match_id and (m.white_id = (select auth.uid()) or m.black_id = (select auth.uid())))
  );

-- ---------------------------------------------------------------- helpers

create or replace function private.notify(p_user uuid, p_kind text, p_title text, p_body text, p_link text)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, kind, title, body, link)
  select p_user, p_kind, p_title, p_body, p_link where p_user is not null
$$;

create or replace function private.stage_name(p_stage public.match_stage, p_tiebreak boolean)
returns text language sql immutable set search_path = '' as $$
  select case p_stage when 'group' then 'Group stage' when 'r16' then 'Round of 16' when 'qf' then 'Quarterfinal'
                      when 'sf' then 'Semifinal' else 'Final' end
         || case when p_tiebreak then ' Armageddon' else '' end
$$;

create or replace function private.player_name(p_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select full_name from public.profiles where id = p_id), 'your opponent')
$$;

-- ---------------------------------------------------------------- group standings (same rules as the site)
-- Points, then Sonneborn-Berger, then wins, then the mini-league between the
-- players still tied, then rating.

create or replace function public.group_table(p_group uuid)
returns table (player_id uuid, played int, wins int, draws int, losses int, points numeric, sb numeric, rating int, rank int)
language sql stable security definer set search_path = '' as $$
  with members as (
    select gp.player_id from public.group_players gp where gp.group_id = p_group
  ), games as (
    select * from public.matches m
    where m.group_id = p_group and m.stage = 'group' and m.status = 'completed' and m.result is not null
  ), scores as (
    select g.id, g.white_id as pid, g.black_id as opp,
           case g.result when '1-0' then 1.0 when '0-1' then 0.0 else 0.5 end as s from games g
    union all
    select g.id, g.black_id, g.white_id,
           case g.result when '1-0' then 0.0 when '0-1' then 1.0 else 0.5 end from games g
  ), base as (
    select m.player_id,
           count(s.id)::int as played,
           (count(s.id) filter (where s.s = 1))::int as wins,
           (count(s.id) filter (where s.s = 0.5))::int as draws,
           (count(s.id) filter (where s.s = 0))::int as losses,
           coalesce(sum(s.s), 0) as points
    from members m left join scores s on s.pid = m.player_id
    group by m.player_id
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
         (row_number() over (order by mi.points desc, mi.sb desc, mi.wins desc, mi.mini desc, p.rating desc))::int
  from mini mi join public.profiles p on p.id = mi.player_id
$$;

-- ---------------------------------------------------------------- knockout bracket (World Cup pairings)

create or replace function private.build_knockout(p_tournament uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  q jsonb := '{}'::jsonb;
  g record;
  r record;
  final_id uuid := gen_random_uuid();
  sf uuid[] := array[gen_random_uuid(), gen_random_uuid()];
  qf uuid[] := array[gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()];
  pairs text[] := array['A1:B2','C1:D2','E1:F2','G1:H2','B1:A2','D1:C2','F1:E2','H1:G2'];
  i int;
  a text;
  b text;
begin
  -- qualifiers: "A1" -> winner of group A, "A2" -> runner-up
  for g in select id, label from public.groups where tournament_id = p_tournament loop
    for r in select * from public.group_table(g.id) where rank <= 2 loop
      q := q || jsonb_build_object(g.label || r.rank, r.player_id);
    end loop;
  end loop;

  delete from public.matches where tournament_id = p_tournament and stage <> 'group';

  insert into public.matches (id, tournament_id, stage, bracket_slot) values (final_id, p_tournament, 'final', 1);
  for i in 1..2 loop
    insert into public.matches (id, tournament_id, stage, bracket_slot, next_match_id, next_color)
    values (sf[i], p_tournament, 'sf', i, final_id, case when i % 2 = 1 then 'white' else 'black' end);
  end loop;
  for i in 1..4 loop
    insert into public.matches (id, tournament_id, stage, bracket_slot, next_match_id, next_color)
    values (qf[i], p_tournament, 'qf', i, sf[(i + 1) / 2], case when i % 2 = 1 then 'white' else 'black' end);
  end loop;
  for i in 1..8 loop
    a := split_part(pairs[i], ':', 1);
    b := split_part(pairs[i], ':', 2);
    insert into public.matches (tournament_id, stage, bracket_slot, next_match_id, next_color, white_id, black_id)
    values (p_tournament, 'r16', i, qf[(i + 1) / 2], case when i % 2 = 1 then 'white' else 'black' end,
            (q ->> a)::uuid, (q ->> b)::uuid);
    perform private.notify((q ->> a)::uuid, 'advanced', 'Through to the Round of 16',
      'You qualified as ' || a || ' and play White against ' || private.player_name((q ->> b)::uuid) || '.', 'home.html');
    perform private.notify((q ->> b)::uuid, 'advanced', 'Through to the Round of 16',
      'You qualified as ' || b || ' and play Black against ' || private.player_name((q ->> a)::uuid) || '.', 'home.html');
  end loop;

  update public.tournaments set status = 'knockout' where id = p_tournament;
end;
$$;

-- Staff button in the admin panel.
create or replace function public.generate_knockout(p_tournament uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_staff() then
    raise exception 'Only admins and moderators can generate the bracket';
  end if;
  perform private.build_knockout(p_tournament);
end;
$$;

-- ---------------------------------------------------------------- before update: results, ratings, reminders

create or replace function public.matches_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  w_rating int;
  b_rating int;
  expected_w numeric;
  score_w numeric;
  k constant int := 32;
begin
  new.updated_at := now();

  -- a new start time earns a new reminder
  if new.scheduled_at is distinct from old.scheduled_at then
    new.reminded := false;
  end if;

  if new.result is distinct from old.result and new.result is not null then
    if new.result = '1-0' then
      new.winner_id := new.white_id;
    elsif new.result = '0-1' then
      new.winner_id := new.black_id;
    elsif new.draw_odds then
      new.winner_id := new.black_id;          -- Armageddon: Black wins a draw
    elsif new.stage = 'group' then
      new.winner_id := null;
    end if;
    -- a drawn knockout game keeps whatever winner staff picked, or waits for its tiebreak
  end if;

  if new.result is null and old.result is not null then
    new.winner_id := null;
  end if;

  -- A reset or corrected result undoes the rating change it caused.
  if old.ratings_applied and (new.status <> 'completed' or new.result is distinct from old.result) then
    update public.profiles set rating = rating - coalesce(old.white_rating_delta, 0) where id = old.white_id;
    update public.profiles set rating = rating - coalesce(old.black_rating_delta, 0) where id = old.black_id;
    new.ratings_applied := false;
    new.white_rating_delta := null;
    new.black_rating_delta := null;
  end if;

  -- Rated games only: tiebreaks are faster games and are not rated.
  if new.status = 'completed' and new.result is not null and not new.ratings_applied
     and new.tiebreak_of is null and new.white_id is not null and new.black_id is not null then
    select rating into w_rating from public.profiles where id = new.white_id;
    select rating into b_rating from public.profiles where id = new.black_id;
    expected_w := 1 / (1 + power(10::numeric, (b_rating - w_rating) / 400.0));
    score_w := case new.result when '1-0' then 1 when '0-1' then 0 else 0.5 end;
    new.white_rating_delta := round(k * (score_w - expected_w));
    new.black_rating_delta := -new.white_rating_delta;
    update public.profiles set rating = rating + new.white_rating_delta where id = new.white_id;
    update public.profiles set rating = rating + new.black_rating_delta where id = new.black_id;
    new.ratings_applied := true;
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    new.ended_at := coalesce(new.ended_at, now());
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------- after update: automation and updates feed

create or replace function public.matches_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  link text := 'play.html?id=' || new.id;
  label text := private.stage_name(new.stage, new.tiebreak_of is not null);
  res text;
  tb_id uuid;
begin
  select * into t from public.tournaments where id = new.tournament_id;

  -- Scheduled or moved: both players hear about it.
  if new.scheduled_at is distinct from old.scheduled_at and new.scheduled_at is not null and new.status = 'scheduled' then
    perform private.notify(new.white_id, 'scheduled', label || ': game scheduled',
      'You play White against ' || private.player_name(new.black_id) || '.', link);
    perform private.notify(new.black_id, 'scheduled', label || ': game scheduled',
      'You play Black against ' || private.player_name(new.white_id) || '.', link);
  end if;

  -- A player placed into a later round (bracket advancement).
  if new.white_id is distinct from old.white_id and new.white_id is not null and new.stage <> 'group' then
    perform private.notify(new.white_id, 'advanced', 'Through to the ' || label, 'You play White in the next round.', link);
  end if;
  if new.black_id is distinct from old.black_id and new.black_id is not null and new.stage <> 'group' then
    perform private.notify(new.black_id, 'advanced', 'Through to the ' || label, 'You play Black in the next round.', link);
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    res := case new.result when '1-0' then 'White won' when '0-1' then 'Black won' else 'Drawn' end
           || coalesce(' by ' || new.end_reason, '');
    perform private.notify(new.white_id, 'result', label || ': ' || replace(coalesce(new.result, ''), '1/2-1/2', '½-½'),
      res || case when new.white_rating_delta is not null then '. Rating ' || case when new.white_rating_delta >= 0 then '+' else '' end || new.white_rating_delta || '.' else '.' end,
      link);
    perform private.notify(new.black_id, 'result', label || ': ' || replace(coalesce(new.result, ''), '1/2-1/2', '½-½'),
      res || case when new.black_rating_delta is not null then '. Rating ' || case when new.black_rating_delta >= 0 then '+' else '' end || new.black_rating_delta || '.' else '.' end,
      link);

    -- A drawn knockout game with no winner: Armageddon, colours reversed.
    if new.stage <> 'group' and new.result = '1/2-1/2' and new.winner_id is null and new.tiebreak_of is null
       and t.auto_tiebreak and not exists (select 1 from public.matches where tiebreak_of = new.id) then
      insert into public.matches (tournament_id, stage, tiebreak_of, white_id, black_id, scheduled_at,
                                  white_base_ms, black_base_ms, increment_ms, draw_odds)
      values (new.tournament_id, new.stage, new.id, new.black_id, new.white_id,
              now() + make_interval(mins => t.tiebreak_delay_minutes), 300000, 240000, 2000, true)
      returning id into tb_id;
      perform private.notify(new.black_id, 'tiebreak', label || ': Armageddon tiebreak',
        'You have White (5 min) and must win. Starts in ' || t.tiebreak_delay_minutes || ' minutes.', 'play.html?id=' || tb_id);
      perform private.notify(new.white_id, 'tiebreak', label || ': Armageddon tiebreak',
        'You have Black (4 min); a draw is enough. Starts in ' || t.tiebreak_delay_minutes || ' minutes.', 'play.html?id=' || tb_id);
    end if;

    -- A finished tiebreak decides its game: the winner moves on from there.
    if new.tiebreak_of is not null and new.winner_id is not null then
      update public.matches set winner_id = new.winner_id where id = new.tiebreak_of;
    end if;

    -- Last group game done: build the bracket.
    if new.stage = 'group' and t.auto_knockout and t.status = 'groups'
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage = 'group' and status <> 'completed')
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage <> 'group') then
      perform private.build_knockout(new.tournament_id);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists matches_automation on public.matches;
create trigger matches_automation
  after update on public.matches
  for each row execute function public.matches_automation();

-- Drawn into a group.
create or replace function public.group_players_notify() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lbl text;
begin
  select label into lbl from public.groups where id = new.group_id;
  perform private.notify(new.player_id, 'draw', 'You are in Group ' || lbl,
    'Your group plays a round robin. The top two reach the round of 16.', 'groups.html');
  return new;
end;
$$;
drop trigger if exists group_players_notify on public.group_players;
create trigger group_players_notify after insert on public.group_players
  for each row execute function public.group_players_notify();

-- ---------------------------------------------------------------- server clock jobs

-- Ends every game whose side to move has run out of time, even if nobody
-- has the game open (no-shows included).
create or replace function private.finalize_timeouts()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  turn text;
  left_ms numeric;
  opp text;
  cannot_mate boolean;
begin
  for r in
    select m.*, t.time_control_minutes
    from public.matches m join public.tournaments t on t.id = m.tournament_id
    where m.paused_at is null and m.white_id is not null and m.black_id is not null
      and m.scheduled_at <= now()
      and (m.status = 'live' or (m.status = 'scheduled' and m.move_count = 0))
  loop
    if r.status = 'scheduled' then
      turn := 'w';
      left_ms := coalesce(r.white_base_ms, r.time_control_minutes * 60000) - extract(epoch from now() - r.scheduled_at) * 1000;
    else
      turn := coalesce(nullif(split_part(r.fen, ' ', 2), ''), 'w');
      left_ms := (case when turn = 'w' then r.white_ms else r.black_ms end) - extract(epoch from now() - r.clock_started_at) * 1000;
    end if;
    continue when left_ms is null or left_ms > -1500;

    opp := case when turn = 'w' then regexp_replace(split_part(r.fen, ' ', 1), '[^pnbrq]', '', 'g')
                else regexp_replace(split_part(r.fen, ' ', 1), '[^PNBRQ]', '', 'g') end;
    cannot_mate := length(opp) = 0 or lower(opp) in ('n', 'b');

    update public.matches set
      status = 'completed',
      result = case when cannot_mate then '1/2-1/2' when turn = 'w' then '0-1' else '1-0' end,
      end_reason = case when cannot_mate then 'timeout vs insufficient material' else 'timeout' end,
      started_at = coalesce(started_at, scheduled_at),
      white_ms = case when turn = 'w' then 0 else coalesce(white_ms, white_base_ms, r.time_control_minutes * 60000) end,
      black_ms = case when turn = 'b' then 0 else coalesce(black_ms, black_base_ms, r.time_control_minutes * 60000) end,
      draw_offer_by = null,
      ended_at = now()
    where id = r.id and move_count = r.move_count and status = r.status;
  end loop;
end;
$$;

-- "Your game starts in 10 minutes."
create or replace function private.send_reminders()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select * from public.matches
    where status = 'scheduled' and not reminded and white_id is not null and black_id is not null
      and scheduled_at > now() and scheduled_at <= now() + interval '10 minutes'
  loop
    perform private.notify(r.white_id, 'reminder', 'Your game starts soon',
      'You play White against ' || private.player_name(r.black_id) || '. Open the Arena now.', 'play.html?id=' || r.id);
    perform private.notify(r.black_id, 'reminder', 'Your game starts soon',
      'You play Black against ' || private.player_name(r.white_id) || '. Open the Arena now.', 'play.html?id=' || r.id);
    update public.matches set reminded = true where id = r.id;
  end loop;
end;
$$;

revoke execute on function private.notify(uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function private.build_knockout(uuid) from public, anon, authenticated;
revoke execute on function private.finalize_timeouts() from public, anon, authenticated;
revoke execute on function private.send_reminders() from public, anon, authenticated;
revoke execute on function private.stage_name(public.match_stage, boolean) from public, anon, authenticated;
revoke execute on function private.player_name(uuid) from public, anon, authenticated;
revoke execute on function public.matches_automation() from public, anon, authenticated;
revoke execute on function public.group_players_notify() from public, anon, authenticated;
revoke execute on function public.generate_knockout(uuid) from public, anon;
revoke execute on function public.group_table(uuid) from public, anon;

create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'amaze-clock-jobs';
select cron.schedule('amaze-clock-jobs', '20 seconds', 'select private.finalize_timeouts(); select private.send_reminders();');

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.game_events;
