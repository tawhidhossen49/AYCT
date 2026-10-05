-- From hosting a whole test tournament end to end:
--
-- 1. Result updates read properly ("White won on time.", "Black won
--    (arbiter: ...)", "(result entered by the organisers)") instead of
--    always "won by <reason>".
-- 2. "Starts in 1 minute", not "1 minutes".
-- 3. Players are told when the organisers correct a finished result.
-- 4. A game the server ends on time gets its "Game over" line in the
--    fair-play log, like games ended in the Arena.

create or replace function private.result_text(p_result text, p_reason text, p_draw_odds boolean)
returns text language sql immutable set search_path = '' as $$
  select case p_result when '1-0' then 'White won' when '0-1' then 'Black won' else 'Drawn' end
    || case
         when p_reason is null then ''
         when p_reason = 'timeout' then ' on time'
         when p_reason = 'timeout vs insufficient material' then ' (out of time, but the opponent can''t mate)'
         when p_reason in ('checkmate', 'stalemate', 'insufficient material', 'threefold repetition', 'resignation', 'agreement') then ' by ' || p_reason
         when p_reason = 'fifty-move rule' then ' by the fifty-move rule'
         when p_reason = 'result recorded by staff' then ' (result entered by the organisers)'
         when p_reason = 'test simulation' then ' (test simulation)'
         when p_reason = 'arbiter decision' then ' by arbiter''s decision'
         else ' (arbiter: ' || p_reason || ')'
       end
    || '.'
    || case when p_result = '1/2-1/2' and coalesce(p_draw_odds, false) then ' Black goes through on draw odds.' else '' end
$$;
revoke execute on function private.result_text(text, text, boolean) from public, anon, authenticated;

create or replace function public.matches_automation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  t record;
  link text := 'play.html?id=' || new.id;
  label text := private.stage_name(new.stage, new.tiebreak_of is not null);
  score text := replace(coalesce(new.result, ''), '1/2-1/2', '½-½');
  wait text;
  tb_id uuid;
begin
  select * into t from public.tournaments where id = new.tournament_id;

  -- Scheduled or moved: both players hear about it.
  if new.scheduled_at is distinct from old.scheduled_at and new.scheduled_at is not null and new.status = 'scheduled' then
    perform private.notify(new.white_id, 'scheduled', label || ': game scheduled',
      'You play White against ' || private.player_name(new.black_id) || '.', link);
    perform private.notify(new.black_id, 'scheduled', label || ': game scheduled',
      'You play Black against ' || private.player_name(new.white_id) || '.', link);
  end if;

  -- A player placed into a later round (bracket advancement).
  if new.white_id is distinct from old.white_id and new.white_id is not null and new.stage in ('r16', 'qf', 'sf', 'third', 'final') then
    perform private.notify(new.white_id, 'advanced', case when new.stage = 'third' then 'You play for third place' else 'Through to the ' || label end, 'You play White.', link);
  end if;
  if new.black_id is distinct from old.black_id and new.black_id is not null and new.stage in ('r16', 'qf', 'sf', 'third', 'final') then
    perform private.notify(new.black_id, 'advanced', case when new.stage = 'third' then 'You play for third place' else 'Through to the ' || label end, 'You play Black.', link);
  end if;

  -- The organisers changed a result that had already been announced.
  if new.status = 'completed' and old.status = 'completed' and new.result is not null and new.result is distinct from old.result then
    perform private.notify(new.white_id, 'result', label || ': result corrected to ' || score,
      private.result_text(new.result, new.end_reason, new.draw_odds), link);
    perform private.notify(new.black_id, 'result', label || ': result corrected to ' || score,
      private.result_text(new.result, new.end_reason, new.draw_odds), link);
  end if;

  if new.status = 'completed' and old.status <> 'completed' then
    perform private.notify(new.white_id, 'result', label || ': ' || score, private.result_text(new.result, new.end_reason, new.draw_odds), link);
    perform private.notify(new.black_id, 'result', label || ': ' || score, private.result_text(new.result, new.end_reason, new.draw_odds), link);

    -- A drawn knockout game with no winner: Armageddon, colours reversed.
    if new.stage in ('r16', 'qf', 'sf', 'third', 'final') and new.result = '1/2-1/2' and new.winner_id is null and new.tiebreak_of is null
       and t.auto_tiebreak and not exists (select 1 from public.matches where tiebreak_of = new.id) then
      insert into public.matches (tournament_id, stage, tiebreak_of, white_id, black_id, scheduled_at,
                                  white_base_ms, black_base_ms, increment_ms, draw_odds, rated)
      values (new.tournament_id, new.stage, new.id, new.black_id, new.white_id,
              now() + make_interval(mins => t.tiebreak_delay_minutes), 300000, 240000, 2000, true, false)
      returning id into tb_id;
      wait := case when t.tiebreak_delay_minutes = 1 then '1 minute' else t.tiebreak_delay_minutes || ' minutes' end;
      perform private.notify(new.black_id, 'tiebreak', label || ': Armageddon tiebreak',
        'You have White (5 min) and must win. Starts in ' || wait || '.', 'play.html?id=' || tb_id);
      perform private.notify(new.white_id, 'tiebreak', label || ': Armageddon tiebreak',
        'You have Black (4 min); a draw is enough. Starts in ' || wait || '.', 'play.html?id=' || tb_id);
    end if;

    -- A finished tiebreak decides its game: the winner moves on from there.
    if new.tiebreak_of is not null and new.winner_id is not null then
      update public.matches set winner_id = new.winner_id where id = new.tiebreak_of;
    end if;

    -- Last group game done: build the bracket.
    if new.stage = 'group' and t.auto_knockout and t.status = 'groups'
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage = 'group' and status <> 'completed')
       and not exists (select 1 from public.matches where tournament_id = new.tournament_id and stage in ('r16', 'qf', 'sf', 'third', 'final')) then
      perform private.build_knockout(new.tournament_id);
    end if;
  end if;

  return new;
end;
$$;
revoke execute on function public.matches_automation() from public, anon, authenticated;

-- Ends every game whose side to move has run out of time, even if nobody
-- has the game open (no-shows included).
create or replace function private.finalize_timeouts()
returns void language plpgsql security definer set search_path = '' as $$
declare
  r record;
  turn text;
  left_ms numeric;
  opp text;
  cannot_mate boolean;
  res text;
  why text;
begin
  for r in
    select m.*, t.time_control_minutes
    from public.matches m join public.tournaments t on t.id = m.tournament_id
    where m.paused_at is null and m.white_id is not null and m.black_id is not null
      and m.scheduled_at <= now()
      and (m.status = 'live' or (m.status = 'scheduled' and m.move_count = 0))
  loop
    if r.status = 'scheduled' then
      turn := 'w';
      left_ms := coalesce(r.white_base_ms, r.time_control_minutes * 60000) - extract(epoch from now() - r.scheduled_at) * 1000;
    else
      turn := coalesce(nullif(split_part(r.fen, ' ', 2), ''), 'w');
      left_ms := (case when turn = 'w' then r.white_ms else r.black_ms end) - extract(epoch from now() - r.clock_started_at) * 1000;
    end if;
    continue when left_ms is null or left_ms > -1500;

    opp := case when turn = 'w' then regexp_replace(split_part(r.fen, ' ', 1), '[^pnbrq]', '', 'g')
                else regexp_replace(split_part(r.fen, ' ', 1), '[^PNBRQ]', '', 'g') end;
    cannot_mate := length(opp) = 0 or lower(opp) in ('n', 'b');
    res := case when cannot_mate then '1/2-1/2' when turn = 'w' then '0-1' else '1-0' end;
    why := case when cannot_mate then 'timeout vs insufficient material' else 'timeout' end;

    update public.matches set
      status = 'completed',
      result = res,
      end_reason = why,
      started_at = coalesce(started_at, scheduled_at),
      white_ms = case when turn = 'w' then 0 else coalesce(white_ms, white_base_ms, r.time_control_minutes * 60000) end,
      black_ms = case when turn = 'b' then 0 else coalesce(black_ms, black_base_ms, r.time_control_minutes * 60000) end,
      draw_offer_by = null,
      ended_at = now()
    where id = r.id and move_count = r.move_count and status = r.status;

    if found then
      insert into public.game_events (match_id, user_id, kind, detail)
      values (r.id, null, 'game_over', jsonb_build_object('result', res, 'reason', why));
    end if;
  end loop;
end;
$$;
revoke execute on function private.finalize_timeouts() from public, anon, authenticated;
