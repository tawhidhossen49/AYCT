// Group tables and tiebreaks.

export const TIEBREAK_NOTE = "Win 1, draw ½. Ties go to Sonneborn-Berger, then wins, then head-to-head, then rating.";

function scoreFor(m, playerId) {
  if (!m.result) return null;
  if (m.result === "1/2-1/2") return 0.5;
  const whiteWon = m.result === "1-0";
  return (m.white_id === playerId) === whiteWon ? 1 : 0;
}

export function groupStandings(groupId, groupPlayers, matches, profileById) {
  const members = groupPlayers.filter((gp) => gp.group_id === groupId).sort((a, b) => a.seed - b.seed);
  const games = matches.filter((m) => m.stage === "group" && m.group_id === groupId && m.status === "completed" && m.result);

  const rows = new Map(
    members.map((gp) => [
      gp.player_id,
      { playerId: gp.player_id, played: 0, wins: 0, draws: 0, losses: 0, points: 0, sb: 0, rating: profileById.get(gp.player_id)?.rating ?? 0 },
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

  const headToHead = (a, b) => {
    const g = games.find((m) => (m.white_id === a && m.black_id === b) || (m.white_id === b && m.black_id === a));
    if (!g) return 0;
    const s = scoreFor(g, a);
    return s === 1 ? -1 : s === 0 ? 1 : 0;
  };

  return [...rows.values()].sort(
    (a, b) => b.points - a.points || b.sb - a.sb || b.wins - a.wins || headToHead(a.playerId, b.playerId) || b.rating - a.rating,
  );
}

export function formatPoints(n) {
  const whole = Math.floor(n);
  if (n - whole < 0.5) return String(whole);
  return whole === 0 ? "½" : `${whole}½`;
}
