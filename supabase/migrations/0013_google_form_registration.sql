-- Registration moves to a Google Form. Each edition only keeps the form's
-- link; with no link the main page says "Registration coming soon".
-- The registrations table from 0010 is no longer used by the site.
alter table public.tournaments alter column registration set default '{"form_url": null}'::jsonb;

update public.tournaments
   set registration = '{"form_url": null}'::jsonb
 where registration is null or not (registration ? 'form_url');
