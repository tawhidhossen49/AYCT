// Staff actions: setting up an edition, drawing groups, generating fixtures
// and the knockout bracket. Row level security lets only admins and
// moderators run these writes.

import { supabase, check } from "./supabase.js";
import { groupStandings } from "./standings.js";
import { formatOf, isTie } from "./store.js";

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

// The groups come from the Selection Round: the 32 qualifiers, in rank
// order, are dealt across the eight groups. Group A gets ranks 1, 9, 17
// and 25, Group B 2, 10, 18 and 26, ... Group H 8, 16, 24 and 32. The seat
// (1 to 4) is the player's place in that order, so seat 1 is the group's
// best-ranked player.
export async function placeByRank(tournamentId, groups, ranked) {
  if (ranked.length !== 32) throw new Error(`Rank exactly 32 players (you have ${ranked.length}).`);
  if (new Set(ranked.map((p) => p.id)).size !== 32) throw new Error("A player appears twice in the ranking.");
  if (groups.length !== 8) throw new Error("This edition needs its 8 groups first.");
  const ordered = groups.slice().sort((a, b) => a.label.localeCompare(b.label));
  const rows = ranked.map((p, i) => ({ tournament_id: tournamentId, group_id: ordered[i % 8].id, player_id: p.id, seed: Math.floor(i / 8) + 1 }));
  check(await supabase.from("group_players").delete().eq("tournament_id", tournamentId));
  check(await supabase.from("group_players").insert(rows));
}

// For tests: the players in a random Selection Round order.
export async function randomDraw(tournamentId, groups, players) {
  return placeByRank(tournamentId, groups, shuffle(players));
}

export async function clearGroups(tournamentId) {
  check(await supabase.from("group_players").delete().eq("tournament_id", tournamentId));
}

// ---------------------------------------------------------------- fixtures

// A double round robin for four seats: rounds 1 to 3 are the first leg,
// rounds 4 to 6 the same pairings with colours reversed. Everyone has
// White three times and Black three times.
const FIRST_LEG = [
  [[1, 4], [2, 3]],
  [[4, 3], [1, 2]],
  [[2, 4], [3, 1]],
];
const GROUP_PAIRINGS = [...FIRST_LEG, ...FIRST_LEG.map((pairs) => pairs.map(([w, b]) => [b, w]))];

export async function generateGroupFixtures(tournament, groups, groupPlayers) {
  const tournamentId = tournament.id;
  const clock = formatOf("group", tournament);
  const base = Math.round(clock.minutes * 60_000);
  const rows = [];
  for (const g of groups) {
    const bySeed = new Map(groupPlayers.filter((gp) => gp.group_id === g.id).map((gp) => [gp.seed, gp.player_id]));
    if (bySeed.size !== 4) throw new Error(`Group ${g.label} needs 4 players before fixtures can be made.`);
    GROUP_PAIRINGS.forEach((pairs, r) =>
      pairs.forEach(([w, b]) =>
        rows.push({
          tournament_id: tournamentId,
          stage: "group",
          group_id: g.id,
          round: r + 1,
          white_id: bySeed.get(w),
          black_id: bySeed.get(b),
          white_base_ms: base,
          black_base_ms: base,
          increment_ms: Math.round(clock.increment * 1000),
        }),
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

// A friendly match outside the groups and the bracket, with its own clock.
// It's created first and then given its start time, so both players get
// the "game scheduled" update the database sends.
export async function createFriendly({ tournamentId, whiteId, blackId, when, minutes, increment }) {
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
      })
      .select("*")
      .single(),
  );
  return updateMatch(m.id, { scheduled_at: when });
}

export async function deleteMatch(id) {
  check(await supabase.from("matches").delete().eq("id", id));
}

export async function updateMatch(id, patch) {
  return check(await supabase.from("matches").update(patch).eq("id", id).select("*").single());
}

// Puts a game back to its starting position. In a knockout series, any
// tiebreak game that followed it no longer applies, and neither does the
// series result: the tie is reopened and, if the next round hasn't
// started, the winner is taken back out of it.
export async function resetGame(id) {
  const game = check(await supabase.from("matches").select("*").eq("id", id).single());
  check(await supabase.from("matches").delete().eq("tiebreak_of", id));
  if (game.series_id) {
    await reopenTie(game.series_id);
    const later = game.game_kind === "game" ? ["tiebreak", "decider"] : game.game_kind === "tiebreak" ? ["decider"] : [];
    if (later.length) check(await supabase.from("matches").delete().eq("series_id", game.series_id).in("game_kind", later));
  }
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
    // A decider goes back to the colour choice.
    ...(game.game_kind === "decider" && game.draw_winner_id
      ? { choose_by: game.white_id === game.draw_winner_id ? game.black_id : game.white_id }
      : {}),
  });
}

// Undoes a series result. The winner leaves the next tie (and the loser
// of a semifinal the third-place tie), unless games there have started.
async function reopenTie(tieId) {
  const tie = check(await supabase.from("matches").select("*").eq("id", tieId).single());
  if (!tie.winner_id) return;
  const loser = tie.winner_id === tie.white_id ? tie.black_id : tie.white_id;
  const all = check(await supabase.from("matches").select("*").eq("tournament_id", tie.tournament_id));
  const moves = [[all.find((m) => m.id === tie.next_match_id), tie.winner_id]];
  if (tie.stage === "sf") moves.push([all.find((m) => isTie(m) && m.stage === "third"), loser]);
  for (const [next, player] of moves) {
    if (!next) continue;
    const games = all.filter((m) => m.series_id === next.id);
    if (next.winner_id || games.some((g) => g.status !== "scheduled" || g.move_count > 0)) {
      throw new Error("The next round has already started from this result. Reset those games first.");
    }
  }
  for (const [next, player] of moves) {
    if (!next) continue;
    check(await supabase.from("matches").delete().eq("series_id", next.id));
    const patch = {};
    if (next.white_id === player) patch.white_id = null;
    if (next.black_id === player) patch.black_id = null;
    if (Object.keys(patch).length) await updateMatch(next.id, patch);
  }
  await updateMatch(tie.id, { winner_id: null, status: "scheduled", ended_at: null });
}

// The organisers decide a series themselves (tiebreaks switched off, or a
// ruling on appeal). The database moves the winner on.
export async function setTieWinner(tieId, winnerId) {
  return updateMatch(tieId, { winner_id: winnerId, status: "completed" });
}

// ---------------------------------------------------------------- knockout

// The guidebook's round of 16. Matches 1 and 2 feed quarterfinal 1, 3 and
// 4 quarterfinal 2, and so on; quarterfinals 1 and 2 meet in semifinal 1,
// 3 and 4 in semifinal 2.
export const R16_PAIRINGS = [
  ["A", 1, "H", 2],
  ["H", 1, "A", 2],
  ["D", 1, "E", 2],
  ["E", 1, "D", 2],
  ["C", 1, "F", 2],
  ["F", 1, "C", 2],
  ["B", 1, "G", 2],
  ["G", 1, "B", 2],
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
// between real players) a random result. The database then does what it
// would after real games: standings, the bracket, series results,
// tiebreak and decider games, and advancement. Runs again for each new
// round until nothing is left to play.
export async function simulateGames(tournamentId, profileById, { includeReal = false } = {}) {
  let played = 0;
  for (let pass = 0; pass < 30; pass++) {
    const games = check(await supabase.from("matches").select("*").eq("tournament_id", tournamentId).neq("status", "completed"));
    // A tie is a bracket slot, not a game: its series decides it.
    const todo = games.filter((m) => !isTie(m) && m.white_id && m.black_id && (includeReal || hasBot(m, profileById)));
    if (!todo.length) break;
    for (const m of todo) {
      const drawChance = m.stage === "group" ? 0.2 : 0.3;
      const r = Math.random();
      const result = r < drawChance ? "1/2-1/2" : Math.random() < 0.5 ? "1-0" : "0-1";
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
// testing go back to the start.
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
