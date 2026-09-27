-- Deleting a finished game must undo the rating change it caused.
--
-- Without this, "Generate again" on the group fixtures or the knockout
-- bracket deleted played games but left their Elo changes in place, so
-- ratings drifted further from the truth every time.

create or replace function public.matches_before_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.ratings_applied then
    update public.profiles set rating = rating - coalesce(old.white_rating_delta, 0) where id = old.white_id;
    update public.profiles set rating = rating - coalesce(old.black_rating_delta, 0) where id = old.black_id;
  end if;
  return old;
end;
$$;

drop trigger if exists matches_before_delete on public.matches;
create trigger matches_before_delete
  before delete on public.matches
  for each row execute function public.matches_before_delete();

revoke execute on function public.matches_before_delete() from public, anon, authenticated;
