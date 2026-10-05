-- Security hardening, from an attack test of the live project.
--
-- 1. Fair play: the two players can't read commentary on their own game
--    until it ends (the page already hid it; now the database does too).
-- 2. Updates feed: members may only mark their own updates as read, not
--    rewrite them, and every link must point inside the portal.
-- 3. The fair-play log can't be flooded: at most 20 entries a minute per
--    player (the game server and staff are not limited).

-- ---------------------------------------------------------------- 1. commentary

alter policy "members read comments" on public.match_comments
  using (
    (select private.is_member())
    and not exists (
      select 1 from public.matches m
      where m.id = match_comments.match_id
        and m.status <> 'completed'
        and (select auth.uid()) in (m.white_id, m.black_id)
    )
  );

-- ---------------------------------------------------------------- 2. updates feed

revoke update on public.notifications from anon, authenticated;
grant update (read_at) on public.notifications to authenticated;

-- "home.html", "play.html?id=...", "admin.html#team": never another site
-- and never a javascript: link.
alter table public.notifications
  add constraint notifications_link_internal
  check (link is null or link ~ '^[a-z]+\.html([?#][A-Za-z0-9=&#._~%-]*)?$') not valid;

-- ---------------------------------------------------------------- 3. fair-play log

create index if not exists game_events_user_time_idx on public.game_events (user_id, created_at desc);

create or replace function private.game_events_rate() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- The game server writes with the service key (no auth.uid()); staff are
  -- trusted. Players get 20 entries a minute, plenty for real tab switches.
  if (select auth.uid()) is not null and not private.is_staff() then
    if (select count(*) from public.game_events e
        where e.user_id = new.user_id and e.created_at > now() - interval '1 minute') >= 20 then
      raise exception 'Too many fair-play events, slow down' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function private.game_events_rate() from public, anon, authenticated;

create or replace trigger game_events_rate
  before insert on public.game_events
  for each row execute function private.game_events_rate();

-- ---------------------------------------------------------------- 4. internal helper

-- Only the bracket builder uses the group table function; the site doesn't
-- call it, so signed-in users don't need to.
revoke execute on function public.group_table(uuid) from public, anon, authenticated;
