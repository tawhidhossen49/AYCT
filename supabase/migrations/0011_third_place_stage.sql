-- The third-place match: the two semifinal losers play for third, which
-- makes 64 games in all (48 group, 8 + 4 + 2 knockout, third place, final).
-- Its own migration because a new enum value can't be used in the
-- transaction that adds it.

alter type public.match_stage add value if not exists 'third';
