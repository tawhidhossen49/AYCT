-- Public registration.
--
-- "Register now" on the landing page opens register.html, whose questions
-- come from the active edition's form (tournaments.registration, editable
-- in the Control Room). Applicants choose their own password: the
-- `register` edge function creates their sign-in straight away, but with no
-- profile, so they can't enter the portal until an admin accepts them. On
-- "Add", the admin only picks a role; name, email and school come from here.

alter table public.tournaments add column if not exists registration jsonb not null default '{
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
    {"key": "dob", "label": "Date of birth", "type": "date", "required": false},
    {"key": "rating", "label": "Chess rating, if you have one", "type": "number", "required": false}
  ]
}'::jsonb;

create table if not exists public.registrations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  full_name text not null,
  email text not null,
  school text,
  phone text,
  answers jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new', 'accepted', 'rejected')),
  role public.user_role,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles (id) on delete set null
);
create index if not exists registrations_tournament_idx on public.registrations (tournament_id, status, created_at desc);
create unique index if not exists registrations_email_idx on public.registrations (tournament_id, lower(email));
create index if not exists registrations_user_idx on public.registrations (user_id);
create index if not exists registrations_reviewer_idx on public.registrations (reviewed_by);

-- Applicants' details are for admins only (they manage accounts). Entries
-- are written by the `register` function and reviewed through admin-users.
alter table public.registrations enable row level security;
create policy "admins read registrations" on public.registrations
  for select to authenticated using ((select private.is_admin()));
create policy "admins update registrations" on public.registrations
  for update to authenticated using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "admins delete registrations" on public.registrations
  for delete to authenticated using ((select private.is_admin()));

alter publication supabase_realtime add table public.registrations;
