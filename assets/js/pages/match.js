// A single game: the board, both clocks, the move list, and for the two
// players, their controls. Moves go to the `game` edge function, which
// checks them and runs the clocks; everyone else watches through Realtime.

import { isStaff } from "../auth.js";
import { callFunction, supabase } from "../supabase.js";
import { store, effectiveStatus, matchContext, subscribe, upsertMatch } from "../store.js";
import { countdownHtml, formatClock, formatDateTime, formatTime, serverNow } from "../time.js";
import { emptyState, esc, icon, liveTag, notice, openModal, resultText } from "../ui.js";
import { Chessground, gameFromMatch, legalDests } from "../board.js";
import { startPage } from "../page.js";
import { animateIn, getLenis, reduced } from "../motion.js";

const matchId = new URLSearchParams(location.search).get("id");
const { profile, app } = await startPage("fixtures", { hero: matchHero });

// Compact header band: the two players over the rising king.
function matchHero() {
  const m = store.matches.find((x) => x.id === matchId);
  if (!m) return { scene: "rising", compact: true, eyebrow: "Game", bold: "Game", soft: "not found." };
  const name = (id) => store.profileById.get(id)?.full_name ?? "To be decided";
  const when = m.scheduled_at ? formatDateTime(m.scheduled_at) : "Not scheduled";
  const result = m.status === "completed" && m.result ? (m.result === "1/2-1/2" ? "½ - ½" : m.result.replace("-", " - ")) : null;
  return {
    scene: "rising",
    compact: true,
    eyebrow: esc(matchContext(m)),
    bold: name(m.white_id),
    soft: `vs ${name(m.black_id)}`,
    lede: esc(when),
    stats: result ? [{ value: result, label: m.end_reason ? `by ${m.end_reason}` : "Result" }] : [],
  };
}

let match = store.matches.find((m) => m.id === matchId);
let game = null;       // chess.js instance for the current position
let cg = null;         // chessground board
let flipped = false;
let busy = null;       // the action being sent, if any
let pending = false;   // our move is on its way to the server
let lastFlagAt = 0; // when we last told the server a clock ran out
const canPost = profile.role === "commentator" || isStaff(profile.role);
let comments = [];

if (!match) {
  app.innerHTML = emptyState("Game not found", "This game may have been removed or belongs to a different edition.", `<a class="btn" href="fixtures.html">Back to fixtures</a>`);
} else {
  layout();
  update();
  animateIn(app);
  // Players come to play: bring their board fully into view.
  if (myColour()) {
    setTimeout(() => {
      const y = document.querySelector(".board-col").getBoundingClientRect().top + window.scrollY - 92;
      const lenis = getLenis();
      if (lenis) lenis.scrollTo(y, { duration: 1.2 });
      else window.scrollTo({ top: y, behavior: reduced ? "auto" : "smooth" });
    }, 700);
  }
  loadComments();
  // Realtime: redraw when this game changes.
  subscribe(() => {
    const fresh = store.matches.find((m) => m.id === matchId);
    if (fresh) {
      match = fresh;
      update();
    }
  });
  setInterval(tick, 200);
  window.addEventListener("resize", () => cg?.redrawAll());
}

// ---------------------------------------------------------------- derived state

function myColour() {
  return match.white_id === profile.id ? "white" : match.black_id === profile.id ? "black" : null;
}
function turnColour() {
  return game.turn() === "w" ? "white" : "black";
}
function status() {
  return effectiveStatus(match, serverNow());
}
function orientation() {
  const base = myColour() === "black" ? "black" : "white";
  return flipped ? (base === "white" ? "black" : "white") : base;
}
function myTurn() {
  return status() === "live" && myColour() === turnColour() && !pending && !busy;
}

function clocks() {
  const base = (store.tournament?.time_control_minutes ?? 10) * 60_000;
  const now = serverNow();
  if (match.status === "scheduled") {
    const started = match.scheduled_at && status() === "live" ? now - new Date(match.scheduled_at).getTime() : 0;
    return { white: base - started, black: base };
  }
  const w = match.white_ms ?? base;
  const b = match.black_ms ?? base;
  if (match.status === "completed" || !match.clock_started_at) return { white: w, black: b };
  const elapsed = now - new Date(match.clock_started_at).getTime();
  return turnColour() === "white" ? { white: w - elapsed, black: b } : { white: w, black: b - elapsed };
}

// ---------------------------------------------------------------- layout (once)

function layout() {
  app.innerHTML = `
    <div class="row wrap gap-4 mb-6" id="ctx"></div>
    <div class="grid lg-board">
      <div class="board-col">
        <div class="player-bar" id="bar-top"></div>
        <div class="board-frame">
          <div class="board" id="board"></div>
          <div class="board-overlay" id="overlay" hidden></div>
        </div>
        <div class="player-bar" id="bar-bottom"></div>
        <div id="error" class="mt-4"></div>
      </div>
      <aside class="stack gap-6">
        <div id="result"></div>
        <div id="controls"></div>
        <section class="panel pad-sm">
          <h2 class="small strong muted" style="padding:0.5rem 0.75rem">Moves</h2>
          <div id="moves"></div>
        </section>
        <div><button class="btn btn-ghost btn-sm" id="flip">${icon("arrows-down-up")} Flip board</button></div>
        <section class="panel" style="padding:1rem" id="commentary" hidden>
          <h2 class="small strong muted">Commentary</h2>
          <ul class="comments" id="comments"></ul>
          <form id="commentForm" class="row gap-2 mt-4" hidden>
            <label for="comment" class="sr-only">Add commentary</label>
            <input id="comment" class="input" maxlength="500" placeholder="Add a comment">
            <button class="btn btn-primary" type="submit" aria-label="Post">${icon("paper-plane-right", "fill")}</button>
          </form>
        </section>
      </aside>
    </div>`;

  cg = Chessground(document.getElementById("board"), {
    coordinates: true,
    animation: { duration: 180 },
    highlight: { lastMove: true, check: true },
    premovable: { enabled: false },
    draggable: { showGhost: true },
    movable: { free: false, showDests: true, events: { after: onMove } },
  });

  // Chessground remembers where the board sits on screen, but animations and
  // the header band can move it without a scroll or resize. Re-measure at
  // the start of every press, so clicks always land on the right square.
  const boardEl = document.getElementById("board");
  const remeasure = () => cg.state.dom.bounds.clear();
  ["mousedown", "touchstart", "pointerdown"].forEach((type) => boardEl.addEventListener(type, remeasure, { capture: true, passive: true }));
  document.fonts?.ready.then(() => cg.redrawAll());

  document.getElementById("flip").addEventListener("click", () => {
    flipped = !flipped;
    update();
  });
  app.addEventListener("click", onControlClick);
  document.getElementById("commentForm").addEventListener("submit", postComment);
}

// ---------------------------------------------------------------- redraw on every change

function update() {
  game = gameFromMatch(match);
  const history = game.history({ verbose: true });
  const last = history[history.length - 1];
  const mine = myColour();

  cg.set({
    fen: match.fen,
    orientation: orientation(),
    turnColor: turnColour(),
    lastMove: last ? [last.from, last.to] : undefined,
    check: game.isCheck() ? turnColour() : false,
    movable: { color: myTurn() ? mine : undefined, dests: myTurn() ? legalDests(game) : new Map() },
  });

  document.getElementById("ctx").innerHTML = `
    <a href="fixtures.html" class="small muted row gap-1">${icon("arrow-left")} Fixtures</a>
    <span class="small dim">${esc(matchContext(match))}</span>
    ${status() === "live" ? liveTag() : ""}
    ${match.scheduled_at ? `<span class="small dim">${formatDateTime(match.scheduled_at)}</span>` : ""}`;

  // Overlays: before the start, or when the players aren't known yet.
  const overlay = document.getElementById("overlay");
  if (!match.white_id || !match.black_id) {
    overlay.hidden = false;
    overlay.innerHTML = `<p class="muted">Players for this game are decided by earlier rounds.</p>`;
  } else if (status() === "scheduled" && match.scheduled_at && new Date(match.scheduled_at).getTime() > serverNow()) {
    overlay.hidden = false;
    if (!overlay.querySelector("[data-countdown]")) {
      overlay.innerHTML = `<div><p class="muted">The board unlocks in</p>
        <div class="row mt-4" style="justify-content:center">${countdownHtml(match.scheduled_at, { big: true })}</div>
        <p class="small dim mt-4">Starts at ${formatTime(match.scheduled_at)}.${mine === "white" ? " You have white, so your clock starts right away." : ""}</p></div>`;
    }
  } else {
    overlay.hidden = true;
    overlay.innerHTML = "";
  }

  renderResult();
  renderControls();
  renderMoves(history.map((h) => h.san));
  tick();
}

function playerBar(colour, ms, active) {
  const id = colour === "white" ? match.white_id : match.black_id;
  const p = id ? store.profileById.get(id) : null;
  return `<div class="who">
      <span class="colour-dot ${colour}" aria-label="${colour}"></span>
      <span class="truncate" style="font-weight:500">${p ? esc(p.full_name) : "To be decided"}</span>
      ${p ? `<span class="num small dim">${p.rating}</span>` : ""}
    </div>
    <span class="clock${active ? " active" : ""}${active && ms < 30_000 ? " low" : ""}" role="timer">${formatClock(ms)}</span>`;
}

// Runs 5 times a second: clocks, and claiming a win when time runs out.
function tick() {
  if (!match || !game) return;
  const c = clocks();
  const live = status() === "live";
  const top = orientation() === "white" ? "black" : "white";
  const bottom = top === "white" ? "black" : "white";
  document.getElementById("bar-top").innerHTML = playerBar(top, c[top], live && turnColour() === top);
  document.getElementById("bar-bottom").innerHTML = playerBar(bottom, c[bottom], live && turnColour() === bottom);

  // A player's or staff member's screen tells the server, so a game with an
  // absent player still ends.
  const canFlag = Boolean(myColour()) || isStaff(profile.role);
  // Our clock and the server's can differ by a moment, so if the server
  // says there's still time, try again shortly rather than giving up.
  if (live && canFlag && c[turnColour()] <= 0 && !busy && Date.now() - lastFlagAt > 3000) {
    lastFlagAt = Date.now();
    act("flag", {}, { quiet: true });
  }

  // The board unlocks by itself when the countdown ends.
  const overlay = document.getElementById("overlay");
  if (!overlay.hidden && overlay.querySelector("[data-countdown]") && live) update();
}

function renderResult() {
  const el = document.getElementById("result");
  if (match.status !== "completed") {
    el.innerHTML = "";
    return;
  }
  const name = (id) => (id ? esc(store.profileById.get(id)?.full_name ?? "") : "");
  const winner = match.winner_id ? name(match.winner_id) : "";
  const knockoutDraw = match.stage !== "group" && match.result === "1/2-1/2";
  const delta = (label, v) => `<span class="grow"><span class="truncate dim" style="display:block">${label}</span><span class="num strong ${v < 0 ? "signal" : ""}">${v > 0 ? `+${v}` : v}</span></span>`;
  el.innerHTML = `<section class="panel" style="padding:1.25rem">
    <p class="small muted">Final result</p>
    <p class="num chrome-text mt-1" style="font-size:var(--text-3xl);font-weight:600">${resultText(match)}</p>
    <p class="small muted mt-2">${match.result === "1/2-1/2" ? "Drawn" : `${winner || "Winner"} wins`}${match.end_reason ? ` by ${esc(match.end_reason)}` : ""}.</p>
    ${knockoutDraw && !winner ? `<p class="small dim mt-2">Knockout games need a winner. The moderators will record the tiebreak.</p>` : ""}
    ${knockoutDraw && winner ? `<p class="small dim mt-2">${winner} advances on tiebreak.</p>` : ""}
    ${match.white_rating_delta != null ? `<div class="row gap-6 mt-4 small">${delta(name(match.white_id) || "White", match.white_rating_delta)}${delta(name(match.black_id) || "Black", match.black_rating_delta ?? 0)}</div>` : ""}
  </section>`;
}

function renderControls() {
  const el = document.getElementById("controls");
  const mine = myColour();
  if (status() !== "live") {
    el.innerHTML = "";
    return;
  }
  if (!mine) {
    el.innerHTML = match.draw_offer_by ? notice("A draw has been offered.") : "";
    return;
  }
  const opponent = mine === "white" ? match.black_id : match.white_id;
  const offerFromOpponent = match.draw_offer_by && match.draw_offer_by === opponent;
  const offeredByMe = match.draw_offer_by === profile.id;
  const line = myTurn() ? "Your move." : pending || busy === "move" ? "Sending your move..." : "Waiting for your opponent.";
  el.innerHTML = `<section class="panel" style="padding:1.25rem">
    <p class="small muted">${line}</p>
    ${offerFromOpponent
      ? `<div class="notice mt-4"><p class="small" style="color:var(--fg)">Your opponent offers a draw.</p>
          <div class="row gap-2 mt-3">
            <button class="btn btn-primary btn-sm" data-act="accept_draw">Accept draw</button>
            <button class="btn btn-sm" data-act="decline_draw">Decline</button>
          </div></div>`
      : ""}
    <div class="row wrap gap-2 mt-4">
      <button class="btn btn-sm" data-act="offer_draw" ${offeredByMe || offerFromOpponent ? "disabled" : ""}>${icon("handshake")} ${offeredByMe ? "Draw offered" : "Offer draw"}</button>
      <button class="btn btn-danger btn-sm" data-resign>${icon("flag")} Resign</button>
    </div>
  </section>`;
}

function renderMoves(sans) {
  const el = document.getElementById("moves");
  if (!sans.length) {
    el.innerHTML = `<p class="small dim" style="padding:0 0.75rem 0.75rem">No moves yet.</p>`;
    return;
  }
  let html = "";
  for (let i = 0; i < sans.length; i += 2) {
    const lastPair = i + 2 >= sans.length;
    html += `<span class="n">${i / 2 + 1}.</span><span class="${lastPair && !sans[i + 1] ? "current" : ""}">${esc(sans[i])}</span><span class="${lastPair && sans[i + 1] ? "current" : ""}">${esc(sans[i + 1] ?? "")}</span>`;
  }
  el.innerHTML = `<div class="moves">${html}</div>`;
  const list = el.firstElementChild;
  list.scrollTop = list.scrollHeight;
}

// ---------------------------------------------------------------- actions

// quiet: background actions (the timeout claim) never show errors.
async function act(action, extra = {}, { quiet = false } = {}) {
  busy = action;
  if (!quiet) document.getElementById("error").innerHTML = "";
  try {
    const res = await callFunction("game", { action, match_id: match.id, ...extra });
    upsertMatch(res.match);
    match = res.match;
  } catch (err) {
    if (!quiet) document.getElementById("error").innerHTML = notice(esc(err.message), "error");
  } finally {
    busy = null;
    pending = false;
    update();
  }
}

function onMove(from, to) {
  const piece = game.get(from);
  const promotion = piece?.type === "p" && (to[1] === "8" || to[1] === "1");
  if (promotion) {
    choosePromotion(from, to);
    return;
  }
  sendMove(from, to);
}

function sendMove(from, to, promotion) {
  pending = true;
  renderControls();
  act("move", { from, to, promotion });
}

function choosePromotion(from, to) {
  const glyphs = myColour() === "black" ? { q: "♛", r: "♜", b: "♝", n: "♞" } : { q: "♕", r: "♖", b: "♗", n: "♘" };
  const names = { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" };
  const d = openModal(
    "Promote pawn to",
    `<div class="promo-grid">${Object.keys(glyphs).map((k) => `<button data-promo="${k}"><span aria-hidden="true">${glyphs[k]}</span><small>${names[k]}</small></button>`).join("")}</div>`,
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

function onControlClick(e) {
  const a = e.target.closest("[data-act]");
  if (a) {
    act(a.dataset.act);
    return;
  }
  if (e.target.closest("[data-resign]")) {
    const d = openModal(
      "Resign this game?",
      `<p class="muted">Your opponent wins this game. This can't be undone.</p>
       <div class="modal-actions"><button class="btn" data-close>Keep playing</button><button class="btn btn-danger" data-confirm>Resign</button></div>`,
    );
    d.querySelector("[data-confirm]").addEventListener("click", async () => {
      d.close();
      await act("resign");
    });
  }
}

// ---------------------------------------------------------------- commentary

async function loadComments() {
  const { data } = await supabase.from("match_comments").select("*").eq("match_id", matchId).order("created_at");
  comments = data ?? [];
  renderComments();
  supabase
    .channel(`comments-${matchId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "match_comments", filter: `match_id=eq.${matchId}` }, (p) => {
      if (!comments.some((c) => c.id === p.new.id)) comments.push(p.new);
      renderComments();
    })
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "match_comments" }, (p) => {
      comments = comments.filter((c) => c.id !== p.old.id);
      renderComments();
    })
    .subscribe();
}

function renderComments() {
  const section = document.getElementById("commentary");
  section.hidden = !canPost && !comments.length;
  document.getElementById("commentForm").hidden = !canPost;
  const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const list = document.getElementById("comments");
  list.innerHTML = comments.length
    ? comments
        .map((c) => `<li><span class="xs dim">${esc(store.profileById.get(c.author_id)?.full_name ?? "Commentator")} · ${time(c.created_at)}</span><p class="mt-1">${esc(c.body)}</p></li>`)
        .join("")
    : `<li class="dim">No commentary yet.</li>`;
  list.scrollTop = list.scrollHeight;
}

async function postComment(e) {
  e.preventDefault();
  const input = document.getElementById("comment");
  const body = input.value.trim();
  if (!body) return;
  const { data, error } = await supabase.from("match_comments").insert({ match_id: matchId, author_id: profile.id, body }).select("*").single();
  if (error) {
    alert(error.message);
    return;
  }
  input.value = "";
  if (!comments.some((c) => c.id === data.id)) comments.push(data);
  renderComments();
}
