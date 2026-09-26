-- Move the role helpers out of the API-exposed schema. Policies keep
-- working (they reference the functions directly), but nobody can call
-- them over /rest/v1/rpc any more.
create schema if not exists private;
grant usage on schema private to authenticated;
alter function public.my_role() set schema private;
alter function public.is_member() set schema private;
alter function public.is_staff() set schema private;
alter function public.is_admin() set schema private;

create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() in ('admin', 'moderator'), false)
$$;
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(private.my_role() = 'admin', false)
$$;
