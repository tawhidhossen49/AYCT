// The whole active edition is small (32 players, 130 games and a few
// tiebreaks), so each page loads it once and keeps it live with Supabase
// Realtime.
//
// Knockout rounds are series: each bracket slot is a "tie" row (never
// played; its winner is whoever wins the series) and its games are rows
// with series_id pointing to it. store.ties holds the tie rows and
// store.matches every game that is actually played.

import { supabase, callFunction } from "./supabase.js";
import { PROFILE_COLUMNS } from "./auth.js";

export const store = {
  tournaments: [],
  tournament: null,
  profiles: [],
  groups: [],
  groupPlayers: [],
  matches: [],
  ties: [],
  profileById: new Map(),
  error: null,
};

export async function loadAll() {
  const [tRes, pRes] = await Promise.all([
    supabase.from("tournaments").select("*").order("year", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("profiles").select(PROFILE_COLUMNS).order("full_name"),
  ]);
  if (tRes.error || pRes.error) {
    store.error = (tRes.error ?? pRes.error).message;
    return;
  }
  store.tournaments = tRes.data;
  store.tournament = tRes.data.find((t) => t.is_active) ?? tRes.data[0] ?? null;
  store.profiles = pRes.data;
  store.profileById = new Map(pRes.data.map((p) => [p.id, p]));

  if (store.tournament) {
    const id = store.tournament.id;
    const [g, gp, m] = await Promise.all([
      supabase.from("groups").select("*").eq("tournament_id", id).order("label"),
      supabase.from("group_players").select("*").eq("tournament_id", id).order("seed"),
      supabase.from("matches").select("*").eq("tournament_id", id),
    ]);
    store.error = (g.error ?? gp.error ?? m.error)?.message ?? null;
    store.groups = g.data ?? [];
    store.groupPlayers = gp.data ?? [];
    store.matches = (m.data ?? []).filter((x) => !isTie(x));
    store.ties = (m.data ?? []).filter(isTie);
  } else {
    store.error = null;
    store.groups = [];
    store.groupPlayers = [];
    store.matches = [];
    store.ties = [];
  }
}

// Admins only: adds everyone's email to the loaded profiles.
export async function loadEmails() {
  let rows = null;
  try {
    rows = (await callFunction("admin-users", { action: "list" })).people;
  } catch {
    // Older deployments of the function have no "list"; read the column directly.
    const { data } = await supabase.from("profiles").select("id, email");
    rows = data;
  }
  const byId = new Map((rows ?? []).map((r) => [r.id, r.email]));
  store.profiles.forEach((p) => (p.email = byId.get(p.id) ?? ""));
}

// Applies a saved row straight away, without waiting for realtime.
export function upsertMatch(m) {
  const list = isTie(m) ? store.ties : store.matches;
  const i = list.findIndex((x) => x.id === m.id);
  if (i === -1) {
    if (m.tournament_id === store.tournament?.id) list.push(m);
  } else if (list[i].updated_at <= m.updated_at) {
    list[i] = m;
  }
}

// Calls onChange whenever something changes. Moves arrive many times a
// minute, so match rows are patched in place; rarer changes reload all.
// One live connection per page, shared by every listener.
const listeners = new Set();
let channel = null;
const notify = () => listeners.forEach((fn) => fn());

export function subscribe(onChange) {
  listeners.add(onChange);
  if (channel) return;

  let timer;
  const reloadSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await loadAll();
      notify();
    }, 300);
  };

  channel = supabase
    .channel("tournament-live")
    .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, (payload) => {
      if (payload.eventType === "DELETE") {
        store.matches = store.matches.filter((m) => m.id !== payload.old.id);
        store.ties = store.ties.filter((m) => m.id !== payload.old.id);
        notify();
        return;
      }
      upsertMatch(payload.new);
      // A finished game can decide a series, add a tiebreak game or move
      // players on in the bracket, so everything reloads.
      if ((payload.new.status === "completed" && payload.old?.status !== "completed") || isTie(payload.new)) reloadSoon();
      else notify();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "group_players" }, reloadSoon)
    .on("postgres_changes", { event: "*", schema: "public", table: "tournaments" }, reloadSoon)
    .subscribe();
}

// ---------------------------------------------------------------- match helpers

// A scheduled game whose start time has passed is effectively live: the
// server starts it on the first move or clock claim.
export function effectiveStatus(m, now) {
  if (m.status !== "scheduled") return m.status;
  if (m.scheduled_at && m.white_id && m.black_id && new Date(m.scheduled_at).getTime() <= now) return "live";
  return "scheduled";
}

export function sortByTime(a, b) {
  const ta = a.scheduled_at ? new Date(a.scheduled_at).getTime() : Infinity;
  const tb = b.scheduled_at ? new Date(b.scheduled_at).getTime() : Infinity;
  if (ta !== tb) return ta - tb;
  return (a.round ?? 0) - (b.round ?? 0) || (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0) || (a.game_no ?? 0) - (b.game_no ?? 0);
}

export const involves = (m, playerId) => m.white_id === playerId || m.black_id === playerId;

export const STAGE_LABEL = { group: "Group stage", r16: "Round of 16", qf: "Quarterfinal", sf: "Semifinal", third: "Third place", final: "Final", friendly: "Friendly" };

// 96 group games (a double round robin in six rounds), then two-game
// series in the round of 16 (16 games), quarterfinals (8), semifinals (4)
// and for third place (2), and the four-game final: 130, plus tiebreaks.
export const TOTAL_GAMES = 130;
export const GROUP_GAMES = 96;
export const GROUP_ROUNDS = 6;
export const KNOCKOUT_STAGES = ["r16", "qf", "sf", "third", "final"];
export const isKnockout = (m) => KNOCKOUT_STAGES.includes(m.stage);
export const isFriendly = (m) => m.stage === "friendly";
// A bracket slot (a series), as opposed to one of its games. Older
// editions settled a drawn knockout game with an Armageddon (tiebreak_of).
export const isTie = (m) => isKnockout(m) && !m.series_id && !m.tiebreak_of;

// Tiebreak and decider games settle a level series and friendlies are
// extra, so none of them count towards the 130.
export const isTiebreak = (m) => Boolean(m.tiebreak_of) || m.game_kind === "tiebreak" || m.game_kind === "decider";
export const bracketGames = (matches) => matches.filter((m) => !isTiebreak(m) && !isFriendly(m));

// The clocks for each stage: the edition's (tournaments.format), or the
// guidebook's.
export const DEFAULT_FORMAT = {
  group: { minutes: 5, increment: 0, games: 2 },
  r16: { minutes: 10, increment: 0, games: 2 },
  qf: { minutes: 10, increment: 5, games: 2 },
  sf: { minutes: 15, increment: 5, games: 2 },
  third: { minutes: 15, increment: 10, games: 2 },
  final: { minutes: 25, increment: 2, games: 4 },
  tiebreak: { minutes: 3, increment: 2 },
};
export function formatOf(stage, t = store.tournament) {
  return { ...DEFAULT_FORMAT[stage], ...(t?.format?.[stage] ?? {}) };
}
export const clockLabel = (f) => `${f.minutes}+${f.increment}`;

// A player's Selection Round rank, from where they sit in the groups:
// Group A holds ranks 1, 9, 17 and 25, Group B 2, 10, 18 and 26, and so on.
export const rankFor = (label, seed) => (seed - 1) * 8 + (label.charCodeAt(0) - 64);
export function rankOf(playerId) {
  const gp = store.groupPlayers.find((x) => x.player_id === playerId);
  const g = gp && store.groups.find((x) => x.id === gp.group_id);
  return g ? rankFor(g.label, gp.seed) : null;
}

// ---------------------------------------------------------------- series

const KIND_ORDER = { game: 0, tiebreak: 1, decider: 2 };
export const seriesGames = (tie) =>
  store.matches
    .filter((m) => m.series_id === tie.id)
    .sort((a, b) => KIND_ORDER[a.game_kind] - KIND_ORDER[b.game_kind] || (a.game_no ?? 0) - (b.game_no ?? 0));
export const tieOf = (m) => (m.series_id ? store.ties.find((t) => t.id === m.series_id) ?? null : null);

// One player's score in a game: 1, ½ or 0 (a double forfeit is 0 each).
export function scoreFor(m, playerId) {
  if (!m.result) return null;
  if (m.result === "1/2-1/2") return 0.5;
  if (m.result === "0-0") return 0;
  return (m.white_id === playerId) === (m.result === "1-0") ? 1 : 0;
}

// Where a series stands: its games, and each player's score from the main
// games (a is the tie's white_id, the better-ranked player; b the other).
export function seriesState(tie) {
  const games = seriesGames(tie);
  const main = games.filter((g) => g.game_kind === "game");
  const score = (id) => main.reduce((s, g) => s + (scoreFor(g, id) ?? 0), 0);
  return {
    games,
    main,
    tiebreak: games.find((g) => g.game_kind === "tiebreak") ?? null,
    decider: games.find((g) => g.game_kind === "decider") ?? null,
    a: score(tie.white_id),
    b: score(tie.black_id),
    played: main.filter((g) => g.status === "completed").length,
  };
}

export function matchContext(m) {
  if (m.stage === "group") {
    const g = store.groups.find((x) => x.id === m.group_id);
    return `Group ${g?.label ?? ""} · Round ${m.round}`;
  }
  if (m.tiebreak_of) return `${STAGE_LABEL[m.stage]} · Armageddon`;
  if (m.game_kind === "tiebreak") return `${STAGE_LABEL[m.stage]} · Tiebreak`;
  if (m.game_kind === "decider") return `${STAGE_LABEL[m.stage]} · Decider`;
  if (m.game_kind === "game") return `${STAGE_LABEL[m.stage]} · Game ${m.game_no}`;
  return STAGE_LABEL[m.stage];
}

// Starting clocks for a game: its own, or the edition's.
export function baseClocks(m) {
  const base = (store.tournament?.time_control_minutes ?? 10) * 60_000;
  return {
    white: m.white_base_ms ?? base,
    black: m.black_base_ms ?? base,
    increment: m.increment_ms ?? (store.tournament?.increment_seconds ?? 0) * 1000,
  };
}

export function timeControlLabel(m) {
  const c = baseClocks(m);
  const min = (ms) => `${Math.round(ms / 6000) / 10}`;
  const inc = Math.round(c.increment / 1000);
  return c.white === c.black ? `${min(c.white)}+${inc}` : `${min(c.white)}|${min(c.black)}+${inc}`;
}

// The first-move rule: White must move within 5 minutes of the start and
// Black within 5 minutes of White's first move; until both have moved no
// clock runs. Returns the deadline (ms) for the side to move, or null.
export const FIRST_MOVE_MS = 5 * 60_000;
export function firstMoveDeadline(m) {
  if (m.status === "completed" || m.paused_at || (m.move_count ?? 0) >= 2 || !m.scheduled_at) return null;
  const from = m.status === "live" && m.clock_started_at ? m.clock_started_at : m.scheduled_at;
  return new Date(from).getTime() + FIRST_MOVE_MS;
}
