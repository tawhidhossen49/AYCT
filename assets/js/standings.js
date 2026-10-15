// Group tables and tiebreaks.

import { scoreFor } from "./store.js";

export const TIEBREAK_NOTE = "Win 1, draw ½. Level players are split by Sonneborn-Berger, then wins, then head-to-head, then Selection Round rank.";

export function groupStandings(groupId, groupPlayers, matches, profileById) {
  const members = groupPlayers.filter((gp) => gp.group_id === groupId).sort((a, b) => a.seed - b.seed);
  const games = matches.filter((m) => m.stage === "group" && m.group_id === groupId && m.status === "completed" && m.result);

  const rows = new Map(
    members.map((gp) => [
      gp.player_id,
      { playerId: gp.player_id, played: 0, wins: 0, draws: 0, losses: 0, points: 0, sb: 0, seed: gp.seed },
    ]),
  );

  for (const m of games) {
    for (const id of [m.white_id, m.black_id]) {
      const row = rows.get(id);
      if (!row) continue;
      const s = scoreFor(m, id);
      row.played += 1;
      row.points += s;
      if (s === 1) row.wins += 1;
      else if (s === 0.5) row.draws += 1;
      else row.losses += 1;
    }
  }

  // Sonneborn-Berger: the scores of the opponents you beat, plus half of those you drew.
  for (const m of games) {
    for (const id of [m.white_id, m.black_id]) {
      const row = rows.get(id);
      const opp = rows.get(id === m.white_id ? m.black_id : m.white_id);
      if (row && opp) row.sb += scoreFor(m, id) * opp.points;
    }
  }

  // Head-to-head: a mini-league of the games between players still level on
  // points, Sonneborn-Berger and wins (the same rule the server uses).
  const level = (a, b) => a.points === b.points && a.sb === b.sb && a.wins === b.wins;
  for (const row of rows.values()) {
    row.mini = 0;
    for (const m of games) {
      if (m.white_id !== row.playerId && m.black_id !== row.playerId) continue;
      const opp = rows.get(m.white_id === row.playerId ? m.black_id : m.white_id);
      if (opp && level(row, opp)) row.mini += scoreFor(m, row.playerId);
    }
  }

  return [...rows.values()].sort(
    // The seed is the Selection Round order inside the group, so a lower seed is the better rank.
    (a, b) => b.points - a.points || b.sb - a.sb || b.wins - a.wins || b.mini - a.mini || a.seed - b.seed,
  );
}

export function formatPoints(n) {
  const whole = Math.floor(n);
  if (n - whole < 0.5) return String(whole);
  return whole === 0 ? "½" : `${whole}½`;
}
