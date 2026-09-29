-- Friendly matches: games outside the groups and the bracket, arranged by
-- staff (e.g. practice or exhibition games). Its own migration because a
-- new enum value can't be used in the transaction that adds it.

alter type public.match_stage add value if not exists 'friendly';
