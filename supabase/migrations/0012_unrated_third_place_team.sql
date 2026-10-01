-- Three changes to how the tournament runs.
--
-- 1. Third place: the semifinal losers play a third-place match, so the
--    event has 64 games.
-- 2. No ratings: every game is unrated. Nothing is added to a rating any
--    more, the rated / unrated tournament choice is gone, and the last
--    tiebreak in a group is the draw position instead of rating.
-- 3. Organising team: a shared task board and team chat for staff, and an
--    arbiter per game.

-- ---------------------------------------------------------------- every game is unrated

alter table public.matches alter column rated set default false;
update public.matches set rated = false where rated;

-- The rated / unrated tournament choice (0009) is switched off rather than
-- deleted: new games are always unrated, and the old switch can no longer
-- be called. tournaments.rated stays as an unused column.
create or replace function public.matches_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.rated := false;
  return new;
end;
$$;
revoke execute on function public.matches_before_insert() from public, anon, authenticated;
revoke execute on function public.set_tournament_rated(uuid, boolean) from public, anon, authenticated;

-- The registration form no longer asks for a rating.
alter table public.tournaments alter column registration set default '{
  "status": "soon",
  "closes_at": null,
  "intro": "Register for the tournament. The organisers review every entry and will let you know when your place is confirmed.",
  "fields": [
    {"key": "full_name", "label": "Full name", "type": "text", "required": true, "core": true},
    {"key": "email", "label": "Email", "type": "email", "required": true, "core": true},
    {"key": "password", "label": "Password", "type": "password", "required": true, "core": true},
    {"key": "school", "label": "School or college", "type": "text", "required": true, "builtin": true},
    {"key": "phone", "label": "Phone number", "type": "tel", "required": true, "builtin": true},
    {"key": "class", "label": "Class or year", "type": "text", "required": false},
    {"key": "dob", "label": "Date of birth", "type": "date", "required": false}
  ]
}'::jsonb;
update public.tournaments
set registration = jsonb_set(registration, '{fields}', coalesce((select jsonb_agg(f) from jsonb_array_elements(registration -> 'fields') f where f ->> 'key' <> 'rating'), '[]'::jsonb))
where registration -> 'fields' @> '[{"key": "rating"}]';

-- Group tables: points, Sonneborn-Berger, wins, the mini-league between the
-- players still level, then the draw position.
create or replace function public.group_table(p_group uuid)
returns table (player_id uuid, played int, wins int, draws int, losses int, points numeric, sb numeric, rating int, rank int)
language sql stable security definer set search_path = '' as $$
  with members as (
    select gp.player_id, gp.seed from public.group_players gp where gp.group_id = p_group
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

-- ---------------------------------------------------------------- third place and the bracket

create or replace function private.stage_name(p_stage public.match_stage, p_tiebreak boolean)
returns text language sql immutable set search_path = '' as $$
  select case p_stage when 'group' then 'Group stage' when 'r16' then 'Round of 16' when 'qf' then 'Quarterfinal'
                      when 'sf' then 'Semifinal' when 'third' then 'Third-place match' when 'final' then 'Final' else 'Friendly match' end
         || case when p_tiebreak then ' Armageddon' else '' end
$$;

-- The third-place game belongs to its final: it is created with the final
-- and removed with it, so the bracket builder needs no changes.
alter table public.matches add column if not exists companion_of uuid references public.matches (id) on delete cascade;
create index if not exists matches_companion_idx on public.matches (companion_of);

create or replace function public.matches_after_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.stage = 'final' and new.tiebreak_of is null then
    insert into public.matches (tournament_id, stage, bracket_slot, companion_of)
    values (new.tournament_id, 'third', 1, new.id);
  end if;
  return new;
end;
$$;

create or replace trigger matches_after_insert
  after insert on public.matches
  for each row execute function public.matches_after_insert();

create or replace function public.matches_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
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
    elsif new.stage not in ('r16', 'qf', 'sf', 'third', 'final') then
      new.winner_id := null;
    end if;
    -- a drawn knockout game keeps whatever winner staff picked, or waits for its tiebreak
  end if;

  if new.result is null and old.result is not null then
    new.winner_id := null;
  end if;

  -- A game still carrying a rating change from when games were rated has it undone.
  if old.ratings_applied then
    update public.profiles set rating = rating - coalesce(old.white_rating_delta, 0) where id = old.white_id;
    update public.profiles set rating = rating - coalesce(old.black_rating_delta, 0) where id = old.black_id;
    new.ratings_applied := false;
    new.white_rating_delta := null;
    new.black_rating_delta := null;
  end if;

  -- Every game is unrated: nothing is ever added to a rating. (The block
  -- above still undoes changes made by games that were rated in the past.)

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
  if new.white_id is distinct from old.white_id and new.white_id is not null and new.stage in ('r16', 'qf', 'sf', 'third', 'final') then
    perform private.notify(new.white_id, 'advanced', case when new.stage = 'third' then 'You play for third place' else 'Through to the ' || label end, 'You play White.', link);
  end if;
  if new.black_id is distinct from old.black_id and new.black_id is not null and new.stage in ('r16', 'qf', 'sf', 'third', 'final') then
    perform private.notify(new.black_id, 'advanced', case when new.stage = 'third' then 'You play for third place' else 'Through to the ' || label end, 'You play Black.', link);
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    res := case new.result when '1-0' then 'White won' when '0-1' then 'Black won' else 'Drawn' end
           || coalesce(' by ' || new.end_reason, '');
    perform private.notify(new.white_id, 'result', label || ': ' || replace(coalesce(new.result, ''), '1/2-1/2', '½-½'), res || '.', link);
    perform private.notify(new.black_id, 'result', label || ': ' || replace(coalesce(new.result, ''), '1/2-1/2', '½-½'), res || '.', link);

    -- A drawn knockout game with no winner: Armageddon, colours reversed.
    if new.stage in ('r16', 'qf', 'sf', 'third', 'final') and new.result = '1/2-1/2' and new.winner_id is null and new.tiebreak_of is null
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
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage in ('r16', 'qf', 'sf', 'third', 'final')) then
      perform private.build_knockout(new.tournament_id);
    end if;
  end if;

  return new;
end;
$$;

-- Knockout winners move on; semifinal losers meet for third place; the
-- final's winner completes the tournament.
create or replace function public.matches_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  loser uuid;
begin
  if new.winner_id is distinct from old.winner_id then
    if new.next_match_id is not null then
      if new.next_color = 'white' then
        update public.matches set white_id = new.winner_id where id = new.next_match_id and status <> 'completed';
      else
        update public.matches set black_id = new.winner_id where id = new.next_match_id and status <> 'completed';
      end if;
    end if;

    if new.stage = 'sf' and new.tiebreak_of is null then
      loser := case when new.winner_id is null then null
                    when new.winner_id = new.white_id then new.black_id else new.white_id end;
      if new.bracket_slot = 1 then
        update public.matches set white_id = loser
        where tournament_id = new.tournament_id and stage = 'third' and tiebreak_of is null and status <> 'completed';
      else
        update public.matches set black_id = loser
        where tournament_id = new.tournament_id and stage = 'third' and tiebreak_of is null and status <> 'completed';
      end if;
    end if;

    if new.stage = 'final' and new.winner_id is not null then
      update public.tournaments set status = 'complete' where id = new.tournament_id;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function private.stage_name(public.match_stage, boolean) from public, anon, authenticated;
revoke execute on function public.matches_after_insert() from public, anon, authenticated;
revoke execute on function public.matches_before_update() from public, anon, authenticated;
revoke execute on function public.matches_automation() from public, anon, authenticated;
revoke execute on function public.matches_after_update() from public, anon, authenticated;

-- ---------------------------------------------------------------- organising team

-- Who is arbitrating a game.
alter table public.matches add column if not exists arbiter_id uuid references public.profiles (id) on delete set null;
create index if not exists matches_arbiter_idx on public.matches (arbiter_id);

-- The team's shared to-do board.
create table if not exists public.team_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 200),
  notes text check (notes is null or char_length(notes) <= 2000),
  status text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  assignee_id uuid references public.profiles (id) on delete set null,
  due_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_tasks_assignee_idx on public.team_tasks (assignee_id);
create index if not exists team_tasks_creator_idx on public.team_tasks (created_by);

-- The team's private chat and pinned notes.
create table if not exists public.team_messages (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000),
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists team_messages_author_idx on public.team_messages (author_id);
create index if not exists team_messages_time_idx on public.team_messages (created_at desc);

-- Admins and moderators only.
alter table public.team_tasks enable row level security;
alter table public.team_messages enable row level security;
create policy "staff read tasks" on public.team_tasks for select to authenticated using ((select private.is_staff()));
create policy "staff add tasks" on public.team_tasks for insert to authenticated with check ((select private.is_staff()));
create policy "staff change tasks" on public.team_tasks for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy "staff remove tasks" on public.team_tasks for delete to authenticated using ((select private.is_staff()));
create policy "staff read team chat" on public.team_messages for select to authenticated using ((select private.is_staff()));
create policy "staff write team chat" on public.team_messages for insert to authenticated with check ((select private.is_staff()) and author_id = (select auth.uid()));
create policy "staff pin team chat" on public.team_messages for update to authenticated using ((select private.is_staff())) with check ((select private.is_staff()));
create policy "authors and admins remove team chat" on public.team_messages for delete to authenticated using (author_id = (select auth.uid()) or (select private.is_admin()));

alter publication supabase_realtime add table public.team_tasks;
alter publication supabase_realtime add table public.team_messages;
