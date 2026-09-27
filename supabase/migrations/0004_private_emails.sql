-- Sign-in emails are private. Members can still see names, roles, ratings
-- and schools (needed for fixtures and tables), but not each other's email.
-- Admins read emails through the admin-users edge function ("list").
--
-- Apply only after the site's code that selects explicit profile columns
-- is live (it is, from the bug-fix update onwards).

revoke select on public.profiles from anon, authenticated;
grant select (id, full_name, role, rating, school, created_at) on public.profiles to authenticated;
