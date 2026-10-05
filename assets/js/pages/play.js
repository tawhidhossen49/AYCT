// The Arena: where tournament games are played, watched, run and reviewed.
//
// Players move on a chessground board; every move goes to the `game` edge
// function, which checks it and runs the clocks (FIDE online rules). Both
// players, spectators and the arbiter see changes through Realtime.
// Without ?id= the page shows the Arena lobby: your board and every live game.

import { requireAuth, isStaff } from "../auth.js";
import { callFunction, supabase } from "../supabase.js";
import {
  store, loadAll, subscribe, upsertMatch, effectiveStatus, matchContext, involves, sortByTime,
  baseClocks, timeControlLabel,
  isKnockout,
} from "../store.js";
import { countdownHtml, formatClock, formatDateTime, formatTime, serverNow, startCountdowns, syncServerClock } from "../time.js";
import { botTag, emptyState, esc, icon, liveTag, mountShell, notice, openModal, playerHtml, resultText, sectionHead } from "../ui.js";
import { Chess, Chessground, gameFromMatch, legalDests, mountMiniBoards } from "../board.js";
import { play as sfx, setSoundEnabled, soundForMove } from "../arena/sounds.js";
import { analyseGame, classify, evalLabel, winPercent } from "../arena/engine.js";
import { sendMessage } from "../ops.js";

// ---------------------------------------------------------------- state
// Declared before the first await so every function below can use it.

// Only a real game id is used, anywhere (queries, live channels).
const rawId = new URLSearchParams(location.search).get("id");
const matchId = rawId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawId) ? rawId : null;
const SETTINGS_KEY = "ayct-arena-settings";
const DEFAULT_SETTINGS = { board: "steel", sound: true, coords: true, premove: true, dests: true, autoQueen: false };
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const FULL_SET = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const GLYPH = { w: { p: "♙", n: "♘", b: "♗", r: "♖", q: "♕" }, b: { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛" } };
const REASON = {
  checkmate: "checkmate",
  stalemate: "stalemate",
  "insufficient material": "insufficient material",
  "threefold repetition": "threefold repetition",
  "fifty-move rule": "the fifty-move rule",
  resignation: "resignation",
  agreement: "agreement",
  timeout: "time",
  "timeout vs insufficient material": "time against insufficient material",
};

// How a game ended, as plain text: "by checkmate", "on time". A result the
// organisers typed in, or a reason an arbiter wrote, is shown as a note.
function endPhrase(m) {
  const r = m.end_reason;
  if (!r) return "";
  if (r === "timeout") return "on time";
  if (r === "timeout vs insufficient material") return "out of time, but the opponent can't mate";
  if (REASON[r]) return `by ${REASON[r]}`;
  if (r === "result recorded by staff") return "result entered by the organisers";
  if (r === "test simulation") return "test simulation";
  if (r === "arbiter decision") return "by arbiter's decision";
  return `arbiter: ${r}`;
}
// "won by checkmate" reads on; a note goes in brackets.
const endTail = (m) => {
  const p = endPhrase(m);
  return !p ? "" : /^(by|on) /.test(p) ? ` ${p}` : ` (${p})`;
};

// How the arbiter's event log reads.
const EVENT_TEXT = {
  joined: "opened the game",
  tab_hidden: "left the game tab",
  tab_visible: "came back to the game tab",
  resign: "resigned",
  draw_offered: "offered a draw",
  draw_declined: "declined the draw",
  draw_agreed: "agreed a draw",
  paused: "paused the game",
  resumed: "resumed the game",
  time_added: "adjusted a clock",
  takeback: "took back a move",
  adjudicated: "adjudicated the game",
  game_over: "game over",
};

const S = {
  profile: null,
  match: null,
  game: null,
  cg: null,
  history: [],
  fens: [],
  ply: null, // the move being viewed; null follows the game
  flipped: false,
  busy: null,
  pending: false,
  lastFlagAt: 0,
  turnStart: 0,
  wasMyTurn: false,
  soundedPly: -1,
  ownSoundPly: -1,
  seenStatus: null,
  lowWarned: false,
  tab: "moves",
  comments: [],
  events: [],
  presence: null, // Map user_id -> { visible } once the first sync arrives
  goneSince: new Map(),
  viewers: 0,
  hiddenAt: null,
  botPly: -1, // the position a bot move was last asked for
  botAt: 0,
  analysis: null,
  analysing: false,
  progress: 0,
  settings: loadSettings(),
};

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings));
  } catch {
    /* settings just won't persist */
  }
}

// ---------------------------------------------------------------- boot

S.profile = await requireAuth();
await Promise.all([loadAll(), syncServerClock()]);
mountShell(S.profile, "arena");
startCountdowns();
setSoundEnabled(S.settings.sound);
const app = document.getElementById("app");

if (!matchId) {
  startLobby();
} else {
  await startGame();
}

// ================================================================ lobby (no game chosen)

function startLobby() {
  // Rebuilt only when what it shows has changed.
  let lastHtml = null;
  const draw = () => {
    const html = lobbyHtml();
    if (html === lastHtml) return;
    lastHtml = html;
    app.innerHTML = html;
    mountMiniBoards(app);
  };
  draw();
  subscribe(draw);
  setInterval(draw, 15_000);
}

function lobbyHtml() {
  const now = serverNow();
  const me = S.profile;
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").sort(sortByTime);
  const finished = store.matches
    .filter((m) => m.status === "completed" && m.move_count > 0)
    .sort((a, b) => new Date(b.ended_at ?? 0) - new Date(a.ended_at ?? 0))
    .slice(0, 8);
  const mine = store.matches.filter((m) => involves(m, me.id) && m.status !== "completed" && m.scheduled_at).sort(sortByTime);
  const next = mine.find((m) => effectiveStatus(m, now) === "live") ?? mine[0];

  let card = "";
  if (me.role === "player") {
    if (next) {
      const isLive = effectiveStatus(next, now) === "live";
      const white = next.white_id === me.id;
      card = `<section class="panel lit board-card">
        <div>
          <div class="row gap-3">${isLive ? liveTag() : `<span class="eyebrow">Your next game</span>`}<span class="small dim">${esc(matchContext(next))} · ${timeControlLabel(next)}</span></div>
          <h2>${isLive ? "Your board" : "Next up"}<span class="soft">vs ${esc(store.profileById.get(white ? next.black_id : next.white_id)?.full_name ?? "opponent to be decided")}</span></h2>
          <p class="muted mt-4">You play ${white ? "White" : "Black"}. ${isLive ? "Your game is on. The clock is running." : `Starts ${formatDateTime(next.scheduled_at)}.`}</p>
        </div>
        <div class="stack gap-4" style="align-items:flex-start">
          ${isLive ? "" : countdownHtml(next.scheduled_at, { big: true })}
          <a class="btn btn-primary btn-lg" href="play.html?id=${next.id}">${isLive ? "Play now" : "Enter the Arena"} ${icon("arrow-right", "bold")}</a>
        </div>
      </section>`;
    } else {
      card = `<section class="panel lit board-card"><div><span class="eyebrow">Your board</span><h2>No game<span class="soft">scheduled yet.</span></h2><p class="muted mt-4">When the organisers set your next game it appears here, with a countdown. You'll also get an update in the bell.</p></div></section>`;
    }
  } else {
    card = `<section class="panel lit board-card"><div><span class="eyebrow">${isStaff(me.role) ? "Arbiter" : "Spectator"}</span><h2>The Arena<span class="soft">${live.length ? `${live.length} live now.` : "is quiet."}</span></h2><p class="muted mt-4">${isStaff(me.role) ? "Open any game to watch it with the arbiter tools: pause, add time, take back, adjudicate and message players." : "Open any game to watch it live, with commentary."}</p></div>
      ${isStaff(me.role) ? `<div><a class="btn btn-primary btn-lg" href="admin.html#live">Live control ${icon("arrow-right", "bold")}</a></div>` : ""}</section>`;
  }

  const liveCards = live
    .map(
      (m) => `<a class="panel live-card" href="play.html?id=${m.id}">
        <div class="meta"><span>${esc(matchContext(m))}</span><span class="num">Move ${Math.ceil(m.move_count / 2) || 1}</span></div>
        <div class="who mb-3">${playerHtml(m.black_id, { me: me.id })}</div>
        <div class="mini-board" data-mini-fen="${esc(m.fen)}"></div>
        <div class="who mt-3">${playerHtml(m.white_id, { me: me.id })}</div>
      </a>`,
    )
    .join("");

  const rows = finished
    .map(
      (m) => `<a href="play.html?id=${m.id}" class="match-row">
        <span class="context">${esc(matchContext(m))}</span>
        <span class="sides"><span class="side">${playerHtml(m.white_id, { me: me.id })}</span><span class="side">${playerHtml(m.black_id, { me: me.id })}</span></span>
        <span class="status"><span class="num small strong">${resultText(m)}</span><span class="xs dim">Review</span></span>
      </a>`,
    )
    .join("");

  return `<div class="arena-lobby stack gap-12">
    ${card}
    <section>${sectionHead("On the boards", "Live", "now.", live.length ? "Open a game to watch it live." : "")}
      ${live.length ? `<div class="grid sm-2 lg-4">${liveCards}</div>` : `<div class="panel pad muted">No games are being played right now.</div>`}</section>
    <section>${sectionHead("Finished", "Review", "games.", "Replay any finished game move by move, with a Stockfish review.")}
      ${finished.length ? `<div class="panel pad-sm">${rows}</div>` : `<div class="panel pad muted">No finished games yet.</div>`}</section>
  </div>`;
}

// ================================================================ a game

async function startGame() {
  let m = store.matches.find((x) => x.id === matchId);
  if (!m) {
    // A game from an earlier edition: read it directly.
    const { data } = await supabase.from("matches").select("*").eq("id", matchId).maybeSingle();
    m = data;
  }
  if (!m) {
    app.innerHTML = emptyState("Game not found", "This game may have been removed or the link is wrong.", `<a class="btn" href="play.html">Back to the Arena</a>`);
    return;
  }
  S.match = m;
  document.title = `${nameOf(m.white_id)} vs ${nameOf(m.black_id)} · Arena`;
  layout();
  update();

  // Live updates: this game directly, plus the store (tiebreaks, the bracket).
  supabase
    .channel(`game-${matchId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` }, (p) => applyMatch(p.new))
    .subscribe();
  subscribe(() => {
    const fresh = store.matches.find((x) => x.id === matchId);
    if (fresh) applyMatch(fresh);
    else update();
  });

  joinPresence();
  loadComments();
  if (isStaff(S.profile.role) || myColour()) loadEvents();
  if (myColour() && m.status !== "completed") logEvent("joined");
  watchAttention();

  setInterval(tickClocks, 100);
  setInterval(tickSecond, 1000);
  window.addEventListener("resize", () => S.cg?.redrawAll());
  document.addEventListener("keydown", onKey);
}

function applyMatch(m) {
  if (S.match && m.updated_at < S.match.updated_at) return;
  S.match = m;
  upsertMatch(m);
  update();
}

// ---------------------------------------------------------------- derived state

function nameOf(id) {
  return store.profileById.get(id)?.full_name ?? "To be decided";
}
function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}
function myColour() {
  const m = S.match;
  return m.white_id === S.profile.id ? "white" : m.black_id === S.profile.id ? "black" : null;
}
function staff() {
  return isStaff(S.profile.role);
}
function status() {
  return effectiveStatus(S.match, serverNow());
}
function turnColour() {
  return S.game.turn() === "w" ? "white" : "black";
}
function paused() {
  return Boolean(S.match.paused_at);
}
function playing() {
  return status() === "live" && Boolean(myColour()) && !paused();
}
function myTurn() {
  return playing() && myColour() === turnColour() && !S.pending && !S.busy;
}
function lastPly() {
  return S.history.length;
}
function viewPly() {
  return S.ply ?? lastPly();
}
function reviewing() {
  return S.ply !== null && S.ply < lastPly();
}

function orientation() {
  const base = myColour() === "black" ? "black" : "white";
  return S.flipped ? (base === "white" ? "black" : "white") : base;
}

function clocks() {
  const m = S.match;
  const base = baseClocks(m);
  const now = serverNow();
  if (m.status === "scheduled") {
    const started = m.scheduled_at && status() === "live" ? now - new Date(m.scheduled_at).getTime() : 0;
    return { white: base.white - started, black: base.black };
  }
  const w = m.white_ms ?? base.white;
  const b = m.black_ms ?? base.black;
  if (m.status === "completed" || !m.clock_started_at || m.paused_at) return { white: w, black: b };
  const elapsed = now - new Date(m.clock_started_at).getTime();
  return turnColour() === "white" ? { white: w - elapsed, black: b } : { white: w, black: b - elapsed };
}

// Pieces each side has taken, and the material balance, for a position.
function material(fen) {
  const count = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const ch of fen.split(" ")[0]) {
    const lower = ch.toLowerCase();
    if (!(lower in PIECE_VALUE)) continue;
    count[ch === lower ? "b" : "w"][lower] += 1;
  }
  const score = (c) => Object.entries(c).reduce((s, [k, n]) => s + PIECE_VALUE[k] * n, 0);
  const taken = (side) =>
    Object.keys(FULL_SET)
      .map((k) => [k, Math.max(0, FULL_SET[k] - count[side][k])])
      .filter(([, n]) => n > 0);
  return { byWhite: taken("b"), byBlack: taken("w"), diff: score(count.w) - score(count.b) };
}

// ---------------------------------------------------------------- layout (once)

function layout() {
  const tabs = [
    { id: "moves", label: "Moves", icon: "list-numbers" },
    { id: "commentary", label: "Commentary", icon: "microphone" },
    { id: "info", label: "Info", icon: "info" },
    ...(staff() ? [{ id: "arbiter", label: "Arbiter", icon: "gavel" }] : []),
  ];
  app.innerHTML = `
    <div class="arena${S.settings.coords ? "" : " no-coords"}${S.settings.dests ? "" : " no-dests"}" data-board="${S.settings.board}">
      <div class="arena-stage">
        <div class="arena-board-wrap">
          <div class="eval-bar" id="evalbar" hidden><div class="eval-fill"></div><span class="eval-label"></span></div>
          <div class="arena-board-col">
            <div class="pcard" id="pc-top"></div>
            <div class="arena-frame" id="frame">
              <div class="board" id="board"></div>
              <div class="board-overlay" id="overlay" hidden></div>
            </div>
            <div class="pcard" id="pc-bottom"></div>
          </div>
        </div>
      </div>
      <aside class="arena-side" aria-label="Game panel">
        <div class="side-head" id="side-head"></div>
        <nav class="side-tabs${tabs.length > 3 ? " many" : ""}" role="tablist">${tabs
          .map((t) => `<button class="side-tab${t.id === S.tab ? " active" : ""}" role="tab" data-tab="${t.id}">${icon(t.icon, "bold")}${t.label}<span class="count" data-count="${t.id}"></span></button>`)
          .join("")}</nav>
        <div class="side-body" data-lenis-prevent>
          <div class="pane" data-pane="moves"></div>
          <div class="pane pane-pad" data-pane="commentary" hidden></div>
          <div class="pane pane-pad" data-pane="info" hidden></div>
          ${staff() ? `<div class="pane pane-pad" data-pane="arbiter" hidden></div>` : ""}
        </div>
        <div class="side-foot" id="foot"></div>
      </aside>
    </div>`;

  S.cg = Chessground(document.getElementById("board"), {
    coordinates: true,
    animation: { duration: 200 },
    highlight: { lastMove: true, check: true },
    draggable: { showGhost: true },
    premovable: { enabled: S.settings.premove, showDests: true, castle: true },
    movable: { free: false, showDests: true, events: { after: onMove } },
    drawable: { enabled: true, visible: true },
  });

  // Chessground caches where the board sits; re-measure on every press so
  // clicks always land on the right square.
  const boardEl = document.getElementById("board");
  const remeasure = () => S.cg.state.dom.bounds.clear();
  ["mousedown", "touchstart", "pointerdown"].forEach((type) => boardEl.addEventListener(type, remeasure, { capture: true, passive: true }));
  document.fonts?.ready.then(() => S.cg.redrawAll());

  app.addEventListener("click", onClick);
  app.addEventListener("submit", onSubmit);
  showTab(S.tab);
}

function showTab(id) {
  S.tab = id;
  app.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  app.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== id));
}

// ---------------------------------------------------------------- redraw on every change

function update() {
  const m = S.match;
  const prevPly = lastPly();
  S.game = gameFromMatch(m);
  S.history = S.game.history({ verbose: true });
  S.fens = S.history.length ? [S.history[0].before, ...S.history.map((h) => h.after)] : [S.game.fen()];
  if (S.ply !== null && S.ply >= lastPly()) S.ply = null;
  // A player snaps back to the live position when a new move arrives.
  if (myColour() && lastPly() > prevPly && prevPly >= 0 && S.ply !== null) S.ply = null;

  // Sounds for moves that arrive (our own already made theirs).
  if (S.soundedPly >= 0 && lastPly() > S.soundedPly && S.ownSoundPly !== lastPly()) {
    sfx(soundForMove(S.history[lastPly() - 1], S.game.inCheck()));
  }
  S.soundedPly = lastPly();

  // Start and end of the game.
  const st = status();
  if (S.seenStatus && S.seenStatus !== "completed" && st === "completed") {
    sfx("end");
    setTimeout(showResult, 450);
  } else if (S.seenStatus === "scheduled" && st === "live") {
    sfx("start");
  }
  S.seenStatus = st;

  // Our thinking time starts when our turn does.
  const mt = myTurn();
  if (mt && !S.wasMyTurn) S.turnStart = performance.now();
  S.wasMyTurn = mt;

  drawBoard();
  renderHead();
  renderPlayers();
  renderOverlay();
  renderMoves();
  renderFoot();
  renderInfo();
  renderCommentary();
  if (staff()) renderArbiter();
  renderEvalBar();
  tickClocks();
}

function drawBoard() {
  const ply = viewPly();
  const fen = S.fens[ply];
  const pos = ply === lastPly() ? S.game : new Chess(fen);
  const side = pos.turn() === "w" ? "white" : "black";
  const last = ply > 0 ? S.history[ply - 1] : null;
  const canMove = playing() && !reviewing();
  const mine = myColour();
  S.cg.set({
    fen,
    orientation: orientation(),
    turnColor: side,
    lastMove: last ? [last.from, last.to] : undefined,
    check: pos.inCheck() ? side : false,
    movable: { color: canMove ? mine : undefined, dests: canMove && myTurn() ? legalDests(S.game) : new Map(), showDests: S.settings.dests },
    premovable: { enabled: S.settings.premove && canMove },
    drawable: { autoShapes: bestMoveArrow(ply) },
  });
  document.getElementById("frame").classList.toggle("reviewing", reviewing());
  if (canMove && myTurn()) S.cg.playPremove();
  else if (!canMove) S.cg.cancelPremove();
}

function bestMoveArrow(ply) {
  const best = S.analysis?.evals?.[ply]?.best;
  if (!best || S.match.status !== "completed") return [];
  return [{ orig: best.slice(0, 2), dest: best.slice(2, 4), brush: "green" }];
}

// ---------------------------------------------------------------- side head

function renderHead() {
  const m = S.match;
  const st = status();
  const mine = myColour();
  const badge = mine
    ? ""
    : staff()
      ? `<span class="watch-tag arb-tag">${icon("gavel", "bold")} Arbiter</span>`
      : `<span class="watch-tag">${icon("eye", "bold")} Watching</span>`;
  document.getElementById("side-head").innerHTML = `
    <div class="title">${st === "live" ? liveTag() : ""}<h1>${esc(matchContext(m))}</h1>${badge}</div>
    <div class="meta">
      <span>${icon("timer")} ${timeControlLabel(m)}</span>
      ${m.scheduled_at ? `<span>${icon("calendar-blank")} ${formatDateTime(m.scheduled_at)}</span>` : ""}
      <span>${icon("users")} <b data-viewers>${S.viewers}</b> watching</span>
    </div>`;
}

// ---------------------------------------------------------------- players and clocks

function presenceState(id) {
  // Bots play from the server; they're never "in the room".
  if (!S.presence || store.profileById.get(id)?.is_bot) return "";
  const p = S.presence.get(id);
  if (!p) return "off";
  return p.visible ? "on" : "away";
}

function pcardHtml(colour) {
  const m = S.match;
  const id = colour === "white" ? m.white_id : m.black_id;
  const p = id ? store.profileById.get(id) : null;
  const name = p?.full_name ?? "To be decided";
  const mat = material(S.fens[viewPly()]);
  const taken = colour === "white" ? mat.byWhite : mat.byBlack;
  const glyphSide = colour === "white" ? "b" : "w";
  const lead = colour === "white" ? mat.diff : -mat.diff;
  const caps = taken.map(([k, n]) => `<span class="grp">${GLYPH[glyphSide][k].repeat(n)}</span>`).join("");
  const pres = presenceState(id);
  let note = "";
  if (id && status() === "live" && pres === "off" && S.goneSince.has(id)) {
    const s = Math.floor((Date.now() - S.goneSince.get(id)) / 1000);
    note = `<span class="note${s >= 60 ? " warn" : ""}">${icon("wifi-slash")} Not connected ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>`;
  } else if (id && status() === "live" && pres === "away") {
    note = `<span class="note warn">${icon("eye-slash")} Away from the board</span>`;
  }
  return `<div class="avatar ${colour}" aria-hidden="true">${esc(initials(name))}${pres ? `<span class="presence ${pres}" title="${pres === "on" ? "Online" : pres === "away" ? "Tab hidden" : "Not here"}"></span>` : ""}</div>
    <div class="who">
      <div class="line1"><span class="pname">${esc(name)}</span>${p?.is_bot ? botTag() : ""}${id === S.profile.id ? `<span class="you">You</span>` : ""}${m.draw_odds && colour === "black" ? `<span class="odds">Draw odds</span>` : ""}</div>
      <div class="line2"><span class="captured">${caps}</span>${lead > 0 ? `<span class="material">+${lead}</span>` : ""}${note}</div>
    </div>
    <div class="aclock" data-clock="${colour}" role="timer" aria-label="${colour} clock"><i class="ph-bold ph-hourglass-medium"></i><span></span></div>`;
}

function renderPlayers() {
  const top = orientation() === "white" ? "black" : "white";
  const bottom = top === "white" ? "black" : "white";
  document.getElementById("pc-top").innerHTML = pcardHtml(top);
  document.getElementById("pc-bottom").innerHTML = pcardHtml(bottom);
  tickClocks();
}

// Ten times a second: the clock faces.
function tickClocks() {
  if (!S.match || !S.game) return;
  const c = clocks();
  const st = status();
  const running = st === "live" && !paused();
  for (const colour of ["white", "black"]) {
    const el = app.querySelector(`[data-clock=${colour}]`);
    if (!el) continue;
    const ms = c[colour];
    const active = running && turnColour() === colour;
    el.classList.toggle("active", active);
    el.classList.toggle("low", st !== "completed" && ms < 20_000);
    el.classList.toggle("paused", paused());
    const text = formatClock(ms);
    if (el.lastElementChild.textContent !== text) el.lastElementChild.textContent = text;
  }

  const mine = myColour();
  if (mine && running && turnColour() === mine) {
    if (c[mine] < 10_000 && c[mine] > 0 && !S.lowWarned) {
      S.lowWarned = true;
      sfx("lowtime");
    }
    if (c[mine] > 12_000) S.lowWarned = false;
  }

  maybeBotMove();

  // A player's or the arbiter's screen tells the server when a flag falls
  // (the server also checks every 20 seconds by itself).
  if (running && (mine || staff()) && c[turnColour()] <= 0 && !S.busy && Date.now() - S.lastFlagAt > 3000) {
    S.lastFlagAt = Date.now();
    act("flag", {}, { quiet: true });
  }
}

// Test bots move when it's their turn and someone has the game open. The
// server picks the move; watching screens only ask for it, once per turn
// (again after 5 s if the first request was lost).
function maybeBotMove() {
  if (status() !== "live" || paused() || S.busy) return;
  const id = turnColour() === "white" ? S.match.white_id : S.match.black_id;
  if (!store.profileById.get(id)?.is_bot) return;
  const ply = lastPly();
  if (S.botPly === ply && Date.now() - S.botAt < 5000) return;
  S.botPly = ply;
  S.botAt = Date.now();
  setTimeout(() => {
    if (lastPly() === ply && S.match.status !== "completed" && !S.busy) act("bot_move", {}, { quiet: true });
  }, 700 + Math.random() * 900);
}

// Once a second: the countdown unlock, and disconnection timers.
function tickSecond() {
  if (!S.match) return;
  const overlay = document.getElementById("overlay");
  if (overlay.dataset.kind === "countdown" && status() === "live") update();
  if (status() === "live" && S.presence) renderPlayers();
  const st = document.querySelector("[data-starts]");
  if (st) st.textContent = startsIn();
}

function startsIn() {
  const ms = new Date(S.match.scheduled_at).getTime() - serverNow();
  if (ms <= 0) return "Starting now";
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return `Starts in ${h ? `${h}:${String(mm).padStart(2, "0")}` : mm}:${ss}`;
}

// ---------------------------------------------------------------- overlay (before the start, paused)

function renderOverlay() {
  const m = S.match;
  const overlay = document.getElementById("overlay");
  const mine = myColour();
  let kind = "";
  let html = "";
  if (!m.white_id || !m.black_id) {
    kind = "tbd";
    html = `<div class="lobby-card"><span class="eyebrow">Waiting</span><h2>Players to be decided</h2><p class="muted mt-4">This game's players come from earlier rounds.</p></div>`;
  } else if (status() === "scheduled") {
    kind = "countdown";
    const ready = (id) => {
      if (store.profileById.get(id)?.is_bot) return `<span class="ready">${botTag()} ${esc(nameOf(id))} is ready</span>`;
      const pres = presenceState(id) || "off";
      return `<span class="ready"><span class="presence ${pres}"></span>${esc(nameOf(id).split(" ")[0])} ${pres === "off" ? "not here yet" : "is here"}</span>`;
    };
    html = m.scheduled_at
      ? `<div class="lobby-card">
          <span class="eyebrow">${esc(matchContext(m))}</span>
          <h2>${mine ? `You play ${mine}` : "The board unlocks in"}</h2>
          <div class="mt-6">${countdownHtml(m.scheduled_at, { big: true })}</div>
          <div class="ready-row">${ready(m.white_id)}${ready(m.black_id)}</div>
          <p class="small dim mt-4">${timeControlLabel(m)} · starts ${formatTime(m.scheduled_at)}. White's clock starts at that time, whether or not White is here.${m.draw_odds ? " Armageddon: a draw counts as a win for Black." : ""}</p>
        </div>`
      : `<div class="lobby-card"><span class="eyebrow">Not scheduled</span><h2>No start time yet</h2><p class="muted mt-4">The organisers will set a time. You'll get an update when they do.</p></div>`;
  } else if (paused() && m.status !== "completed") {
    kind = "paused";
    html = `<div class="lobby-card"><span class="eyebrow">Arbiter</span><h2>Game paused</h2><p class="muted mt-4">The clocks are stopped. Play continues when the arbiter resumes the game.</p></div>`;
  }
  // Keep the running countdown element when nothing changed.
  if (overlay.dataset.kind === kind && kind === "countdown" && overlay.dataset.key === JSON.stringify([m.scheduled_at, S.presence && [...S.presence.keys()]])) return;
  overlay.dataset.kind = kind;
  overlay.dataset.key = JSON.stringify([m.scheduled_at, S.presence && [...S.presence.keys()]]);
  overlay.hidden = !kind;
  overlay.innerHTML = html;
}

// ---------------------------------------------------------------- moves pane

function renderMoves() {
  const pane = app.querySelector('[data-pane="moves"]');
  const m = S.match;
  const ply = viewPly();
  const a = S.analysis;
  const stamp = (i) => (m.clocks?.[i] != null ? `<span class="t">${formatClock(m.clocks[i])}</span>` : "");
  const tag = (i) => {
    const t = a?.tags?.[i + 1];
    return t ? `<span class="tag ${t}">${t === "blunder" ? "??" : t === "mistake" ? "?" : "?!"}</span>` : "";
  };
  let rows = "";
  for (let i = 0; i < S.history.length; i += 2) {
    const w = S.history[i];
    const b = S.history[i + 1];
    rows += `<div class="mv-row"><span class="mv-n">${i / 2 + 1}.</span>
      <button class="mv${ply === i + 1 ? " on" : ""}" data-ply="${i + 1}"><span>${esc(w.san)}${tag(i)}</span>${stamp(i)}</button>
      ${b ? `<button class="mv${ply === i + 2 ? " on" : ""}" data-ply="${i + 2}"><span>${esc(b.san)}${tag(i + 1)}</span>${stamp(i + 1)}</button>` : "<span></span>"}</div>`;
  }
  const result = m.status === "completed" && m.result ? `<p class="mv-result">${resultText(m)}${m.end_reason ? ` · ${esc(endPhrase(m))}` : ""}</p>` : "";

  let review = "";
  if (m.status === "completed" && S.history.length) {
    if (a && !S.analysing) {
      const names = { white: nameOf(m.white_id).split(" ")[0], black: nameOf(m.black_id).split(" ")[0] };
      review = `<div class="review-strip">
        <div class="row between"><span class="eyebrow">Game review</span><span class="xs dim">Stockfish · depth 12</span></div>
        <div class="acc"><div><b>${a.acc.white.toFixed(1)}</b><span>${esc(names.white)} accuracy</span></div><div><b>${a.acc.black.toFixed(1)}</b><span>${esc(names.black)} accuracy</span></div></div>
        <div class="counts"><span><b class="tag blunder">??</b> ${a.counts.blunder}</span><span><b class="tag mistake">?</b> ${a.counts.mistake}</span><span><b class="tag inaccuracy">?!</b> ${a.counts.inaccuracy}</span></div>
        ${evalGraph()}
      </div>`;
    } else if (S.analysing) {
      review = `<div class="review-strip"><div class="row between"><span class="eyebrow">Analysing</span><span class="num xs dim">${Math.round(S.progress * 100)}%</span></div><div class="progress"><i style="width:${S.progress * 100}%"></i></div>${S.analysis ? evalGraph() : ""}</div>`;
    } else {
      review = `<div class="review-strip"><div class="row between gap-4"><div><span class="eyebrow">Game review</span><p class="xs dim mt-2">Stockfish checks every move for blunders, mistakes and inaccuracies. The engine is only available after the game.</p></div><button class="btn btn-primary btn-sm" data-act-local="analyse">${icon("sparkle", "bold")} Analyse</button></div></div>`;
    }
  }

  pane.innerHTML = review + (S.history.length ? `<div class="mv-list">${rows}</div>${result}` : `<p class="mv-empty">No moves yet. White moves first.</p>${result}`);
  const on = pane.querySelector(".mv.on");
  const body = pane.closest(".side-body");
  if (on && S.ply === null && S.tab === "moves") body.scrollTop = body.scrollHeight;
  else on?.scrollIntoView({ block: "nearest" });
  const count = app.querySelector('[data-count="moves"]');
  if (count) count.textContent = S.history.length ? Math.ceil(S.history.length / 2) : "";
}

function evalGraph() {
  const evals = S.analysis?.evals ?? [];
  const n = Math.max(1, S.fens.length - 1);
  const pts = evals.map((e, i) => `${(i / n) * 100},${100 - winPercent(e)}`).join(" L");
  const x = (viewPly() / n) * 100;
  return `<svg class="eval-graph" viewBox="0 0 100 100" preserveAspectRatio="none" data-graph aria-label="Evaluation graph">
    <path d="M0,100 L${pts} L${((evals.length - 1) / n) * 100},100 Z" fill="rgb(236 238 242 / 0.85)"/>
    <line x1="0" y1="50" x2="100" y2="50" stroke="rgb(255 255 255 / 0.18)" stroke-width="0.6" vector-effect="non-scaling-stroke"/>
    <line x1="${x}" y1="0" x2="${x}" y2="100" stroke="#ff4d4d" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderEvalBar() {
  const bar = document.getElementById("evalbar");
  const ev = S.analysis?.evals?.[viewPly()];
  bar.hidden = !ev || S.match.status !== "completed";
  if (bar.hidden) return;
  const wp = winPercent(ev);
  const flipped = orientation() === "black";
  bar.classList.toggle("flipped", flipped);
  bar.querySelector(".eval-fill").style.height = `${wp}%`;
  const label = bar.querySelector(".eval-label");
  label.textContent = evalLabel(ev);
  // The number sits on the side that's ahead.
  const whiteAhead = wp >= 50;
  label.classList.toggle("top", whiteAhead === flipped);
}

// ---------------------------------------------------------------- foot: status, offers, actions, navigation

function renderFoot() {
  const m = S.match;
  const st = status();
  const mine = myColour();
  let line = "";
  let tone = "";
  if (reviewing()) {
    line = viewPly() === 0 ? "Viewing the start position. Press End to return." : `Viewing move ${Math.ceil(viewPly() / 2)}, ${viewPly() % 2 ? "White" : "Black"}. Press End to return.`;
  } else if (st === "completed") {
    line = resultLine();
  } else if (!m.white_id || !m.black_id) {
    line = "Waiting for the players to be decided.";
  } else if (st === "scheduled") {
    line = m.scheduled_at ? `<span data-starts>${startsIn()}</span>` : "Not scheduled yet.";
  } else if (paused()) {
    line = "Paused by the arbiter.";
    tone = "alert";
  } else if (mine) {
    if (myTurn()) {
      line = "Your move.";
      tone = "mine";
    } else if (S.pending || S.busy === "move") line = "Sending your move…";
    else line = "Your opponent is thinking.";
  } else {
    line = `${turnColour() === "white" ? "White" : "Black"} to move.`;
  }

  const opponent = mine === "white" ? m.black_id : m.white_id;
  const offerFromOpp = mine && m.draw_offer_by && m.draw_offer_by === opponent && st === "live";
  const offeredByMe = mine && m.draw_offer_by === S.profile.id;
  const minMoves = store.tournament?.draw_offer_min_moves ?? 0;
  const tooEarly = Math.floor(m.move_count / 2) < minMoves;

  const offer = offerFromOpp
    ? `<div class="offer"><p>${icon("handshake", "bold")} ${esc(nameOf(opponent).split(" ")[0])} offers a draw.</p>
        <div class="row gap-2"><button class="btn btn-primary btn-sm" data-act="accept_draw">Accept</button><button class="btn btn-sm" data-act="decline_draw">Decline</button></div></div>`
    : !mine && m.draw_offer_by && st === "live"
      ? `<div class="offer"><p>${icon("handshake", "bold")} ${esc(nameOf(m.draw_offer_by))} has offered a draw.</p></div>`
      : "";

  const actions =
    mine && st === "live" && !paused()
      ? `<div class="actions-row">
          <button class="btn btn-sm" data-act="offer_draw" ${offeredByMe || offerFromOpp || tooEarly ? "disabled" : ""} title="${tooEarly ? `Draw offers open after move ${minMoves}` : "Offer a draw"}">${icon("handshake")} ${offeredByMe ? "Draw offered" : "Offer draw"}</button>
          <button class="btn btn-danger btn-sm" data-resign>${icon("flag")} Resign</button>
        </div>`
      : mine && st === "completed"
        ? `<div class="actions-row"><a class="btn btn-sm" href="home.html">${icon("house")} Dashboard</a>${tiebreakOf() ? `<a class="btn btn-primary btn-sm" href="play.html?id=${tiebreakOf().id}">${icon("lightning", "bold")} Armageddon</a>` : ""}</div>`
        : "";

  const n = lastPly();
  const p = viewPly();
  document.getElementById("foot").innerHTML = `
    <div class="status-line ${tone}"><span class="dot"></span><span>${line}</span></div>
    ${offer}
    ${actions}
    <div class="nav-row">
      <button class="icon-btn" data-nav="first" aria-label="First move" ${p === 0 ? "disabled" : ""}>${icon("caret-double-left", "bold")}</button>
      <button class="icon-btn" data-nav="prev" aria-label="Previous move" ${p === 0 ? "disabled" : ""}>${icon("caret-left", "bold")}</button>
      <button class="icon-btn" data-nav="next" aria-label="Next move" ${p >= n ? "disabled" : ""}>${icon("caret-right", "bold")}</button>
      <button class="icon-btn" data-nav="last" aria-label="Latest move" ${p >= n ? "disabled" : ""}>${icon("caret-double-right", "bold")}</button>
      <span class="spacer"></span>
      <button class="icon-btn" data-act-local="flip" aria-label="Flip board" title="Flip board (F)">${icon("arrows-down-up", "bold")}</button>
      <button class="icon-btn" data-act-local="sound" aria-label="${S.settings.sound ? "Mute sounds" : "Turn sounds on"}">${icon(S.settings.sound ? "speaker-high" : "speaker-slash", "bold")}</button>
      <button class="icon-btn" data-act-local="settings" aria-label="Board settings">${icon("gear-six", "bold")}</button>
    </div>`;
}

function tiebreakOf() {
  return store.matches.find((x) => x.tiebreak_of === S.match.id) ?? null;
}

function resultLine() {
  const m = S.match;
  if (!m.result) return "Game over.";
  const reason = esc(endTail(m));
  if (m.result === "1/2-1/2") {
    return m.draw_odds ? `Drawn${reason}. Black goes through on draw odds.` : `Drawn${reason}.`;
  }
  const winner = m.result === "1-0" ? m.white_id : m.black_id;
  return `${esc(nameOf(winner))} won${reason}.`;
}

// ---------------------------------------------------------------- info pane

function renderInfo() {
  const m = S.match;
  const t = store.tournament;
  const c = baseClocks(m);
  const pane = app.querySelector('[data-pane="info"]');
  pane.innerHTML = `
    <h3>This game</h3>
    <dl class="facts">
      <dt>Event</dt><dd>${esc(t?.name ?? "Amaze Youth Chess Tournament")}</dd>
      <dt>Stage</dt><dd>${esc(matchContext(m))}</dd>
      <dt>White</dt><dd>${esc(nameOf(m.white_id))}</dd>
      <dt>Black</dt><dd>${esc(nameOf(m.black_id))}</dd>
      <dt>Time control</dt><dd>${Math.round(c.white / 60000)}${c.white !== c.black ? ` | ${Math.round(c.black / 60000)}` : ""} min + ${Math.round(c.increment / 1000)} s</dd>
      <dt>Start</dt><dd>${m.scheduled_at ? formatDateTime(m.scheduled_at) : "Not scheduled"}</dd>
      ${m.status === "completed" ? `<dt>Result</dt><dd>${resultText(m)}</dd>` : ""}
    </dl>
    ${S.history.length ? `<div class="row gap-2 mt-4"><button class="btn btn-sm" data-act-local="copy-pgn">${icon("copy")} Copy PGN</button><button class="btn btn-sm" data-act-local="download-pgn">${icon("download-simple")} Download</button></div>` : ""}
    <h3>Rules of play</h3>
    <ul class="rules">
      <li>${icon("check-circle", "fill")}<span>Checkmate, stalemate, threefold repetition, the fifty-move rule and insufficient material are recognised automatically.</span></li>
      <li>${icon("check-circle", "fill")}<span>If your flag falls you lose, unless your opponent has no way to checkmate; then it's a draw.</span></li>
      <li>${icon("check-circle", "fill")}<span>Losing your connection doesn't stop your clock. Rejoin from the same link as fast as you can.</span></li>
      <li>${icon("check-circle", "fill")}<span>A draw offer stands until your opponent accepts it, declines it or makes a move.</span></li>
      <li>${icon("check-circle", "fill")}<span>Premoves are allowed. There's no touch-move online: a move counts when it's played.</span></li>
      <li>${icon("check-circle", "fill")}<span>Knockout games can't end level: a drawn game is followed by an Armageddon game (White 5 min, Black 4 min, +2 s). Black goes through on a draw.</span></li>
      <li>${icon("check-circle", "fill")}<span>No engines, books or help during play. Leaving the game tab is logged for the arbiter.</span></li>
    </ul>`;
}

// ---------------------------------------------------------------- commentary

async function loadComments() {
  const { data } = await supabase.from("match_comments").select("*").eq("match_id", matchId).order("created_at");
  S.comments = data ?? [];
  renderCommentary();
  supabase
    .channel(`comments-${matchId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "match_comments", filter: `match_id=eq.${matchId}` }, (p) => {
      if (!S.comments.some((c) => c.id === p.new.id)) S.comments.push(p.new);
      renderCommentary();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "match_comments" }, (p) => {
      S.comments = S.comments.filter((c) => c.id !== p.old.id);
      renderCommentary();
    })
    .subscribe();
}

function renderCommentary() {
  const pane = app.querySelector('[data-pane="commentary"]');
  if (!pane) return;
  const canPost = S.profile.role === "commentator" || staff();
  // Fair play: the two players don't see commentary until their game ends.
  const hidden = myColour() && S.match.status !== "completed";
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const count = app.querySelector('[data-count="commentary"]');
  if (count) count.textContent = hidden || !S.comments.length ? "" : S.comments.length;
  if (hidden) {
    pane.innerHTML = `<p class="small muted">Commentary is hidden from both players until the game ends, so nothing can help either side.</p>`;
    return;
  }
  const typing = pane.querySelector("#comment");
  const draft = typing?.value ?? "";
  const focused = document.activeElement === typing;
  pane.innerHTML = `
    <ul class="comments" style="max-height:none;margin-top:0">${S.comments.length
      ? S.comments.map((c) => `<li><span class="xs dim">${esc(store.profileById.get(c.author_id)?.full_name ?? "Commentator")} · ${time(c.created_at)}</span><p class="mt-1">${esc(c.body)}</p></li>`).join("")
      : `<li class="dim">No commentary yet.</li>`}</ul>
    ${canPost ? `<form class="row gap-2 mt-4" data-form="comment"><label for="comment" class="sr-only">Add commentary</label><input id="comment" class="input" maxlength="500" placeholder="Add a comment"><button class="btn btn-primary" type="submit" aria-label="Post">${icon("paper-plane-right", "fill")}</button></form>` : ""}`;
  const input = pane.querySelector("#comment");
  if (input) {
    input.value = draft;
    if (focused) input.focus();
  }
}

// ---------------------------------------------------------------- arbiter pane

async function loadEvents() {
  const { data } = await supabase.from("game_events").select("*").eq("match_id", matchId).order("created_at");
  S.events = data ?? [];
  if (staff()) renderArbiter();
  supabase
    .channel(`events-${matchId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "game_events", filter: `match_id=eq.${matchId}` }, (p) => {
      if (S.events.some((e) => e.id === p.new.id)) return;
      S.events.push(p.new);
      if (staff()) renderArbiter();
    })
    .subscribe();
}


function eventLine(e) {
  let text = EVENT_TEXT[e.kind] ?? e.kind;
  if (e.kind === "time_added") text = `gave ${e.detail?.color} ${e.detail?.seconds > 0 ? "+" : ""}${e.detail?.seconds} s`;
  if (e.kind === "takeback") text = `took back ${e.detail?.san ?? "a move"}`;
  if (e.kind === "tab_visible" && e.detail?.away_ms) text += ` after ${Math.round(e.detail.away_ms / 1000)} s`;
  if (e.kind === "game_over") text = `Game over: ${e.detail?.result ?? ""}${e.detail?.reason ? ` (${e.detail.reason})` : ""}`;
  const who = e.kind === "game_over" ? "" : `${esc(nameOf(e.user_id))} `;
  const warn = e.kind === "tab_hidden" ? " warn" : "";
  return `<li><time>${new Date(e.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time><span class="${warn}">${who}${esc(text)}</span></li>`;
}

function renderArbiter() {
  const pane = app.querySelector('[data-pane="arbiter"]');
  if (!pane) return;
  const m = S.match;
  const st = status();
  const running = st === "live";
  const player = (colour) => {
    const id = colour === "white" ? m.white_id : m.black_id;
    const pres = presenceState(id) || "off";
    const away = S.events.filter((e) => e.user_id === id && e.kind === "tab_hidden").length;
    return `<div class="pres-row"><span class="row gap-2"><span class="presence ${pres}" style="position:static;border:0"></span><span class="strong">${esc(nameOf(id))}</span><span class="xs dim">${colour}</span></span><span class="xs ${away ? "signal" : "dim"}">${pres === "on" ? "Online" : pres === "away" ? "Tab hidden" : "Not here"} · ${away} tab switch${away === 1 ? "" : "es"}</span></div>`;
  };
  const draft = pane.querySelector("#arb-msg")?.value ?? "";
  pane.innerHTML = `
    <h3>Players</h3>
    ${m.white_id && m.black_id ? player("white") + player("black") : `<p class="small dim">Players not decided yet.</p>`}
    <h3>Game control</h3>
    ${running
      ? `<div class="arb-grid">
          <button class="btn btn-sm ${paused() ? "btn-primary" : ""}" data-arb="${paused() ? "resume" : "pause"}">${icon(paused() ? "play" : "pause", "bold")} ${paused() ? "Resume" : "Pause"}</button>
          <button class="btn btn-sm" data-arb="takeback" ${m.move_count ? "" : "disabled"}>${icon("arrow-counter-clockwise", "bold")} Take back</button>
          <button class="btn btn-sm" data-arb="add_time" data-color="white" data-s="30">+30 s White</button>
          <button class="btn btn-sm" data-arb="add_time" data-color="black" data-s="30">+30 s Black</button>
          <button class="btn btn-sm" data-arb="add_time" data-color="white" data-s="120">+2 min White</button>
          <button class="btn btn-sm" data-arb="add_time" data-color="black" data-s="120">+2 min Black</button>
        </div>
        <h3>Adjudicate</h3>
        <div class="arb-grid" style="grid-template-columns:repeat(3,1fr)">
          <button class="btn btn-sm" data-adj="1-0">1 - 0</button><button class="btn btn-sm" data-adj="1/2-1/2">½ - ½</button><button class="btn btn-sm" data-adj="0-1">0 - 1</button>
        </div>`
      : st === "completed"
        ? `<p class="small muted">The game is over. To correct a result, use <a href="admin.html#matches" style="text-decoration:underline">Matches in the Control Room</a>.</p>`
        : `<p class="small muted">The controls unlock when the game starts.</p>`}
    ${m.white_id && m.black_id
      ? `<h3>Message the players</h3>
        <form class="stack gap-2" data-form="arb-msg">
          <select class="input sm" name="to"><option value="both">Both players</option><option value="white">${esc(nameOf(m.white_id))} (White)</option><option value="black">${esc(nameOf(m.black_id))} (Black)</option></select>
          <textarea class="input sm" id="arb-msg" name="body" rows="2" maxlength="300" placeholder="e.g. Please turn your camera back on." required>${esc(draft)}</textarea>
          <button class="btn btn-sm" type="submit">${icon("megaphone", "bold")} Send</button>
        </form>`
      : ""}
    <h3>Event log</h3>
    ${S.events.length ? `<ul class="log">${S.events.slice().reverse().map(eventLine).join("")}</ul>` : `<p class="small dim">Nothing logged yet.</p>`}
    <div data-arb-err class="mt-4"></div>`;
  const count = app.querySelector('[data-count="arbiter"]');
  const alerts = S.events.filter((e) => e.kind === "tab_hidden").length;
  if (count) count.textContent = alerts ? alerts : "";
}

// ---------------------------------------------------------------- presence and attention

function presencePayload() {
  return { user_id: S.profile.id, match_id: matchId, role: S.profile.role, visible: !document.hidden };
}

function joinPresence() {
  const ch = supabase.channel("arena-presence", { config: { presence: { key: `${S.profile.id}:${matchId}` } } });
  ch.on("presence", { event: "sync" }, () => {
    const map = new Map();
    const viewers = new Set();
    for (const metas of Object.values(ch.presenceState())) {
      for (const meta of metas) {
        if (meta.match_id !== matchId) continue;
        const prev = map.get(meta.user_id);
        map.set(meta.user_id, { visible: Boolean(prev?.visible || meta.visible) });
        viewers.add(meta.user_id);
      }
    }
    S.presence = map;
    const m = S.match;
    for (const id of [m.white_id, m.black_id]) {
      if (!id) continue;
      if (map.has(id)) S.goneSince.delete(id);
      else if (!S.goneSince.has(id)) S.goneSince.set(id, Date.now());
    }
    S.viewers = [...viewers].filter((id) => id !== m.white_id && id !== m.black_id).length;
    const v = app.querySelector("[data-viewers]");
    if (v) v.textContent = S.viewers;
    renderPlayers();
    renderOverlay();
    if (staff()) renderArbiter();
  });
  ch.subscribe(async (state) => {
    if (state === "SUBSCRIBED") await ch.track(presencePayload());
  });
  document.addEventListener("visibilitychange", () => ch.track(presencePayload()));
}

function logEvent(kind, detail = null) {
  supabase.from("game_events").insert({ match_id: matchId, user_id: S.profile.id, kind, detail }).then(() => {});
}

// Players leaving the game tab during play is logged for the arbiter.
function watchAttention() {
  document.addEventListener("visibilitychange", () => {
    if (!myColour() || status() !== "live") return;
    if (document.hidden) {
      S.hiddenAt = Date.now();
      logEvent("tab_hidden");
    } else if (S.hiddenAt) {
      logEvent("tab_visible", { away_ms: Date.now() - S.hiddenAt });
      S.hiddenAt = null;
    }
  });
}

// ---------------------------------------------------------------- actions

// quiet: background actions (the timeout claim) never show errors.
async function act(action, extra = {}, { quiet = false } = {}) {
  S.busy = action;
  try {
    const res = await callFunction("game", { action, match_id: matchId, ...extra });
    S.match = res.match;
    upsertMatch(res.match);
  } catch (err) {
    if (!quiet) {
      if (action === "move") sfx("illegal");
      showError(err.message);
    }
  } finally {
    S.busy = null;
    S.pending = false;
    update();
  }
}

function showError(message) {
  const foot = document.getElementById("foot");
  foot.querySelector(".notice")?.remove();
  foot.insertAdjacentHTML("afterbegin", notice(esc(message), "error"));
  setTimeout(() => foot.querySelector(".notice")?.remove(), 5000);
}

function onMove(from, to, meta = {}) {
  const piece = S.game.get(from);
  const promotion = piece?.type === "p" && (to[1] === "8" || to[1] === "1");
  if (promotion && !S.settings.autoQueen && !meta.premove) {
    choosePromotion(from, to);
    return;
  }
  sendMove(from, to, promotion ? "q" : undefined, meta.premove);
}

function sendMove(from, to, promotion, premove = false) {
  // Our own move sounds straight away, before the server confirms it.
  try {
    const probe = new Chess(S.game.fen());
    const mv = probe.move({ from, to, promotion: promotion || "q" });
    sfx(premove ? "premove" : soundForMove(mv, probe.inCheck()));
    S.ownSoundPly = lastPly() + 1;
  } catch {
    /* the server will reject it */
  }
  const think = premove ? 0 : Math.round(performance.now() - S.turnStart);
  S.pending = true;
  renderFoot();
  act("move", { from, to, promotion, think_ms: think });
}

function choosePromotion(from, to) {
  const side = myColour() === "black" ? "b" : "w";
  const names = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
  const d = openModal(
    "Promote pawn to",
    `<div class="promo-grid">${Object.keys(names).map((k) => `<button data-promo="${k}"><span aria-hidden="true">${GLYPH[side][k]}</span><small>${names[k]}</small></button>`).join("")}</div>`,
  );
  let chosen = false;
  d.addEventListener("click", (e) => {
    const b = e.target.closest("[data-promo]");
    if (!b) return;
    chosen = true;
    d.close();
    sendMove(from, to, b.dataset.promo);
  });
  // Closing without choosing puts the pawn back.
  d.addEventListener("close", () => {
    if (!chosen) update();
  });
}

function goTo(ply) {
  const n = lastPly();
  const p = Math.max(0, Math.min(n, ply));
  S.ply = p >= n ? null : p;
  S.cg.cancelPremove();
  drawBoard();
  renderPlayers();
  renderMoves();
  renderFoot();
  renderEvalBar();
}

function onKey(e) {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector("dialog[open]")) return;
  const p = viewPly();
  if (e.key === "ArrowLeft") goTo(p - 1);
  else if (e.key === "ArrowRight") goTo(p + 1);
  else if (e.key === "Home" || e.key === "ArrowUp") goTo(0);
  else if (e.key === "End" || e.key === "ArrowDown") goTo(lastPly());
  else if (e.key === "f" || e.key === "F") flip();
  else return;
  e.preventDefault();
}

function flip() {
  S.flipped = !S.flipped;
  drawBoard();
  renderPlayers();
  renderEvalBar();
}

function onClick(e) {
  const tab = e.target.closest("[data-tab]");
  if (tab) return showTab(tab.dataset.tab);

  const mv = e.target.closest("[data-ply]");
  if (mv) return goTo(Number(mv.dataset.ply));

  const nav = e.target.closest("[data-nav]");
  if (nav) {
    const p = viewPly();
    return goTo({ first: 0, prev: p - 1, next: p + 1, last: lastPly() }[nav.dataset.nav]);
  }

  const graph = e.target.closest("[data-graph]");
  if (graph) {
    const r = graph.getBoundingClientRect();
    return goTo(Math.round(((e.clientX - r.left) / r.width) * (S.fens.length - 1)));
  }

  const a = e.target.closest("[data-act]");
  if (a) return act(a.dataset.act);

  if (e.target.closest("[data-resign]")) return confirmResign();

  const local = e.target.closest("[data-act-local]");
  if (local) {
    switch (local.dataset.actLocal) {
      case "flip":
        return flip();
      case "sound":
        S.settings.sound = !S.settings.sound;
        setSoundEnabled(S.settings.sound);
        saveSettings();
        return renderFoot();
      case "settings":
        return settingsModal();
      case "analyse":
        return runAnalysis();
      case "copy-pgn":
        navigator.clipboard?.writeText(pgnText()).then(() => (local.innerHTML = `${icon("check", "bold")} Copied`));
        return;
      case "download-pgn":
        return downloadPgn();
    }
  }

  const arb = e.target.closest("[data-arb]");
  if (arb) {
    const extra = arb.dataset.arb === "add_time" ? { color: arb.dataset.color, seconds: Number(arb.dataset.s) } : {};
    if (arb.dataset.arb === "takeback" && !confirm("Take back the last move? The player who made it will be on move again.")) return;
    return act(arb.dataset.arb, extra);
  }

  const adj = e.target.closest("[data-adj]");
  if (adj) return adjudicateModal(adj.dataset.adj);
}

async function onSubmit(e) {
  const form = e.target.closest("form");
  if (!form) return;
  e.preventDefault();
  if (form.dataset.form === "comment") {
    const input = form.querySelector("#comment");
    const body = input.value.trim();
    if (!body) return;
    const { data, error } = await supabase.from("match_comments").insert({ match_id: matchId, author_id: S.profile.id, body }).select("*").single();
    if (error) return showError(error.message);
    input.value = "";
    if (!S.comments.some((c) => c.id === data.id)) S.comments.push(data);
    renderCommentary();
  }
  if (form.dataset.form === "arb-msg") {
    const m = S.match;
    const to = form.to.value;
    const ids = to === "white" ? [m.white_id] : to === "black" ? [m.black_id] : [m.white_id, m.black_id];
    const btn = form.querySelector("[type=submit]");
    btn.disabled = true;
    try {
      await sendMessage(ids, "Message from the arbiter", form.body.value.trim(), `play.html?id=${matchId}`);
      form.body.value = "";
      btn.innerHTML = `${icon("check", "bold")} Sent`;
      setTimeout(() => renderArbiter(), 1500);
    } catch (err) {
      btn.disabled = false;
      showError(err.message);
    }
  }
}

function confirmResign() {
  const d = openModal(
    "Resign this game?",
    `<p class="muted">Your opponent wins this game. This can't be undone.</p>
     <div class="modal-actions"><button class="btn" data-close>Keep playing</button><button class="btn btn-danger" data-confirm>${icon("flag", "bold")} Resign</button></div>`,
  );
  d.querySelector("[data-confirm]").addEventListener("click", () => {
    d.close();
    act("resign");
  });
}

function adjudicateModal(result) {
  const label = result === "1/2-1/2" ? "a draw" : result === "1-0" ? `a win for ${nameOf(S.match.white_id)} (White)` : `a win for ${nameOf(S.match.black_id)} (Black)`;
  const d = openModal(
    "Adjudicate the game",
    `<form class="stack gap-4"><p class="muted">End the game now as ${esc(label)}. Standings and the bracket update automatically.</p>
      <div class="field"><label for="adj-reason">Reason</label><input class="input" id="adj-reason" name="reason" maxlength="80" value="arbiter decision"></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${icon("gavel", "bold")} End the game</button></div></form>`,
  );
  d.querySelector("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const reason = e.target.reason.value.trim() || "arbiter decision";
    d.close();
    act("adjudicate", { result, reason });
  });
}

function settingsModal() {
  const s = S.settings;
  const boards = [
    ["steel", "Steel", "#c9ccd2", "#5d616b"],
    ["green", "Tournament green", "#ebecd0", "#779556"],
    ["walnut", "Walnut", "#f0d9b5", "#b58863"],
    ["ice", "Ice", "#dee3e6", "#8ca2ad"],
    ["midnight", "Midnight", "#9aa3b5", "#3c4459"],
  ];
  const toggle = (key, label, hint) =>
    `<label class="row between gap-4" style="padding:0.6rem 0;cursor:pointer"><span><span class="strong small" style="display:block">${label}</span><span class="hint">${hint}</span></span><input type="checkbox" data-set="${key}" ${s[key] ? "checked" : ""} style="width:1.2rem;height:1.2rem;accent-color:#d9dce2"></label>`;
  const d = openModal(
    "Board settings",
    `<div class="field"><label>Board colours</label><div class="row wrap gap-2">${boards
      .map(
        ([id, name, l, dk]) =>
          `<button class="chip${s.board === id ? " active" : ""}" data-board-pick="${id}" style="gap:0.5rem"><span style="width:1.1rem;height:1.1rem;border-radius:3px;background:linear-gradient(135deg,${l} 50%,${dk} 50%)"></span>${name}</button>`,
      )
      .join("")}</div></div>
     <div class="mt-4">
      ${toggle("sound", "Sounds", "Moves, captures, checks and low time.")}
      ${toggle("premove", "Premoves", "Queue your next move while your opponent thinks.")}
      ${toggle("dests", "Show legal moves", "Dots on the squares a piece can move to.")}
      ${toggle("coords", "Coordinates", "Files and ranks on the board edge.")}
      ${toggle("autoQueen", "Always promote to a queen", "Skip the promotion choice.")}
     </div>
     <div class="modal-actions"><button class="btn btn-primary" data-close>Done</button></div>`,
  );
  d.addEventListener("click", (e) => {
    const b = e.target.closest("[data-board-pick]");
    if (!b) return;
    s.board = b.dataset.boardPick;
    d.querySelectorAll("[data-board-pick]").forEach((x) => x.classList.toggle("active", x === b));
    applySettings();
  });
  d.addEventListener("change", (e) => {
    const key = e.target.dataset.set;
    if (!key) return;
    s[key] = e.target.checked;
    applySettings();
  });
}

function applySettings() {
  const s = S.settings;
  saveSettings();
  setSoundEnabled(s.sound);
  const arena = app.querySelector(".arena");
  arena.dataset.board = s.board;
  arena.classList.toggle("no-coords", !s.coords);
  arena.classList.toggle("no-dests", !s.dests);
  if (!s.premove) S.cg.cancelPremove();
  drawBoard();
  renderFoot();
}

// ---------------------------------------------------------------- result

function showResult() {
  const m = S.match;
  if (!m.result) return;
  const mine = myColour();
  const winnerColour = m.result === "1-0" ? "white" : m.result === "0-1" ? "black" : m.draw_odds ? "black" : null;
  let big;
  if (mine) big = winnerColour ? (winnerColour === mine ? "You won" : "You lost") : "Draw";
  else big = winnerColour ? `${nameOf(winnerColour === "white" ? m.white_id : m.black_id).split(" ")[0]} won` : "Draw";
  const reason = endPhrase(m);
  const oddsNote = m.draw_odds && m.result === "1/2-1/2" ? "<p class=\"small muted mt-2\">Armageddon: Black goes through on a draw.</p>" : "";
  const side = (colour) => {
    const id = colour === "white" ? m.white_id : m.black_id;
    return `<div class="p${winnerColour === colour ? " won" : ""}"><div class="avatar ${colour}" style="width:3.4rem;height:3.4rem;font-size:1.2rem">${esc(initials(nameOf(id)))}</div><span class="n">${esc(nameOf(id))}</span></div>`;
  };
  const knockoutDraw = isKnockout(m) && !m.tiebreak_of && m.result === "1/2-1/2" && !m.winner_id;
  const tb = tiebreakOf();
  const d = openModal(
    "Game over",
    `<div class="result-hero"><p class="big chrome-text">${esc(big)}</p><p class="score">${resultText(m)}${reason ? ` · ${esc(reason)}` : ""}</p>${oddsNote}</div>
     <div class="result-players">${side("white")}<span class="num dim">vs</span>${side("black")}</div>
     ${knockoutDraw ? notice(tb ? `An Armageddon game decides who goes through. It starts at ${formatTime(tb.scheduled_at)}.` : "A knockout game can't end level. An Armageddon game will be scheduled and you'll get an update.") : ""}
     <div class="modal-actions" style="justify-content:center;flex-wrap:wrap">
      ${tb ? `<a class="btn btn-primary" href="play.html?id=${tb.id}">${icon("lightning", "bold")} Go to Armageddon</a>` : ""}
      <button class="btn ${tb ? "" : "btn-primary"}" data-review>${icon("magnifying-glass", "bold")} Review game</button>
      <a class="btn" href="${mine ? "home.html" : "play.html"}">${mine ? "Dashboard" : "Arena"}</a>
     </div>`,
  );
  d.querySelector("[data-review]").addEventListener("click", () => {
    d.close();
    showTab("moves");
    runAnalysis();
  });
}

// ---------------------------------------------------------------- review

async function runAnalysis() {
  if (S.analysing || S.analysis?.done || S.match.status !== "completed") return;
  S.analysing = true;
  S.progress = 0;
  renderMoves();
  try {
    const evals = await analyseGame(S.fens, {
      depth: 12,
      onProgress: (done, total, partial) => {
        S.progress = done / total;
        S.analysis = { evals: partial.slice() };
        renderMoves();
        renderEvalBar();
      },
    });
    const tags = [null];
    const acc = { white: [], black: [] };
    const counts = { blunder: 0, mistake: 0, inaccuracy: 0 };
    for (let i = 1; i < evals.length; i++) {
      const whiteMoved = S.history[i - 1].color === "w";
      const c = classify(evals[i - 1], evals[i], whiteMoved);
      tags.push(c.tag);
      acc[whiteMoved ? "white" : "black"].push(c.accuracy);
      if (c.tag) counts[c.tag] += 1;
    }
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 100);
    S.analysis = { evals, tags, counts, acc: { white: avg(acc.white), black: avg(acc.black) }, done: true };
  } catch (err) {
    S.analysis = null;
    showError(`The engine couldn't start: ${err.message}`);
  } finally {
    S.analysing = false;
    renderMoves();
    renderEvalBar();
    drawBoard();
  }
}

function pgnText() {
  const m = S.match;
  const t = store.tournament;
  const date = (m.started_at ?? m.scheduled_at ?? new Date().toISOString()).slice(0, 10).replace(/-/g, ".");
  const c = baseClocks(m);
  const headers = {
    Event: t?.name ?? "Amaze Youth Chess Tournament",
    Site: "Amaze Arena",
    Date: date,
    Round: matchContext(m),
    White: nameOf(m.white_id),
    Black: nameOf(m.black_id),
    Result: m.result ?? "*",
    TimeControl: `${Math.round(c.white / 1000)}+${Math.round(c.increment / 1000)}`,
    Termination: m.end_reason ?? "",
  };
  const head = Object.entries(headers)
    .map(([k, v]) => `[${k} "${String(v).replace(/"/g, "'")}"]`)
    .join("\n");
  // chess.js adds its own placeholder headers; keep only the moves.
  const moves = S.game.pgn().replace(/^\[.*\]\s*$/gm, "").replace(/\s*\*\s*$/, "").trim();
  return `${head}\n\n${moves} ${m.result ?? "*"}\n`;
}

function downloadPgn() {
  const blob = new Blob([pgnText()], { type: "application/x-chess-pgn" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${nameOf(S.match.white_id)}-vs-${nameOf(S.match.black_id)}.pgn`.replace(/\s+/g, "_");
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
