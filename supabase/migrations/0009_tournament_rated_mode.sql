-- Rated or unrated tournament.
--
-- Once the groups are full, staff choose how the edition counts: a rated
-- tournament (every group and knockout game changes Elo ratings) or an
-- unrated one (results, tables, bracket and champion work the same, but
-- nobody's rating moves). NULL means the choice hasn't been made yet; games
-- are then rated, as before.
--
-- Friendly matches keep their own setting, and Armageddon tiebreaks are
-- always unrated.

alter table public.tournaments add column if not exists rated boolean;

-- New tournament games follow the edition's choice (group fixtures, the
-- bracket built by hand or automatically).
create or replace function public.matches_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.stage <> 'friendly' and new.tiebreak_of is null then
    new.rated := coalesce((select rated from public.tournaments where id = new.tournament_id), true);
  end if;
  return new;
end;
$$;

drop trigger if exists matches_before_insert on public.matches;
create trigger matches_before_insert
  before insert on public.matches
  for each row execute function public.matches_before_insert();

-- The choice, and every existing tournament game with it, in one step.
-- Finished games gain or lose their rating change (matches_before_update).
create or replace function public.set_tournament_rated(p_tournament uuid, p_rated boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_staff() then
    raise exception 'Only admins and moderators can change this';
  end if;
  update public.tournaments set rated = p_rated where id = p_tournament;
  update public.matches set rated = p_rated
  where tournament_id = p_tournament and stage <> 'friendly' and tiebreak_of is null and rated is distinct from p_rated;
end;
$$;

revoke execute on function public.matches_before_insert() from public, anon, authenticated;
revoke execute on function public.set_tournament_rated(uuid, boolean) from public, anon;
