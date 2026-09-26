// Chessboard helpers on top of chessground (the board lichess uses) and
// chess.js (the rules).

import { Chessground } from "https://cdn.jsdelivr.net/npm/chessground@9.2.1/+esm";
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm";

export { Chessground, Chess };

// Legal moves in the shape chessground wants: square -> [target squares].
export function legalDests(chess) {
  const dests = new Map();
  for (const m of chess.moves({ verbose: true })) {
    if (!dests.has(m.from)) dests.set(m.from, []);
    dests.get(m.from).push(m.to);
  }
  return dests;
}

// Rebuilds a game from its PGN so history, repetition and check are known.
export function gameFromMatch(match) {
  const chess = new Chess();
  if (match.pgn) {
    try {
      chess.loadPgn(match.pgn);
    } catch {
      chess.load(match.fen);
    }
  } else if (match.fen) {
    chess.load(match.fen);
  }
  return chess;
}

// Small read-only boards, e.g. the live games on the home page.
export function mountMiniBoards(root = document) {
  root.querySelectorAll("[data-mini-fen]").forEach((el) => {
    if (el.dataset.mounted === el.dataset.miniFen) return;
    el.dataset.mounted = el.dataset.miniFen;
    el.innerHTML = "";
    Chessground(el, { fen: el.dataset.miniFen, viewOnly: true, coordinates: false, animation: { enabled: false } });
  });
}
