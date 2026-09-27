// Staff actions: setting up an edition, drawing groups, generating fixtures
// and the knockout bracket. Row level security lets only admins and
// moderators run these writes.

import { supabase, check } from "./supabase.js";
import { groupStandings } from "./standings.js";

export const GROUP_LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export async function createTournament(input) {
  // The new edition becomes the one everyone sees.
  check(await supabase.from("tournaments").update({ is_active: false }).eq("is_active", true));
  const t = check(await supabase.from("tournaments").insert({ ...input, is_active: true }).select("*").single());
  check(await supabase.from("groups").insert(GROUP_LABELS.map((label) => ({ tournament_id: t.id, label }))));
  return t;
}

export async function setActiveTournament(id) {
  check(await supabase.from("tournaments").update({ is_active: false }).eq("is_active", true));
  check(await supabase.from("tournaments").update({ is_active: true }).eq("id", id));
}

export async function updateTournament(id, patch) {
  check(await supabase.from("tournaments").update(patch).eq("id", id));
}

// ---------------------------------------------------------------- groups

export async function setGroupSlot(tournamentId, groupId, seed, playerId) {
  check(await supabase.from("group_players").delete().eq("group_id", groupId).eq("seed", seed));
  if (playerId) {
    // A player can only sit in one group.
    check(await supabase.from("group_players").delete().eq("tournament_id", tournamentId).eq("player_id", playerId));
    check(await supabase.from("group_players").insert({ tournament_id: tournamentId, group_id: groupId, player_id: playerId, seed }));
  }
}

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// World Cup style: rank by rating into four pots of eight, then each group
// gets one player from every pot, so the strongest are spread out.
export async function seededDraw(tournamentId, groups, players) {
  if (players.length !== 32) throw new Error(`Pick exactly 32 players (you picked ${players.length}).`);
  if (groups.length !== 8) throw new Error("This edition needs its 8 groups first.");
  const ranked = players.slice().sort((a, b) => b.rating - a.rating);
  const ordered = groups.slice().sort((a, b) => a.label.localeCompare(b.label));
  const rows = [];
  for (let pot = 0; pot < 4; pot++) {
    shuffle(ranked.slice(pot * 8, pot * 8 + 8)).forEach((p, i) =>
      rows.push({ tournament_id: tournamentId, group_id: ordered[i].id, player_id: p.id, seed: pot + 1 }),
    );
  }
  check(await supabase.from("group_players").delete().eq("tournament_id", tournamentId));
  check(await supabase.from("group_players").insert(rows));
}

export async function clearGroups(tournamentId) {
  check(await supabase.from("group_players").delete().eq("tournament_id", tournamentId));
}

// ---------------------------------------------------------------- fixtures

// Round robin for four seeds. Everyone gets white at least once.
const GROUP_ROUNDS = [
  [[1, 4], [2, 3]],
  [[4, 3], [1, 2]],
  [[2, 4], [3, 1]],
];

export async function generateGroupFixtures(tournamentId, groups, groupPlayers) {
  const rows = [];
  for (const g of groups) {
    const bySeed = new Map(groupPlayers.filter((gp) => gp.group_id === g.id).map((gp) => [gp.seed, gp.player_id]));
    if (bySeed.size !== 4) throw new Error(`Group ${g.label} needs 4 players before fixtures can be made.`);
    GROUP_ROUNDS.forEach((pairs, r) =>
      pairs.forEach(([w, b]) =>
        rows.push({ tournament_id: tournamentId, stage: "group", group_id: g.id, round: r + 1, white_id: bySeed.get(w), black_id: bySeed.get(b) }),
      ),
    );
  }
  check(await supabase.from("matches").delete().eq("tournament_id", tournamentId).eq("stage", "group"));
  check(await supabase.from("matches").insert(rows));
  check(await supabase.from("tournaments").update({ status: "groups" }).eq("id", tournamentId));
}

// Sets the start time for every game in a round that hasn't started.
export async function scheduleRound(matches, when) {
  const ids = matches.filter((m) => m.status === "scheduled").map((m) => m.id);
  if (ids.length) check(await supabase.from("matches").update({ scheduled_at: when }).in("id", ids));
}

export async function updateMatch(id, patch) {
  return check(await supabase.from("matches").update(patch).eq("id", id).select("*").single());
}

// Puts a game back to its starting position. The database reverses any
// rating change the game had caused.
export async function resetGame(id) {
  // An Armageddon game made for this one no longer applies.
  check(await supabase.from("matches").delete().eq("tiebreak_of", id));
  return updateMatch(id, {
    status: "scheduled",
    result: null,
    winner_id: null,
    end_reason: null,
    fen: START_FEN,
    pgn: "",
    move_count: 0,
    white_ms: null,
    black_ms: null,
    clock_started_at: null,
    draw_offer_by: null,
    started_at: null,
    ended_at: null,
    paused_at: null,
    clocks: [],
  });
}

// ---------------------------------------------------------------- knockout

// Group winners meet runners-up from the neighbouring group, like the
// World Cup, so two players from one group can only meet again in the final.
export const R16_PAIRINGS = [
  ["A", 1, "B", 2],
  ["C", 1, "D", 2],
  ["E", 1, "F", 2],
  ["G", 1, "H", 2],
  ["B", 1, "A", 2],
  ["D", 1, "C", 2],
  ["F", 1, "E", 2],
  ["H", 1, "G", 2],
];

export function qualifiers(groups, groupPlayers, matches, profileById) {
  const out = new Map();
  for (const g of groups) {
    const table = groupStandings(g.id, groupPlayers, matches, profileById);
    out.set(g.label, [table[0]?.playerId ?? null, table[1]?.playerId ?? null]);
  }
  return out;
}

// The database builds the bracket from its own standings, the same way it
// does automatically when the last group game ends.
export async function generateKnockout(tournamentId) {
  check(await supabase.rpc("generate_knockout", { p_tournament: tournamentId }));
}

// A message from the arbiter to one or more people's updates feed.
export async function sendMessage(userIds, title, body, link = null) {
  const rows = userIds.map((user_id) => ({ user_id, kind: "message", title, body, link }));
  if (rows.length) check(await supabase.from("notifications").insert(rows));
}
