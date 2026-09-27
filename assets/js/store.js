// The whole active edition is small (32 players, 63 games), so each page
// loads it once and keeps it live with Supabase Realtime.

import { supabase, callFunction } from "./supabase.js";
import { PROFILE_COLUMNS } from "./auth.js";

export const store = {
  tournaments: [],
  tournament: null,
  profiles: [],
  groups: [],
  groupPlayers: [],
  matches: [],
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
    store.matches = m.data ?? [];
  } else {
    store.error = null;
    store.groups = [];
    store.groupPlayers = [];
    store.matches = [];
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
  const i = store.matches.findIndex((x) => x.id === m.id);
  if (i === -1) {
    if (m.tournament_id === store.tournament?.id) store.matches.push(m);
  } else if (store.matches[i].updated_at <= m.updated_at) {
    store.matches[i] = m;
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
        notify();
        return;
      }
      upsertMatch(payload.new);
      // A finished game changes ratings, so names and ratings reload.
      if (payload.new.status === "completed" && payload.old?.status !== "completed") reloadSoon();
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
  return (a.bracket_slot ?? 0) - (b.bracket_slot ?? 0);
}

export const involves = (m, playerId) => m.white_id === playerId || m.black_id === playerId;

export const STAGE_LABEL = { group: "Group stage", r16: "Round of 16", qf: "Quarterfinal", sf: "Semifinal", final: "Final" };

export function matchContext(m) {
  if (m.stage === "group") {
    const g = store.groups.find((x) => x.id === m.group_id);
    return `Group ${g?.label ?? ""} · Round ${m.round}`;
  }
  return STAGE_LABEL[m.stage];
}
