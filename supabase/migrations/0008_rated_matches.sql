-- Rated and unrated games.
--
-- Every game now says whether it is rated. Only rated games change Elo
-- ratings, so the leaderboard (ranked by rating) reflects rated games only.
-- Tournament games are rated by default; staff can mark any game unrated,
-- and can arrange friendly matches (stage 'friendly', unrated by default)
-- outside the groups and the bracket. Armageddon tiebreaks stay unrated.
--
-- Knockout checks now name the knockout stages instead of "not group", so
-- friendly matches are never mistaken for bracket games.

alter table public.matches add column if not exists rated boolean not null default true;
update public.matches set rated = false where tiebreak_of is not null;

create or replace function private.stage_name(p_stage public.match_stage, p_tiebreak boolean)
returns text language sql immutable set search_path = '' as $$
  select case p_stage when 'group' then 'Group stage' when 'r16' then 'Round of 16' when 'qf' then 'Quarterfinal'
                      when 'sf' then 'Semifinal' when 'final' then 'Final' else 'Friendly match' end
         || case when p_tiebreak then ' Armageddon' else '' end
$$;

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

  delete from public.matches where tournament_id = p_tournament and stage in ('r16', 'qf', 'sf', 'final');

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
    elsif new.stage not in ('r16', 'qf', 'sf', 'final') then
      new.winner_id := null;
    end if;
    -- a drawn knockout game keeps whatever winner staff picked, or waits for its tiebreak
  end if;

  if new.result is null and old.result is not null then
    new.winner_id := null;
  end if;

  -- A reset or corrected result undoes the rating change it caused.
  if old.ratings_applied and (new.status <> 'completed' or new.result is distinct from old.result or not new.rated) then
    update public.profiles set rating = rating - coalesce(old.white_rating_delta, 0) where id = old.white_id;
    update public.profiles set rating = rating - coalesce(old.black_rating_delta, 0) where id = old.black_id;
    new.ratings_applied := false;
    new.white_rating_delta := null;
    new.black_rating_delta := null;
  end if;

  -- Rated games only. Unrated games (and Armageddon tiebreaks, which are
  -- faster games) never change anyone's rating.
  if new.status = 'completed' and new.result is not null and not new.ratings_applied
     and new.rated and new.tiebreak_of is null and new.white_id is not null and new.black_id is not null then
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

create or replace function public.matches_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  link text := 'play.html?id=' || new.id;
  label text := private.stage_name(new.stage, new.tiebreak_of is not null)
                || case when new.stage = 'friendly' then case when new.rated then ' (rated)' else ' (unrated)' end else '' end;
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
  if new.white_id is distinct from old.white_id and new.white_id is not null and new.stage in ('r16', 'qf', 'sf', 'final') then
    perform private.notify(new.white_id, 'advanced', 'Through to the ' || label, 'You play White in the next round.', link);
  end if;
  if new.black_id is distinct from old.black_id and new.black_id is not null and new.stage in ('r16', 'qf', 'sf', 'final') then
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
    if new.stage in ('r16', 'qf', 'sf', 'final') and new.result = '1/2-1/2' and new.winner_id is null and new.tiebreak_of is null
       and t.auto_tiebreak and not exists (select 1 from public.matches where tiebreak_of = new.id) then
      insert into public.matches (tournament_id, stage, tiebreak_of, white_id, black_id, scheduled_at,
                                  white_base_ms, black_base_ms, increment_ms, draw_odds, rated)
      values (new.tournament_id, new.stage, new.id, new.black_id, new.white_id,
              now() + make_interval(mins => t.tiebreak_delay_minutes), 300000, 240000, 2000, true, false)
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
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage in ('r16', 'qf', 'sf', 'final')) then
      perform private.build_knockout(new.tournament_id);
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function private.stage_name(public.match_stage, boolean) from public, anon, authenticated;
revoke execute on function private.build_knockout(uuid) from public, anon, authenticated;
revoke execute on function public.matches_before_update() from public, anon, authenticated;
revoke execute on function public.matches_automation() from public, anon, authenticated;
