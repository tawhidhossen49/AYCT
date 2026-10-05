-- A request counter the game server shares across all its instances: one
-- row per person and kind of request, reset when its window has passed.
create table if not exists private.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  hits int not null default 1
);
alter table private.rate_limits enable row level security;

-- Counts one request; true means this person is over the limit.
create or replace function public.rate_hit(p_key text, p_window_seconds int, p_max int) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  n int;
begin
  insert into private.rate_limits as r (key, window_start, hits) values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning r.hits into n;
  return n > p_max;
end;
$$;
revoke execute on function public.rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_hit(text, int, int) to service_role;
