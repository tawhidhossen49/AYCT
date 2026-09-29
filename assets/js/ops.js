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

// Rated or unrated tournament: the edition and all its group and bracket
// games at once. Finished games gain or lose their rating change.
export async function setTournamentRated(tournamentId, rated) {
  check(await supabase.rpc("set_tournament_rated", { p_tournament: tournamentId, p_rated: rated }));
}

// A friendly match outside the groups and the bracket, with its own clock.
// It's created first and then given its start time, so both players get
// the "game scheduled" update the database sends.
export async function createFriendly({ tournamentId, whiteId, blackId, when, minutes, increment, rated }) {
  const base = Math.round(minutes * 60_000);
  const m = check(
    await supabase
      .from("matches")
      .insert({
        tournament_id: tournamentId,
        stage: "friendly",
        white_id: whiteId,
        black_id: blackId,
        white_base_ms: base,
        black_base_ms: base,
        increment_ms: Math.round(increment * 1000),
        rated,
      })
      .select("*")
      .single(),
  );
  return updateMatch(m.id, { scheduled_at: when });
}

// Deleting a finished game undoes its rating change (migration 0003).
export async function deleteMatch(id) {
  check(await supabase.from("matches").delete().eq("id", id));
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

// ---------------------------------------------------------------- test bots

const hasBot = (m, profileById) => profileById.get(m.white_id)?.is_bot || profileById.get(m.black_id)?.is_bot;

// Gives every unfinished game with a bot in it (and, if asked, games
// between real players) a result, the way ratings predict. The database
// then does what it would after real games: standings, Armageddon
// tiebreaks, the bracket and advancement. Runs again for each new round
// until nothing is left to play.
export async function simulateGames(tournamentId, profileById, { includeReal = false } = {}) {
  let played = 0;
  for (let pass = 0; pass < 12; pass++) {
    const games = check(await supabase.from("matches").select("*").eq("tournament_id", tournamentId).neq("status", "completed"));
    const todo = games.filter((m) => m.white_id && m.black_id && (includeReal || hasBot(m, profileById)));
    if (!todo.length) break;
    for (const m of todo) {
      const w = profileById.get(m.white_id)?.rating ?? 1000;
      const b = profileById.get(m.black_id)?.rating ?? 1000;
      const expected = 1 / (1 + 10 ** ((b - w) / 400));
      const drawChance = m.stage === "group" ? 0.2 : m.tiebreak_of ? 0.1 : 0.15;
      const r = Math.random();
      const result = r < drawChance ? "1/2-1/2" : Math.random() < expected ? "1-0" : "0-1";
      const when = m.scheduled_at ?? new Date().toISOString();
      await updateMatch(m.id, { scheduled_at: when, started_at: when, status: "completed", result, end_reason: "test simulation" });
      played += 1;
    }
    // Give the database a moment to build the next round.
    await new Promise((r) => setTimeout(r, 600));
  }
  return played;
}

// Before bots leave: games between real players that were played during
// testing go back to the start, which also undoes their rating changes.
export async function resetRealTestGames(tournamentId, profileById, { allRealGames = false } = {}) {
  const games = check(await supabase.from("matches").select("*").eq("tournament_id", tournamentId).eq("stage", "group"));
  const real = games.filter((m) => !hasBot(m, profileById) && (m.status !== "scheduled" || m.move_count > 0));
  const targets = allRealGames ? real : real.filter((m) => m.end_reason === "test simulation");
  for (const m of targets) await resetGame(m.id);
  return targets.length;
}

// A message from the arbiter to one or more people's updates feed.
export async function sendMessage(userIds, title, body, link = null) {
  const rows = userIds.map((user_id) => ({ user_id, kind: "message", title, body, link }));
  if (rows.length) check(await supabase.from("notifications").insert(rows));
}
