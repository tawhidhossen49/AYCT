-- Test bots: throwaway player accounts that fill empty group slots so the
-- whole tournament can be rehearsed, then removed in one go (admin-users
-- function, actions "fill_bots" and "remove_bots").

alter table public.profiles add column if not exists is_bot boolean not null default false;
create index if not exists profiles_bots_idx on public.profiles (is_bot) where is_bot;

-- Members may see who is a bot (emails stay private, see 0004).
grant select (is_bot) on public.profiles to authenticated;
