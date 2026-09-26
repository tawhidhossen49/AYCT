-- Amaze Youth Chess Tournament portal: schema, security and game rules.
--
-- Identity lives in auth.users. `profiles` says who someone is inside the
-- portal and what they may do. Every table is readable only by people who
-- have a profile (admins create those), and writable only by staff, except
-- moves, which go through the `game` edge function so they can be validated.

-- ---------------------------------------------------------------- types

create type public.user_role as enum ('admin', 'moderator', 'commentator', 'player');
create type public.tournament_status as enum ('setup', 'groups', 'knockout', 'complete');
create type public.match_stage as enum ('group', 'r16', 'qf', 'sf', 'final');
create type public.match_status as enum ('scheduled', 'live', 'completed');

-- ---------------------------------------------------------------- tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null,
  role public.user_role not null default 'player',
  rating int not null default 1000,
  school text,
  created_at timestamptz not null default now()
);

-- One row per annual edition.
create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  year int not null,
  status public.tournament_status not null default 'setup',
  is_active boolean not null default false,
  time_control_minutes int not null default 10 check (time_control_minutes between 1 and 180),
  increment_seconds int not null default 5 check (increment_seconds between 0 and 60),
  created_at timestamptz not null default now()
);
create unique index tournaments_one_active on public.tournaments (is_active) where is_active;

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  label text not null check (label ~ '^[A-H]$'),
  unique (tournament_id, label)
);

create table public.group_players (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  group_id uuid not null references public.groups (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  seed int not null check (seed between 1 and 4),
  unique (tournament_id, player_id),
  unique (group_id, seed)
);

-- Every fixture, group stage and knockout, plus the live game state.
create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  stage public.match_stage not null,
  group_id uuid references public.groups (id) on delete cascade,
  round int,                          -- group stage round 1..3
  bracket_slot int,                   -- position within a knockout stage, 1-based
  next_match_id uuid references public.matches (id) on delete set null,
  next_color text check (next_color in ('white', 'black')),
  white_id uuid references public.profiles (id) on delete set null,
  black_id uuid references public.profiles (id) on delete set null,
  scheduled_at timestamptz,
  status public.match_status not null default 'scheduled',
  result text check (result in ('1-0', '0-1', '1/2-1/2')),
  winner_id uuid references public.profiles (id) on delete set null,
  end_reason text,
  fen text not null default 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  pgn text not null default '',
  move_count int not null default 0,
  white_ms int,                       -- time left for white as of clock_started_at
  black_ms int,
  clock_started_at timestamptz,       -- when the side to move started thinking
  draw_offer_by uuid references public.profiles (id) on delete set null,
  started_at timestamptz,
  ended_at timestamptz,
  ratings_applied boolean not null default false,
  white_rating_delta int,
  black_rating_delta int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index matches_tournament_idx on public.matches (tournament_id, stage);
create index matches_white_idx on public.matches (white_id);
create index matches_black_idx on public.matches (black_id);
create index matches_group_idx on public.matches (group_id);
create index matches_next_idx on public.matches (next_match_id);
create index matches_winner_idx on public.matches (winner_id);
create index matches_draw_offer_idx on public.matches (draw_offer_by);

-- Live commentary shown beside a board.
create table public.match_comments (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  author_id uuid not null references public.profiles (id) on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index match_comments_match_idx on public.match_comments (match_id, created_at);
create index match_comments_author_idx on public.match_comments (author_id);
create index group_players_group_idx on public.group_players (group_id);
create index group_players_player_idx on public.group_players (player_id);

-- ---------------------------------------------------------------- role helpers
-- security definer so policies can read profiles without recursing into
-- the profiles policy itself.

create function public.my_role() returns public.user_role
language sql stable security definer set search_path = '' as $$
  select role from public.profiles where id = (select auth.uid())
$$;

create function public.is_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()))
$$;

create function public.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() in ('admin', 'moderator'), false)
$$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(public.my_role() = 'admin', false)
$$;

-- Clients use this to correct their clock against the server's.
create function public.server_now() returns timestamptz
language sql stable set search_path = '' as $$ select now() $$;

-- ---------------------------------------------------------------- row level security

alter table public.profiles enable row level security;
alter table public.tournaments enable row level security;
alter table public.groups enable row level security;
alter table public.group_players enable row level security;
alter table public.matches enable row level security;
alter table public.match_comments enable row level security;

-- profiles: members see everyone (names on fixtures); only admins edit.
-- Creating and deleting accounts happens in the admin-users edge function.
create policy "members read profiles" on public.profiles
  for select to authenticated using ((select public.is_member()));
create policy "admins update profiles" on public.profiles
  for update to authenticated using ((select public.is_admin())) with check ((select public.is_admin()));

-- tournaments: the name and year are public so the sign-in page can show them.
create policy "anyone reads tournaments" on public.tournaments
  for select to anon, authenticated using (true);
create policy "staff insert tournaments" on public.tournaments
  for insert to authenticated with check ((select public.is_staff()));
create policy "staff update tournaments" on public.tournaments
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "admins delete tournaments" on public.tournaments
  for delete to authenticated using ((select public.is_admin()));

create policy "members read groups" on public.groups
  for select to authenticated using ((select public.is_member()));
create policy "staff insert groups" on public.groups
  for insert to authenticated with check ((select public.is_staff()));
create policy "staff update groups" on public.groups
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "staff delete groups" on public.groups
  for delete to authenticated using ((select public.is_staff()));

create policy "members read group players" on public.group_players
  for select to authenticated using ((select public.is_member()));
create policy "staff insert group players" on public.group_players
  for insert to authenticated with check ((select public.is_staff()));
create policy "staff update group players" on public.group_players
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "staff delete group players" on public.group_players
  for delete to authenticated using ((select public.is_staff()));

create policy "members read matches" on public.matches
  for select to authenticated using ((select public.is_member()));
create policy "staff insert matches" on public.matches
  for insert to authenticated with check ((select public.is_staff()));
create policy "staff update matches" on public.matches
  for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
create policy "staff delete matches" on public.matches
  for delete to authenticated using ((select public.is_staff()));

create policy "members read comments" on public.match_comments
  for select to authenticated using ((select public.is_member()));
create policy "commentators write comments" on public.match_comments
  for insert to authenticated with check (
    author_id = (select auth.uid())
    and (select public.my_role()) in ('admin', 'moderator', 'commentator')
  );
create policy "authors and staff delete comments" on public.match_comments
  for delete to authenticated using (author_id = (select auth.uid()) or (select public.is_staff()));

-- ---------------------------------------------------------------- results, ratings, advancement

-- Before a match is saved: derive the winner from the result, and apply
-- Elo ratings exactly once when it first completes.
create function public.matches_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  w_rating int;
  b_rating int;
  expected_w numeric;
  score_w numeric;
  k constant int := 32;
begin
  new.updated_at := now();

  if new.result is distinct from old.result and new.result is not null then
    if new.result = '1-0' then
      new.winner_id := new.white_id;
    elsif new.result = '0-1' then
      new.winner_id := new.black_id;
    elsif new.stage = 'group' then
      new.winner_id := null;
    end if;
    -- a drawn knockout keeps whatever winner staff picked as the tiebreak
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

  if new.status = 'completed' and new.result is not null and not new.ratings_applied
     and new.white_id is not null and new.black_id is not null then
    select rating into w_rating from public.profiles where id = new.white_id;
    select rating into b_rating from public.profiles where id = new.black_id;
    expected_w := 1 / (1 + power(10::numeric, (b_rating - w_rating) / 400.0));
    score_w := case new.result when '1-0' then 1 when '0-1' then 0 else 0.5 end;
    new.white_rating_delta := round(k * (score_w - expected_w));
    new.black_rating_delta := -new.white_rating_delta;
    update public.profiles set rating = rating + new.white_rating_delta where id = new.white_id;
    update public.profiles set rating = rating + new.black_rating_delta where id = new.black_id;
    new.ratings_applied := true;
    new.ended_at := coalesce(new.ended_at, now());
  end if;

  return new;
end;
$$;

create trigger matches_before_update
  before update on public.matches
  for each row execute function public.matches_before_update();

-- After a knockout winner is known, place them in the next round, and close
-- the tournament once the final has a winner.
create function public.matches_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.winner_id is distinct from old.winner_id then
    if new.next_match_id is not null then
      if new.next_color = 'white' then
        update public.matches set white_id = new.winner_id where id = new.next_match_id and status <> 'completed';
      else
        update public.matches set black_id = new.winner_id where id = new.next_match_id and status <> 'completed';
      end if;
    end if;

    if new.stage = 'final' and new.winner_id is not null then
      update public.tournaments set status = 'complete' where id = new.tournament_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger matches_after_update
  after update on public.matches
  for each row execute function public.matches_after_update();

-- The trigger functions are internal; nobody calls them over the API.
revoke execute on function public.matches_before_update() from public, anon, authenticated;
revoke execute on function public.matches_after_update() from public, anon, authenticated;
revoke execute on function public.my_role() from public, anon;
revoke execute on function public.is_member() from public, anon;
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;

-- ---------------------------------------------------------------- realtime

alter publication supabase_realtime add table public.matches;
alter publication supabase_realtime add table public.match_comments;
alter publication supabase_realtime add table public.group_players;
alter publication supabase_realtime add table public.tournaments;
