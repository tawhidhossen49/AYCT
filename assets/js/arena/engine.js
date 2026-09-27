// Post-game review with Stockfish, running in the viewer's browser.
// Only offered once a game is over, so it can never help during play.

const STOCKFISH_URL = "https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js";

let worker = null;

function engine() {
  if (worker) return worker;
  // A worker from another origin needs a local wrapper that imports it.
  const blob = new Blob([`importScripts("${STOCKFISH_URL}");`], { type: "application/javascript" });
  worker = new Worker(URL.createObjectURL(blob));
  worker.postMessage("uci");
  worker.postMessage("setoption name Hash value 32");
  worker.postMessage("isready");
  return worker;
}

// Evaluates one position. Resolves to { cp, mate, best } from White's side.
function evaluate(fen, depth) {
  const w = engine();
  const whiteToMove = fen.split(" ")[1] === "w";
  return new Promise((resolve) => {
    let cp = 0;
    let mate = null;
    const onMessage = (e) => {
      const line = String(e.data);
      if (line.startsWith("info") && line.includes(" score ")) {
        const m = line.match(/score (cp|mate) (-?\d+)/);
        if (m) {
          if (m[1] === "cp") {
            cp = Number(m[2]);
            mate = null;
          } else {
            mate = Number(m[2]);
          }
        }
      } else if (line.startsWith("bestmove")) {
        w.removeEventListener("message", onMessage);
        const best = line.split(" ")[1];
        const sign = whiteToMove ? 1 : -1;
        // "mate 0": the side to move is already checkmated.
        if (mate === 0) return resolve({ cp: -sign * 10000, mate: null, best: null });
        resolve({ cp: sign * cp, mate: mate === null ? null : sign * mate, best: best === "(none)" ? null : best });
      }
    };
    w.addEventListener("message", onMessage);
    w.postMessage("ucinewgame");
    w.postMessage(`position fen ${fen}`);
    w.postMessage(`go depth ${depth}`);
  });
}

// A single number for charts: centipawns, with mates pinned near the edge.
export function scoreOf(ev) {
  if (!ev) return 0;
  if (ev.mate !== null && ev.mate !== undefined) return ev.mate > 0 ? 10000 - ev.mate : -10000 - ev.mate;
  return ev.cp;
}

// Chance of winning for White, 0..100 (the curve lichess uses).
export function winPercent(ev) {
  const cp = Math.max(-1000, Math.min(1000, scoreOf(ev)));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function evalLabel(ev) {
  if (!ev) return "0.0";
  if (ev.mate !== null && ev.mate !== undefined) return `${ev.mate > 0 ? "" : "-"}M${Math.abs(ev.mate)}`;
  if (Math.abs(ev.cp) >= 10000) return ev.cp > 0 ? "1-0" : "0-1";
  const v = ev.cp / 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
}

// Labels each move by how much of the mover's winning chance it threw away.
export function classify(before, after, whiteMoved) {
  const drop = whiteMoved ? winPercent(before) - winPercent(after) : winPercent(after) - winPercent(before);
  const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * Math.max(0, drop)) - 3.1669));
  let tag = null;
  if (drop >= 30) tag = "blunder";
  else if (drop >= 20) tag = "mistake";
  else if (drop >= 10) tag = "inaccuracy";
  return { drop, accuracy, tag };
}

// Analyses every position of a game. onProgress(done, total, evals) is
// called after each one so the page can fill in as it goes.
export async function analyseGame(fens, { depth = 12, onProgress } = {}) {
  const evals = [];
  for (let i = 0; i < fens.length; i++) {
    evals.push(await evaluate(fens[i], depth));
    onProgress?.(i + 1, fens.length, evals);
  }
  return evals;
}

export function stopEngine() {
  worker?.terminate();
  worker = null;
}
