// The Control Room: the organisers' side of the portal. Live boards with
// arbiter tools, editions and autopilot, accounts, the group draw, fixtures
// and results, the knockout bracket, and the activity log. Moderators get
// everything except accounts.

import { ROLE_LABEL } from "../auth.js";
import { callFunction, supabase } from "../supabase.js";
import { store, loadAll, loadEmails, subscribe, sortByTime, STAGE_LABEL, effectiveStatus, matchContext, baseClocks, bracketGames, isKnockout, isFriendly, tournamentMode } from "../store.js";
import { formatClock, formatDateTime, formatTime, fromLocalInput, serverNow, toLocalInput } from "../time.js";
import { TIEBREAK_NOTE } from "../standings.js";
import {
  clearGroups, createTournament, generateGroupFixtures, generateKnockout, qualifiers, R16_PAIRINGS,
  createFriendly, deleteMatch, resetGame, setTournamentRated, resetRealTestGames, scheduleRound, seededDraw, sendMessage, simulateGames, setActiveTournament, setGroupSlot, updateMatch, updateTournament,
} from "../ops.js";
import { emptyState, esc, icon, liveTag, modalOpen, notice, openModal, playerHtml, statusHtml, withBusy } from "../ui.js";
import { mountMiniBoards } from "../board.js";
import { KIND_ICON, timeAgo } from "../notify.js";
import { startPage } from "../page.js";
import { animateIn } from "../motion.js";

const TABS = [
  { id: "live", label: "Live" },
  { id: "tournament", label: "Tournament" },
  { id: "registrations", label: "Registrations", admin: true },
  { id: "people", label: "People" },
  { id: "groups", label: "Groups" },
  { id: "matches", label: "Matches" },
  { id: "knockout", label: "Knockout" },
  { id: "activity", label: "Activity" },
];
const ROLES = ["player", "moderator", "commentator", "admin"];
// Registration form: answer types, and whether the form is open.
const FIELD_TYPES = [
  ["text", "Short answer"],
  ["textarea", "Long answer"],
  ["email", "Email"],
  ["tel", "Phone number"],
  ["number", "Number"],
  ["date", "Date"],
  ["choice", "Choose one"],
  ["checkbox", "Tick box"],
];
const REG_STATUS = { soon: "Coming soon", open: "Open", closed: "Closed" };
const STATUS_LABEL = { setup: "Setting up", groups: "Group stage", knockout: "Knockout stage", complete: "Complete" };
const ROUNDS = [
  { key: "g1", label: "Group round 1", test: (m) => m.stage === "group" && m.round === 1 },
  { key: "g2", label: "Group round 2", test: (m) => m.stage === "group" && m.round === 2 },
  { key: "g3", label: "Group round 3", test: (m) => m.stage === "group" && m.round === 3 },
  { key: "r16", label: STAGE_LABEL.r16, test: (m) => m.stage === "r16" },
  { key: "qf", label: "Quarterfinals", test: (m) => m.stage === "qf" },
  { key: "sf", label: "Semifinals", test: (m) => m.stage === "sf" },
  { key: "final", label: STAGE_LABEL.final, test: (m) => m.stage === "final" },
  { key: "friendly", label: "Friendlies", test: (m) => m.stage === "friendly" },
];

// View state that survives redraws, plus what the Live and Activity tabs
// watch: who is in which game room, and the fair-play log.
const ui = {
  roleFilter: "all",
  query: "",
  round: "g1",
  testMsg: "",
  // Registrations tab
  regs: null,
  regFilter: "new",
  regQuery: "",
  regSelected: new Set(),
  formDraft: null,
  formDraftFor: null,
  formDirty: false,
};
const watch = { presence: new Map(), goneSince: new Map(), events: [], notes: [], loaded: false, botAsked: new Map(), drawTimer: null, lastDraw: 0 };
// How the fair-play log reads.
const EVENT_TEXT = {
  joined: "opened the game room",
  tab_hidden: "left the game tab",
  tab_visible: "came back to the game tab",
  resign: "resigned",
  draw_offered: "offered a draw",
  draw_declined: "declined a draw",
  draw_agreed: "agreed a draw",
  paused: "paused the game",
  resumed: "resumed the game",
  time_added: "adjusted a clock",
  takeback: "took back a move",
  adjudicated: "adjudicated the game",
  game_over: "Game over",
};


const { profile, app, redrawHero } = await startPage("admin", { staff: true, hero });

// Header band: compact, with the numbers that matter to organisers.
function hero(p) {
  const games = bracketGames(store.matches);
  const now = serverNow();
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").length;
  return {
    scene: "path",
    compact: true,
    eyebrow: `Control room · ${p.role === "admin" ? "Admin" : "Moderator"}`,
    bold: "Run the",
    soft: "tournament.",
    lede:
      p.role === "admin"
        ? "Live boards and arbiter tools, accounts, the draw, fixtures, results and the bracket. Switch to Portal to see what players see."
        : "Live boards and arbiter tools, the draw, fixtures, results and the bracket. Accounts are managed by admins.",
    stats: [
      { value: live, label: "Live now", live: live > 0 },
      { value: store.profiles.filter((x) => x.role === "player").length, label: "Players" },
      { value: games.filter((m) => m.status === "completed").length, label: `of ${games.length} played` },
    ],
  };
}
const isAdmin = profile.role === "admin";

function currentTab() {
  const id = location.hash.slice(1);
  return visibleTabs().some((t) => t.id === id) ? id : store.tournament ? "live" : "tournament";
}

// Registrations are admin-only (they create accounts).
function visibleTabs() {
  return TABS.filter((t) => !t.admin || profile.role === "admin");
}

function draw() {
  const tab = currentTab();
  const fresh = (ui.regs ?? []).filter((r) => r.status === "new").length;
  const tabs = `<nav class="tabs" aria-label="Admin sections">${visibleTabs()
    .map((t) => `<a class="tab${t.id === tab ? " active" : ""}" href="#${t.id}">${t.label}${t.id === "registrations" && fresh ? ` <span class="tab-count">${fresh}</span>` : ""}</a>`)
    .join("")}</nav>`;
  const body = { live: liveTab, tournament: tournamentTab, registrations: registrationsTab, people: peopleTab, groups: groupsTab, matches: matchesTab, knockout: knockoutTab, activity: activityTab }[tab]();
  app.innerHTML = tabs + (store.error ? notice(esc(store.error), "error") : "") + testBanner(tab) + body;
  if (tab === "live") mountMiniBoards(app);
}

async function refresh() {
  await loadAll();
  if (isAdmin) await loadEmails();
  redrawHero();
  draw();
}

if (isAdmin) await loadEmails();
draw();
animateIn(app);
window.addEventListener("hashchange", draw);
// Live updates, unless someone is in the middle of typing or a dialog.
function calmDraw() {
  const typing = app.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!modalOpen() && !typing) draw();
}
// Live games change many times a second; redraw at most every 0.7 s.
function scheduleDraw() {
  if (watch.drawTimer) return;
  const wait = Math.max(0, 700 - (Date.now() - watch.lastDraw));
  watch.drawTimer = setTimeout(() => {
    watch.drawTimer = null;
    watch.lastDraw = Date.now();
    calmDraw();
  }, wait);
}
subscribe(scheduleDraw);
startWatching();
// Clocks on the Live tab tick every second; the tab redraws every 15.
setInterval(tickLiveClocks, 1000);
setInterval(() => {
  redrawHero();
  if (currentTab() === "live") calmDraw();
}, 15_000);

// ---------------------------------------------------------------- live watch: presence and the fair-play log

async function startWatching() {
  const [ev, notes] = await Promise.all([
    supabase.from("game_events").select("*").order("created_at", { ascending: false }).limit(150),
    supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(60),
  ]);
  watch.events = ev.data ?? [];
  watch.notes = notes.data ?? [];
  watch.loaded = true;

  // The Arena pages announce who is in which game room.
  const ch = supabase.channel("arena-presence");
  ch.on("presence", { event: "sync" }, () => {
    const map = new Map();
    for (const metas of Object.values(ch.presenceState())) {
      for (const meta of metas) {
        if (!meta.match_id) continue;
        const key = `${meta.user_id}:${meta.match_id}`;
        map.set(key, { visible: Boolean(map.get(key)?.visible || meta.visible) });
      }
    }
    watch.presence = map;
    if (currentTab() === "live") scheduleDraw();
  });
  ch.subscribe();

  supabase
    .channel("control-log")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "game_events" }, (p) => {
      watch.events.unshift(p.new);
      if (["live", "activity"].includes(currentTab())) scheduleDraw();
    })
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (p) => {
      watch.notes.unshift(p.new);
      if (currentTab() === "activity") scheduleDraw();
    })
    .subscribe();
  if (["live", "activity"].includes(currentTab())) calmDraw();
}

// "on" (in the game room), "away" (tab hidden) or "off", for a player in a game.
function presenceOf(userId, matchId) {
  const key = `${userId}:${matchId}`;
  const p = watch.presence.get(key);
  if (p) {
    watch.goneSince.delete(key);
    return p.visible ? "on" : "away";
  }
  if (!watch.goneSince.has(key)) watch.goneSince.set(key, Date.now());
  return "off";
}

// Not in the game room for over a minute while their game is live.
function offline(userId, matchId) {
  if (store.profileById.get(userId)?.is_bot) return false;
  const gone = watch.goneSince.get(`${userId}:${matchId}`);
  return presenceOf(userId, matchId) === "off" && gone && Date.now() - gone > 60_000;
}

function liveClocks(m) {
  const base = baseClocks(m);
  const now = serverNow();
  if (m.status === "scheduled") return { white: base.white - Math.max(0, now - new Date(m.scheduled_at).getTime()), black: base.black, turn: "white" };
  const turn = (m.fen.split(" ")[1] ?? "w") === "w" ? "white" : "black";
  const w = m.white_ms ?? base.white;
  const b = m.black_ms ?? base.black;
  if (m.paused_at || !m.clock_started_at || m.status === "completed") return { white: w, black: b, turn };
  const el = now - new Date(m.clock_started_at).getTime();
  return turn === "white" ? { white: w - el, black: b, turn } : { white: w, black: b - el, turn };
}

// Test bots move while the Live tab is open, as they do in the Arena. The
// server picks each move; this only asks, about once a second per game.
function driveBots() {
  const now = serverNow();
  let asked = 0;
  for (const m of store.matches) {
    if (asked >= 8) break;
    if (effectiveStatus(m, now) !== "live" || m.paused_at || !m.white_id || !m.black_id) continue;
    const toMove = (m.fen.split(" ")[1] ?? "w") === "w" ? m.white_id : m.black_id;
    if (!store.profileById.get(toMove)?.is_bot) continue;
    const last = watch.botAsked.get(m.id);
    if (last && (Date.now() - last.at < 1200 || (last.ply === m.move_count && Date.now() - last.at < 5000))) continue;
    watch.botAsked.set(m.id, { ply: m.move_count, at: Date.now() });
    asked += 1;
    callFunction("game", { action: "bot_move", match_id: m.id }).catch(() => {});
  }
}

function tickLiveClocks() {
  if (currentTab() !== "live") return;
  driveBots();
  app.querySelectorAll("[data-live-clock]").forEach((el) => {
    const m = store.matches.find((x) => x.id === el.dataset.liveClock);
    if (!m) return;
    const c = liveClocks(m)[el.dataset.colour];
    el.textContent = formatClock(c);
    el.classList.toggle("low", c < 30_000);
  });
}

// ---------------------------------------------------------------- live tab

function liveTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first.");
  const now = serverNow();
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").sort(sortByTime);
  const soon = store.matches
    .filter((m) => m.status === "scheduled" && m.scheduled_at && new Date(m.scheduled_at).getTime() > now && new Date(m.scheduled_at).getTime() - now < 3 * 3600_000)
    .sort(sortByTime);
  const recent = store.matches
    .filter((m) => m.status === "completed" && m.ended_at && now - new Date(m.ended_at).getTime() < 6 * 3600_000)
    .sort((a, b) => new Date(b.ended_at) - new Date(a.ended_at))
    .slice(0, 8);
  const first = (id) => esc(store.profileById.get(id)?.full_name.split(" ")[0] ?? "?");

  const who = (m, colour) => {
    const id = colour === "white" ? m.white_id : m.black_id;
    const pres = presenceOf(id, m.id);
    const c = liveClocks(m);
    const turn = c.turn === colour && !m.paused_at;
    return `<div class="ctl-player${turn ? " turn" : ""}">
      ${store.profileById.get(id)?.is_bot ? "" : `<span class="presence ${pres}" title="${pres === "on" ? "In the game room" : pres === "away" ? "Tab hidden" : "Not in the game room"}"></span>`}
      <span class="grow truncate">${esc(store.profileById.get(id)?.full_name ?? "?")}</span>
      <span class="ctl-clock num${c[colour] < 30_000 ? " low" : ""}" data-live-clock="${m.id}" data-colour="${colour}">${formatClock(c[colour])}</span>
    </div>`;
  };

  const alertsFor = (m) => {
    const hidden = watch.events.filter((e) => e.match_id === m.id && e.kind === "tab_hidden").length;
    const out = [];
    if (m.paused_at) out.push(`<span class="ctl-alert">${icon("pause", "bold")} Paused</span>`);
    if (m.draw_offer_by) out.push(`<span class="ctl-alert soft">${icon("handshake", "bold")} Draw offered</span>`);
    if (hidden) out.push(`<span class="ctl-alert">${icon("eye-slash", "bold")} ${hidden} tab switch${hidden === 1 ? "" : "es"}</span>`);
    for (const id of [m.white_id, m.black_id]) {
      if (offline(id, m.id)) out.push(`<span class="ctl-alert">${icon("wifi-slash", "bold")} ${first(id)} offline</span>`);
    }
    return out.join("");
  };

  const card = (m) => `<article class="panel ctl-card">
    <div class="ctl-head"><span class="xs dim truncate">${esc(matchContext(m))}</span><span class="row gap-2">${liveTag()}<span class="num xs dim">Move ${Math.ceil(m.move_count / 2) || 1}</span></span></div>
    ${who(m, "black")}
    <a class="mini-board ctl-board" href="play.html?id=${m.id}" data-mini-fen="${esc(m.fen)}" aria-label="Open ${first(m.white_id)} against ${first(m.black_id)}"></a>
    ${who(m, "white")}
    <div class="ctl-alerts">${alertsFor(m)}</div>
    <div class="ctl-actions">
      <a class="btn btn-sm btn-primary" href="play.html?id=${m.id}">${icon("gavel", "bold")} Arbiter view</a>
      <button class="icon-btn" data-game="${m.paused_at ? "resume" : "pause"}" data-id="${m.id}" aria-label="${m.paused_at ? "Resume" : "Pause"} this game" title="${m.paused_at ? "Resume" : "Pause"}">${icon(m.paused_at ? "play" : "pause", "bold")}</button>
      <button class="icon-btn" data-game="add_time" data-id="${m.id}" data-color="white" aria-label="Add 30 seconds for White" title="+30 s for White">+W</button>
      <button class="icon-btn" data-game="add_time" data-id="${m.id}" data-color="black" aria-label="Add 30 seconds for Black" title="+30 s for Black">+B</button>
    </div>
  </article>`;

  const soonRow = (m) => `<a href="play.html?id=${m.id}" class="admin-row">
    <div class="grow"><span class="xs dim" style="display:block;margin-bottom:0.25rem">${esc(matchContext(m))}, ${formatTime(m.scheduled_at)}</span>
      <span class="vs">${playerHtml(m.white_id)}<span class="xs dim">vs</span>${playerHtml(m.black_id)}</span></div>
    <span class="row gap-2 xs dim">${[m.white_id, m.black_id].map((id) => `<span class="presence ${presenceOf(id, m.id)}" style="position:static;border:0"></span>`).join("")}<span class="hide-sm">in the room</span></span>
    ${statusHtml(m)}
  </a>`;

  const t = store.tournament;
  return `<div class="stack gap-8">
    <div class="ctl-auto">
      <span class="strong">${icon("robot", "bold")} Autopilot</span>
      <span class="${tournamentMode() ? "on" : ""}">${tournamentMode() === "unrated" ? "Unrated tournament" : tournamentMode() === "rated" ? "Rated tournament" : "Rated or unrated: not chosen"}</span>
      <span class="${t.auto_tiebreak ? "on" : ""}">Armageddon tiebreaks ${t.auto_tiebreak ? "on" : "off"}</span>
      <span class="${t.auto_knockout ? "on" : ""}">Bracket after groups ${t.auto_knockout ? "on" : "off"}</span>
      <span class="on">Timeouts and no-shows</span>
      <span class="on">Reminders 10 min before</span>
      <a href="#tournament" class="ml-auto small">Settings ${icon("arrow-right")}</a>
    </div>
    <div data-err></div>
    <section>
      <h2 class="section-title mb-3">Live boards <span class="dim num">${live.length}</span></h2>
      ${live.length ? `<div class="grid sm-2 lg-3 xl-4 tight">${live.map(card).join("")}</div>` : `<div class="panel pad muted">No games are being played right now.</div>`}
    </section>
    <section>
      <h2 class="section-title mb-3">Starting in the next 3 hours</h2>
      ${soon.length ? `<div class="panel pad-sm">${soon.map(soonRow).join("")}</div>` : `<div class="panel pad muted">Nothing starting soon.</div>`}
    </section>
    ${recent.length
      ? `<section><h2 class="section-title mb-3">Just finished</h2><div class="panel pad-sm">${recent
          .map((m) => `<a href="play.html?id=${m.id}" class="admin-row"><div class="grow"><span class="xs dim" style="display:block;margin-bottom:0.25rem">${esc(matchContext(m))}${m.end_reason ? ` · ${esc(m.end_reason)}` : ""}</span><span class="vs">${playerHtml(m.white_id)}<span class="xs dim">vs</span>${playerHtml(m.black_id)}</span></div>${statusHtml(m)}<span></span></a>`)
          .join("")}</div></section>`
      : ""}
  </div>`;
}

// ---------------------------------------------------------------- activity tab


function activityTab() {
  if (!watch.loaded) return `<div class="skeleton" style="height:20rem"></div>`;
  const name = (id) => esc(store.profileById.get(id)?.full_name ?? "Someone");
  const gameLabel = (id) => {
    const m = store.matches.find((x) => x.id === id);
    if (!m) return "A game";
    const f = (pid) => esc(store.profileById.get(pid)?.full_name.split(" ")[0] ?? "?");
    return `${f(m.white_id)} v ${f(m.black_id)} · ${esc(matchContext(m))}`;
  };
  const events = watch.events
    .slice(0, 80)
    .map((e) => {
      let text = EVENT_TEXT[e.kind] ?? e.kind;
      if (e.kind === "time_added") text = `gave ${e.detail?.color} ${e.detail?.seconds > 0 ? "+" : ""}${e.detail?.seconds} s`;
      if (e.kind === "takeback") text = `took back ${e.detail?.san ?? "a move"}`;
      if (e.kind === "tab_visible" && e.detail?.away_ms) text += ` after ${Math.round(e.detail.away_ms / 1000)} s`;
      if (e.kind === "game_over") text = `Game over: ${e.detail?.result ?? ""}${e.detail?.reason ? ` (${e.detail.reason})` : ""}`;
      const warn = e.kind === "tab_hidden";
      return `<a class="feed-item" href="play.html?id=${e.match_id}"><span class="feed-icon"${warn ? ' style="color:#f5b94a"' : ""}>${icon(warn ? "eye-slash" : e.kind === "game_over" ? "flag-checkered" : "pulse", "bold")}</span>
        <span class="grow"><span class="feed-title">${e.kind === "game_over" ? "" : `${name(e.user_id)} `}${esc(text)}</span><span class="feed-body">${gameLabel(e.match_id)}</span><span class="feed-time">${timeAgo(e.created_at)}</span></span></a>`;
    })
    .join("");
  const notes = watch.notes
    .slice(0, 40)
    .map((n) => `<div class="feed-item"><span class="feed-icon">${icon(KIND_ICON[n.kind] ?? "bell", "bold")}</span><span class="grow"><span class="feed-title">${esc(n.title)}</span><span class="feed-body">To ${name(n.user_id)}${n.body ? `: ${esc(n.body)}` : ""}</span><span class="feed-time">${timeAgo(n.created_at)}</span></span></div>`)
    .join("");
  return `<div class="grid lg-hero">
    <section class="panel pad-sm feed-panel"><h2 class="eyebrow" style="padding:0.85rem 1rem 0.35rem">Game rooms and fair play</h2>${events || `<p class="small dim" style="padding:0.5rem 1rem 1rem">Nothing logged yet.</p>`}</section>
    <section class="panel pad-sm feed-panel"><h2 class="eyebrow" style="padding:0.85rem 1rem 0.35rem">Updates sent to players</h2>${notes || `<p class="small dim" style="padding:0.5rem 1rem 1rem">No updates sent yet.</p>`}</section>
  </div>`;
}

// ---------------------------------------------------------------- tournament tab

function tournamentTab() {
  const t = store.tournament;
  const form = t
    ? `<form class="panel pad form-grid md-2" data-form="edition">
        <div class="span-2"><h2 class="section-title">Current edition</h2><p class="small muted mt-1">Time control applies to games that haven't started yet.</p></div>
        <div class="field span-2"><label for="ed-name">Name</label><input class="input" id="ed-name" name="name" value="${esc(t.name)}" required></div>
        <div class="field"><label for="ed-min">Minutes per player</label><input class="input" id="ed-min" name="minutes" type="number" min="1" max="180" value="${t.time_control_minutes}"><p class="hint">Each player's clock at the start.</p></div>
        <div class="field"><label for="ed-inc">Increment (seconds)</label><input class="input" id="ed-inc" name="increment" type="number" min="0" max="60" value="${t.increment_seconds}"><p class="hint">Added after every move.</p></div>
        <div class="field"><label for="ed-status">Stage</label><select class="input" id="ed-status" name="status">${Object.entries(STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${v}</option>`).join("")}</select><p class="hint">Moves on by itself as you generate fixtures and the bracket.</p></div>
        <div class="span-2 row gap-3"><button class="btn btn-primary" type="submit">Save changes</button><span data-msg class="small muted"></span></div>
      </form>`
    : emptyState("Create this year's tournament", "Start an edition to get eight empty groups, ready for the draw.", `<button class="btn btn-primary" data-action="new-edition">${icon("plus", "bold")} New edition</button>`);

  const list = store.tournaments.length
    ? `<section>
        <div class="row between mb-3"><h2 class="section-title">All editions</h2><button class="btn btn-sm" data-action="new-edition">${icon("plus", "bold")} New edition</button></div>
        <div class="panel pad-sm">${store.tournaments
          .map(
            (x) => `<div class="row between gap-4" style="padding:0.75rem 1rem">
              <div><p style="font-weight:500">${esc(x.name)}</p><p class="small dim">${STATUS_LABEL[x.status]}</p></div>
              ${x.is_active ? `<span class="badge">Active</span>` : `<button class="btn btn-ghost btn-sm" data-action="activate" data-id="${x.id}">Make active</button>`}
            </div>`,
          )
          .join("")}</div>
        <p class="small dim mt-2">Everyone sees the active edition. Earlier years stay here as a record.</p>
      </section>`
    : "";
  const autopilot = t
    ? `<form class="panel pad form-grid md-2" data-form="autopilot">
        <div class="span-2"><h2 class="section-title">${icon("robot", "bold")} Autopilot</h2><p class="small muted mt-1">What the tournament does by itself. Timeouts, no-shows, ratings, standings, advancement and reminders always run.</p></div>
        <label class="row gap-3 span-2" style="cursor:pointer"><input type="checkbox" name="auto_tiebreak" ${t.auto_tiebreak ? "checked" : ""} style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2"><span><span class="strong small" style="display:block">Armageddon tiebreaks</span><span class="hint">When a knockout game is drawn, create an Armageddon game with colours reversed: White 5 min, Black 4 min, +2 s. Black goes through on a draw.</span></span></label>
        <label class="row gap-3 span-2" style="cursor:pointer"><input type="checkbox" name="auto_knockout" ${t.auto_knockout ? "checked" : ""} style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2"><span><span class="strong small" style="display:block">Build the bracket after the groups</span><span class="hint">When the last group game ends, the round of 16 is drawn from the final tables.</span></span></label>
        <div class="field"><label for="ap-delay">Armageddon starts after (minutes)</label><input class="input" id="ap-delay" name="delay" type="number" min="1" max="1440" value="${t.tiebreak_delay_minutes}"></div>
        <div class="field"><label for="ap-draw">Draw offers allowed from move</label><input class="input" id="ap-draw" name="draw_min" type="number" min="0" max="100" value="${t.draw_offer_min_moves}"><p class="hint">0 allows draw offers at any time.</p></div>
        <div class="span-2 row gap-3"><button class="btn btn-primary" type="submit">Save autopilot</button><span data-msg class="small muted"></span></div>
      </form>
      <form class="panel pad stack gap-4" data-form="broadcast">
        <div><h2 class="section-title">${icon("megaphone", "bold")} Message everyone</h2><p class="small muted mt-1">Appears in every player's updates straight away, with a sound.</p></div>
        <div class="field"><label for="bc-title">Title</label><input class="input" id="bc-title" name="title" maxlength="80" required placeholder="Round 2 starts at 4 pm"></div>
        <div class="field"><label for="bc-body">Message</label><textarea class="input" id="bc-body" name="body" rows="3" maxlength="400" placeholder="Optional details"></textarea></div>
        <div class="field"><label for="bc-to">Send to</label><select class="input" id="bc-to" name="to"><option value="players">All players</option><option value="everyone">Everyone with an account</option></select></div>
        <div class="row gap-3"><button class="btn btn-primary" type="submit">${icon("paper-plane-right", "bold")} Send</button><span data-msg class="small muted"></span></div>
      </form>`
    : "";
  return `<div class="stack gap-8">${form}${t ? modeChooser({ full: false }) : ""}${autopilot}${list}</div>`;
}

function newEditionModal() {
  // The edition after the latest one (the first is this year).
  const latest = Math.max(0, ...store.tournaments.map((x) => x.year));
  const year = latest ? latest + 1 : new Date().getFullYear();
  const d = openModal(
    "New edition",
    `<form class="stack gap-4" data-form="new-edition">
      <div class="field"><label for="ne-year">Year</label><input class="input" id="ne-year" name="year" type="number" value="${year}" required></div>
      <div class="field"><label for="ne-name">Name</label><input class="input" id="ne-name" name="name" value="Amaze Youth Chess Tournament ${year}" required></div>
      <div class="two-col">
        <div class="field"><label for="ne-min">Minutes each</label><input class="input" id="ne-min" name="minutes" type="number" min="1" max="180" value="10"></div>
        <div class="field"><label for="ne-inc">Increment (s)</label><input class="input" id="ne-inc" name="increment" type="number" min="0" max="60" value="5"></div>
      </div>
      <p class="small dim">The new edition becomes the active one, with eight empty groups (A to H).</p>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create edition</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
  form.year.addEventListener("input", () => (form.name.value = `Amaze Youth Chess Tournament ${form.year.value}`));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withBusy(form.querySelector("[type=submit]"), async () => {
      await createTournament({
        name: form.name.value.trim(),
        year: Number(form.year.value),
        time_control_minutes: Number(form.minutes.value),
        increment_seconds: Number(form.increment.value),
      });
      d.close();
      location.hash = "tournament";
      await refresh();
    }, d.querySelector("[data-err]"));
  });
}

// ---------------------------------------------------------------- people tab

function peopleTab() {
  const counts = { all: store.profiles.length };
  for (const p of store.profiles) counts[p.role] = (counts[p.role] ?? 0) + 1;
  const q = ui.query.toLowerCase();
  const visible = store.profiles.filter(
    (p) => (ui.roleFilter === "all" || p.role === ui.roleFilter) && (!q || `${p.full_name} ${p.email ?? ""} ${p.school ?? ""}`.toLowerCase().includes(q)),
  );
  const chips = ["all", ...ROLES]
    .map((r) => `<button class="chip${ui.roleFilter === r ? " active" : ""}" data-action="role-filter" data-role="${r}">${r === "all" ? "Everyone" : `${ROLE_LABEL[r]}s`}<span class="count">${counts[r] ?? 0}</span></button>`)
    .join("");

  const table = visible.length
    ? `<div class="panel table-wrap"><table class="table" style="min-width:720px">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="r">Rating</th><th style="width:9rem"></th></tr></thead>
        <tbody>${visible
          .map(
            (p) => `<tr>
              <td><span style="font-weight:500">${esc(p.full_name)}</span>${p.school ? `<span class="xs dim" style="display:block">${esc(p.school)}</span>` : ""}</td>
              <td class="muted">${esc(p.email)}</td>
              <td>${ROLE_LABEL[p.role]}</td>
              <td class="r num">${p.role === "player" ? p.rating : "-"}</td>
              <td class="r">${p.role === "player" ? `<a class="icon-btn" href="home.html?player=${p.id}" aria-label="View ${esc(p.full_name)}'s dashboard" title="View their dashboard">${icon("eye")}</a>` : ""}${isAdmin
                ? `<button class="icon-btn" data-action="edit-person" data-id="${p.id}" aria-label="Edit ${esc(p.full_name)}">${icon("pencil-simple")}</button>${p.id !== profile.id ? `<button class="icon-btn danger" data-action="delete-person" data-id="${p.id}" aria-label="Delete ${esc(p.full_name)}">${icon("trash")}</button>` : ""}`
                : ""}</td>
            </tr>`,
          )
          .join("")}</tbody></table></div>`
    : emptyState("Nobody here yet", isAdmin ? "Add players, moderators and commentators. Each gets an email and password to sign in with." : "No accounts match.");

  return `<div class="stack gap-6">
    ${!isAdmin ? notice("Only admins can add or change accounts. You can see everyone here.") : ""}
    <div class="split">
      <div class="chips" style="margin-bottom:0">${chips}</div>
      <div class="row gap-2">
        <div class="search">${icon("magnifying-glass")}<label for="people-search" class="sr-only">Search people</label><input id="people-search" class="input" placeholder="Search name, email, school" value="${esc(ui.query)}" data-input="search"></div>
        ${isAdmin ? `<button class="btn btn-primary" data-action="add-person">${icon("plus", "bold")} Add person</button>` : ""}
      </div>
    </div>
    ${table}
  </div>`;
}

function personModal(person) {
  const d = openModal(
    person ? `Edit ${person.full_name}` : "Add a person",
    `<form class="stack gap-4" data-form="person">
      <div class="field"><label for="pf-name">Full name</label><input class="input" id="pf-name" name="full_name" value="${esc(person?.full_name ?? "")}" required></div>
      <div class="field"><label for="pf-email">Email</label><input class="input" id="pf-email" name="email" type="email" value="${esc(person?.email ?? "")}" required><p class="hint">They sign in with this.</p></div>
      <div class="field"><label for="pf-pass">${person ? "New password" : "Password"}</label><input class="input" id="pf-pass" name="password" type="text" autocomplete="new-password" ${person ? "" : "required"} minlength="8"><p class="hint">${person ? "Leave empty to keep their current password." : "At least 8 characters. Share it with them privately."}</p></div>
      <div class="two-col">
        <div class="field"><label for="pf-role">Role</label><select class="input" id="pf-role" name="role">${ROLES.map((r) => `<option value="${r}" ${r === (person?.role ?? "player") ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select></div>
        <div class="field"><label for="pf-rating">Rating</label><input class="input" id="pf-rating" name="rating" type="number" min="0" max="3500" value="${person?.rating ?? 1000}"></div>
      </div>
      <div class="field"><label for="pf-school">School or club</label><input class="input" id="pf-school" name="school" value="${esc(person?.school ?? "")}"><p class="hint">Optional. Shown on the leaderboard.</p></div>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${person ? "Save changes" : "Create account"}</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
  const syncRating = () => (form.rating.disabled = form.role.value !== "player");
  form.role.addEventListener("change", syncRating);
  syncRating();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withBusy(form.querySelector("[type=submit]"), async () => {
      await callFunction("admin-users", {
        action: person ? "update" : "create",
        id: person?.id,
        full_name: form.full_name.value,
        email: form.email.value,
        password: form.password.value || undefined,
        role: form.role.value,
        rating: Number(form.rating.value),
        school: form.school.value,
      });
      d.close();
      await refresh();
    }, d.querySelector("[data-err]"));
  });
}

function deletePersonModal(person) {
  const d = openModal(
    `Delete ${person.full_name}?`,
    `<p class="muted">Their sign-in is removed and they leave any group they were drawn into. Games they already played keep their result but lose the name. This can't be undone.</p>
     <div data-err class="mt-4"></div>
     <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-confirm>Delete account</button></div>`,
  );
  const btn = d.querySelector("[data-confirm]");
  btn.addEventListener("click", () =>
    withBusy(btn, async () => {
      await callFunction("admin-users", { action: "delete", id: person.id });
      d.close();
      await refresh();
    }, d.querySelector("[data-err]")),
  );
}

// ---------------------------------------------------------------- groups tab

function playerPool() {
  return store.profiles.filter((p) => p.role === "player").sort((a, b) => b.rating - a.rating);
}

function groupsTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first, then draw its groups here.");
  const players = playerPool();
  const placed = new Set(store.groupPlayers.map((gp) => gp.player_id));
  const hasFixtures = store.matches.some((m) => m.stage === "group");

  const groups = store.groups
    .map((g) => {
      const slots = [1, 2, 3, 4]
        .map((seed) => {
          const current = store.groupPlayers.find((gp) => gp.group_id === g.id && gp.seed === seed);
          const options = players
            .filter((p) => p.id === current?.player_id || !placed.has(p.id))
            .map((p) => `<option value="${p.id}" ${p.id === current?.player_id ? "selected" : ""}>${esc(p.full_name)} (${p.rating})</option>`)
            .join("");
          return `<div class="slot"><span class="pot" title="Pot ${seed}">P${seed}</span>
            <label class="sr-only" for="slot-${g.id}-${seed}">Group ${g.label}, pot ${seed}</label>
            <select class="input sm" id="slot-${g.id}-${seed}" data-slot data-group="${g.id}" data-seed="${seed}"><option value="">Empty</option>${options}</select></div>`;
        })
        .join("");
      return `<section class="panel" style="padding:1rem"><h3 class="display mb-3" style="font-size:var(--text-base)">Group ${g.label}</h3><div class="stack gap-2">${slots}</div></section>`;
    })
    .join("");

  return `<div class="stack gap-6">
    <div class="split">
      <p class="muted" style="max-width:60ch"><span class="num" style="color:var(--fg)">${store.groupPlayers.length}</span> of 32 players placed. Run a seeded draw, or pick players slot by slot.</p>
      <div class="row gap-2">
        <button class="btn btn-ghost" data-action="clear-groups" ${store.groupPlayers.length ? "" : "disabled"}>Clear all</button>
        <button class="btn btn-primary" data-action="draw" ${players.length < 32 ? "disabled" : ""}>${icon("shuffle", "bold")} Seeded draw</button>
      </div>
    </div>
    ${players.length < 32 ? notice(`You have ${players.length} player accounts. Add at least 32 on the People tab to run the draw.`) : ""}
    ${hasFixtures ? notice("Group fixtures already exist. If you change the groups, generate the fixtures again on the Matches tab.") : ""}
    <div data-err></div>
    ${store.groups.length && store.groupPlayers.length === store.groups.length * 4
      ? modeChooser({ full: true })
      : tournamentMode()
        ? ""
        : notice(`When all ${store.groups.length * 4 || 32} places are filled, you'll choose here whether this is a rated or an unrated tournament.`)}
    <div class="grid sm-2 xl-4 tight">${groups}</div>
    ${isAdmin ? testPanel() : ""}
  </div>`;
}

// ---------------------------------------------------------------- rated or unrated tournament

// Shown on the Groups tab once every place is filled (full), and always on
// the Tournament tab. Fixtures can't be generated until a choice is made.
function modeChooser({ full }) {
  const mode = tournamentMode();
  const done = store.matches.filter((m) => !isFriendly(m) && !m.tiebreak_of && m.status === "completed").length;
  const card = (value, title, body, glyph) => `<button type="button" class="mode-card${mode === value ? " on" : ""}" data-action="set-mode" data-rated="${value === "rated"}" aria-pressed="${mode === value}">
      <span class="mode-icon">${icon(glyph, "bold")}</span>
      <span class="mode-title">${title}</span>
      <span class="mode-body">${body}</span>
      ${mode === value ? `<span class="mode-tick">${icon("check-circle", "fill")} Chosen</span>` : ""}
    </button>`;
  const intro = mode
    ? `This edition is ${mode === "rated" ? "a <strong>rated</strong>" : "an <strong>unrated</strong>"} tournament. You can switch while it runs: finished games gain or lose their rating change straight away.`
    : "Choose before you generate the fixtures. Group games, the knockout bracket and its games all follow this choice. Friendly matches keep their own setting.";
  return `<section class="panel pad mode-panel${full && !mode ? " attention" : ""}" id="mode">
    <p class="eyebrow">${full ? `Groups A to ${String.fromCharCode(64 + store.groups.length)} are full` : "Tournament type"}</p>
    <h2 class="section-title mt-2">How should this tournament count?</h2>
    <p class="small muted mt-1" style="max-width:70ch">${intro}</p>
    <div class="mode-grid mt-4">
      ${card("rated", "Rated tournament", "Every group and knockout game changes both players' Elo ratings, and the leaderboard follows the results.", "chart-line-up")}
      ${card("unrated", "Unrated tournament", "Groups, tables, the bracket, Armageddon tiebreaks and the champion work exactly the same, but nobody's rating changes. Good for practice or a fun event.", "minus-circle")}
    </div>
    ${done && mode ? `<p class="hint mt-3">${done} finished game${done === 1 ? "" : "s"} so far.</p>` : ""}
    <div data-mode-err class="mt-3"></div>
  </section>`;
}

// ---------------------------------------------------------------- registrations tab (admins)


// Everyone who registered for the active edition, kept live.
async function loadRegistrations() {
  if (!store.tournament) {
    ui.regs = [];
    return;
  }
  const { data } = await supabase.from("registrations").select("*").eq("tournament_id", store.tournament.id).order("created_at", { ascending: false });
  ui.regs = data ?? [];
}

async function startRegistrations() {
  await loadRegistrations();
  if (currentTab() === "registrations") scheduleDraw();
  supabase
    .channel("control-registrations")
    .on("postgres_changes", { event: "*", schema: "public", table: "registrations" }, async () => {
      await loadRegistrations();
      if (currentTab() === "registrations") scheduleDraw();
    })
    .subscribe();
}

// The form being edited, kept apart from the saved one until "Save form".
function formDraft() {
  if (!ui.formDraft || ui.formDraftFor !== store.tournament?.id) {
    ui.formDraft = structuredClone(store.tournament?.registration ?? { status: "soon", intro: "", fields: [] });
    ui.formDraftFor = store.tournament?.id;
    ui.formDirty = false;
  }
  return ui.formDraft;
}

function registrationsTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first.");
  return `<div class="stack gap-8">${formEditor()}${applicantsList()}</div>`;
}

function formEditor() {
  const f = formDraft();
  const saved = store.tournament.registration ?? {};
  const liveState = saved.status === "open" && saved.closes_at && Date.now() > Date.parse(saved.closes_at) ? "closed" : saved.status;
  const statusChips = Object.entries(REG_STATUS)
    .map(([k, v]) => `<button type="button" class="chip${f.status === k ? " active" : ""}" data-action="reg-status" data-status="${k}">${v}</button>`)
    .join("");
  const rows = f.fields
    .map((q, i) => {
      const locked = q.core || q.builtin;
      return `<div class="q-row" data-q="${i}">
        <div class="q-move">
          <button type="button" class="icon-btn" data-action="q-up" data-i="${i}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>${icon("caret-up", "bold")}</button>
          <button type="button" class="icon-btn" data-action="q-down" data-i="${i}" aria-label="Move down" ${i === f.fields.length - 1 ? "disabled" : ""}>${icon("caret-down", "bold")}</button>
        </div>
        <div class="q-main">
          <label class="sr-only" for="q-label-${i}">Question</label>
          <input class="input sm" id="q-label-${i}" data-q-label="${i}" value="${esc(q.label)}" maxlength="120">
          ${q.type === "choice" ? `<input class="input sm mt-2" data-q-options="${i}" value="${esc((q.options ?? []).join(", "))}" placeholder="Options, separated by commas">` : ""}
        </div>
        <select class="input sm q-type" data-q-type="${i}" ${locked ? "disabled" : ""} aria-label="Answer type">${
          locked
            ? `<option>${q.core ? (q.key === "password" ? "Password" : q.key === "email" ? "Email" : "Short answer") : q.type === "tel" ? "Phone number" : "Short answer"}</option>`
            : FIELD_TYPES.map(([v, l]) => `<option value="${v}" ${q.type === v ? "selected" : ""}>${l}</option>`).join("")
        }</select>
        <label class="q-req"><input type="checkbox" data-q-required="${i}" ${q.required ? "checked" : ""} ${q.core ? "disabled" : ""}> Required</label>
        ${locked ? `<span class="q-lock" title="${q.core ? "Needed to create the sign-in" : "Saved to the player's profile"}">${icon("lock-simple")}</span>` : `<button type="button" class="icon-btn danger" data-action="q-remove" data-i="${i}" aria-label="Remove question">${icon("trash")}</button>`}
      </div>`;
    })
    .join("");
  return `<section class="panel pad" id="reg-form">
    <div class="row between wrap gap-4">
      <div>
        <h2 class="section-title">${icon("clipboard-text", "bold")} Registration form</h2>
        <p class="small muted mt-1" style="max-width:66ch">"Register now" on the main page opens this form. Applicants choose their own password, so when you add them you only pick a role.</p>
      </div>
      <div class="row gap-2"><span class="badge">Now: ${REG_STATUS[liveState] ?? "Coming soon"}</span><a class="btn btn-sm" href="register.html" target="_blank" rel="noopener">${icon("arrow-square-out")} Open the form</a></div>
    </div>
    <div class="form-grid md-2 mt-6">
      <div class="field"><label>Registration</label><div class="chips" style="margin:0">${statusChips}</div><p class="hint">Coming soon and Closed show a message instead of the form.</p></div>
      <div class="field"><label for="reg-closes">Closes (optional)</label><input class="input" id="reg-closes" type="datetime-local" value="${toLocalInput(f.closes_at)}"><p class="hint">After this time the form closes by itself.</p></div>
      <div class="field span-2"><label for="reg-intro">Message at the top of the form</label><textarea class="input" id="reg-intro" rows="2" maxlength="600">${esc(f.intro ?? "")}</textarea></div>
    </div>
    <h3 class="eyebrow mt-8 mb-3">Questions</h3>
    <div class="q-list">${rows}</div>
    <div class="row between wrap gap-3 mt-4">
      <button type="button" class="btn btn-sm" data-action="q-add">${icon("plus", "bold")} Add a question</button>
      <div class="row gap-3"><span data-form-msg class="small muted">${ui.formDirty ? "Unsaved changes" : ""}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="reg-discard" ${ui.formDirty ? "" : "disabled"}>Discard</button>
        <button type="button" class="btn btn-primary" data-action="reg-save">Save form</button></div>
    </div>
    <div data-form-err class="mt-3"></div>
  </section>`;
}

function applicantsList() {
  if (ui.regs === null) return `<div class="skeleton" style="height:14rem"></div>`;
  const counts = { new: 0, accepted: 0, rejected: 0, all: ui.regs.length };
  ui.regs.forEach((r) => (counts[r.status] += 1));
  const q = ui.regQuery.toLowerCase();
  const shown = ui.regs.filter(
    (r) => (ui.regFilter === "all" || r.status === ui.regFilter) && (!q || `${r.full_name} ${r.email} ${r.school ?? ""} ${r.phone ?? ""}`.toLowerCase().includes(q)),
  );
  // Drop selections that are no longer pending.
  for (const id of [...ui.regSelected]) if (!ui.regs.some((r) => r.id === id && r.status === "new")) ui.regSelected.delete(id);
  const labels = Object.fromEntries((store.tournament.registration?.fields ?? []).map((f) => [f.key, f.label]));
  const chips = [["new", "New"], ["accepted", "Added"], ["rejected", "Rejected"], ["all", "All"]]
    .map(([k, v]) => `<button class="chip${ui.regFilter === k ? " active" : ""}" data-action="reg-filter" data-filter="${k}">${v}<span class="count">${counts[k]}</span></button>`)
    .join("");
  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const answer = (v) => (v === true ? "Yes" : v === false ? "No" : esc(v));
  const rows = shown
    .map((r) => {
      const extra = Object.entries(r.answers ?? {}).filter(([, v]) => v !== "" && v !== null && v !== false);
      return `<div class="reg-row${r.status !== "new" ? " done" : ""}">
        <span class="reg-pick">${r.status === "new" ? `<input type="checkbox" data-reg-pick="${r.id}" ${ui.regSelected.has(r.id) ? "checked" : ""} aria-label="Select ${esc(r.full_name)}">` : ""}</span>
        <div class="reg-who">
          <span class="strong">${esc(r.full_name)}</span>
          <span class="xs dim">${esc(r.school ?? "")}</span>
          ${extra.length ? `<details class="reg-more"><summary class="xs">All answers</summary><dl>${extra.map(([k, v]) => `<dt>${esc(labels[k] ?? k)}</dt><dd>${answer(v)}</dd>`).join("")}</dl></details>` : ""}
        </div>
        <div class="reg-contact small"><span>${esc(r.email)}</span><span class="dim">${esc(r.phone ?? "")}</span></div>
        <span class="xs dim reg-when">${when(r.created_at)}</span>
        <div class="reg-actions">${
          r.status === "new"
            ? `<button class="btn btn-primary btn-sm" data-action="reg-add" data-id="${r.id}">${icon("user-plus", "bold")} Add</button>
               <button class="btn btn-ghost btn-sm" data-action="reg-reject" data-id="${r.id}">Reject</button>`
            : r.status === "accepted"
              ? `<span class="badge">Added as ${esc(ROLE_LABEL[r.role] ?? r.role)}</span>`
              : `<span class="badge">Rejected</span>`
        }<button class="icon-btn danger" data-action="reg-delete" data-id="${r.id}" aria-label="Delete this registration">${icon("trash")}</button></div>
      </div>`;
    })
    .join("");
  const n = ui.regSelected.size;
  return `<section>
    <div class="split mb-4">
      <h2 class="section-title">Applicants <span class="dim num">${counts.all}</span></h2>
      <div class="search">${icon("magnifying-glass")}<label for="reg-search" class="sr-only">Search applicants</label><input id="reg-search" class="input" placeholder="Search name, email, school, phone" value="${esc(ui.regQuery)}" data-input="reg-search"></div>
    </div>
    <div class="chips">${chips}</div>
    ${n
      ? `<div class="reg-bulk"><span><strong>${n}</strong> selected</span>
          <label class="sr-only" for="bulk-role">Role</label>
          <select class="input sm" id="bulk-role">${ROLES.map((r) => `<option value="${r}">${ROLE_LABEL[r]}</option>`).join("")}</select>
          <button class="btn btn-primary btn-sm" data-action="reg-add-selected">${icon("user-plus", "bold")} Add ${n} to the portal</button>
          <button class="btn btn-ghost btn-sm" data-action="reg-clear">Clear</button></div>`
      : ""}
    <div data-reg-err></div>
    ${shown.length
      ? `<div class="panel pad-sm">${counts.new && ui.regFilter === "new" ? `<label class="reg-all xs muted"><input type="checkbox" data-reg-all ${n && n === shown.length ? "checked" : ""}> Select all ${shown.length}</label>` : ""}${rows}</div>`
      : emptyState(ui.regFilter === "new" ? "No new registrations" : "Nobody here", store.tournament.registration?.status === "open" ? "New entries appear here the moment they're sent." : "Open registration above to start taking entries.")}
  </section>`;
}

// Adding someone: only the role is asked (and a rating, for players).
function addRegistrationModal(r) {
  const rated = Number(r.answers?.rating);
  const d = openModal(
    `Add ${r.full_name}`,
    `<form class="stack gap-4">
      <p class="muted small">${esc(r.email)}${r.school ? ` · ${esc(r.school)}` : ""}. They sign in with the email and password they registered with.</p>
      <div class="field"><label for="ar-role">Role</label><select class="input" id="ar-role" name="role">${ROLES.map((x) => `<option value="${x}">${ROLE_LABEL[x]}</option>`).join("")}</select></div>
      <div class="field" data-rating><label for="ar-rating">Rating</label><input class="input" id="ar-rating" name="rating" type="number" min="0" max="3500" value="${Number.isInteger(rated) && rated > 0 ? rated : 1000}"><p class="hint">Used for the seeded draw. ${Number.isInteger(rated) && rated > 0 ? "From their registration." : "1000 if they don't have one."}</p></div>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${icon("user-plus", "bold")} Add to the portal</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
  const sync = () => (d.querySelector("[data-rating]").hidden = form.role.value !== "player");
  form.role.addEventListener("change", sync);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withBusy(form.querySelector("[type=submit]"), async () => {
      await callFunction("admin-users", {
        action: "accept_registration",
        id: r.id,
        role: form.role.value,
        rating: form.role.value === "player" ? Number(form.rating.value) : undefined,
      });
      d.close();
      await Promise.all([refresh(), loadRegistrations()]);
      draw();
    }, d.querySelector("[data-err]"));
  });
}

function registrationAction(el) {
  const err = app.querySelector("[data-reg-err]") ?? app.querySelector("[data-form-err]");
  const f = formDraft();
  const reg = (id) => ui.regs.find((r) => r.id === id);
  const i = Number(el.dataset.i);
  const touched = () => {
    ui.formDirty = true;
    draw();
  };
  switch (el.dataset.action) {
    case "reg-status":
      f.status = el.dataset.status;
      return touched();
    case "q-up":
      [f.fields[i - 1], f.fields[i]] = [f.fields[i], f.fields[i - 1]];
      return touched();
    case "q-down":
      [f.fields[i + 1], f.fields[i]] = [f.fields[i], f.fields[i + 1]];
      return touched();
    case "q-remove":
      f.fields.splice(i, 1);
      return touched();
    case "q-add":
      f.fields.push({ key: `q_${crypto.randomUUID().slice(0, 8)}`, label: "New question", type: "text", required: false });
      return touched();
    case "reg-discard":
      ui.formDraft = null;
      return draw();
    case "reg-save": {
      const problems = [];
      if (f.fields.some((q) => !q.label.trim())) problems.push("Every question needs a label.");
      if (f.fields.some((q) => q.type === "choice" && !(q.options ?? []).length)) problems.push('"Choose one" questions need at least one option.');
      const box = app.querySelector("[data-form-err]");
      if (problems.length) {
        box.innerHTML = notice(problems.join(" "), "error");
        return;
      }
      return withBusy(el, async () => {
        await updateTournament(store.tournament.id, { registration: f });
        await loadAll();
        ui.formDraft = null;
        draw();
        const msg = app.querySelector("[data-form-msg]");
        if (msg) msg.textContent = "Saved.";
      }, box);
    }
    case "reg-filter":
      ui.regFilter = el.dataset.filter;
      return draw();
    case "reg-clear":
      ui.regSelected.clear();
      return draw();
    case "reg-add":
      return addRegistrationModal(reg(el.dataset.id));
    case "reg-reject": {
      const r = reg(el.dataset.id);
      if (!confirm(`Reject ${r.full_name}? Their sign-in is removed, so they can't get into the portal (they can register again later).`)) return;
      return withBusy(el, async () => {
        await callFunction("admin-users", { action: "reject_registration", id: r.id });
        await loadRegistrations();
        draw();
      }, err);
    }
    case "reg-delete": {
      const r = reg(el.dataset.id);
      const msg = r.status === "accepted"
        ? `Delete ${r.full_name}'s registration? Their portal account stays; remove it on the People tab if needed.`
        : `Delete ${r.full_name}'s registration and their sign-in?`;
      if (!confirm(msg)) return;
      return withBusy(el, async () => {
        await callFunction("admin-users", { action: "delete_registration", id: r.id });
        await loadRegistrations();
        draw();
      }, err);
    }
    case "reg-add-selected": {
      const role = app.querySelector("#bulk-role").value;
      const ids = [...ui.regSelected];
      return withBusy(el, async () => {
        let done = 0;
        const failed = [];
        for (const id of ids) {
          try {
            await callFunction("admin-users", { action: "accept_registration", id, role });
            done += 1;
            el.textContent = `Adding ${done} of ${ids.length}…`;
          } catch (e) {
            failed.push(`${reg(id)?.full_name}: ${e.message}`);
          }
        }
        ui.regSelected.clear();
        await Promise.all([refresh(), loadRegistrations()]);
        draw();
        const box = app.querySelector("[data-reg-err]");
        if (box) box.innerHTML = notice(`Added ${done} ${done === 1 ? "person" : "people"} as ${ROLE_LABEL[role]}.${failed.length ? ` Not added: ${esc(failed.join("; "))}` : ""}`, failed.length ? "error" : "");
      }, err);
    }
  }
}

// Typing in the form editor updates the draft without redrawing, so the
// cursor stays put; other changes redraw.
app.addEventListener("input", (e) => {
  if (currentTab() !== "registrations") return;
  const f = formDraft();
  const t = e.target;
  const mark = () => {
    ui.formDirty = true;
    const m = app.querySelector("[data-form-msg]");
    if (m) m.textContent = "Unsaved changes";
    const discard = app.querySelector('[data-action="reg-discard"]');
    if (discard) discard.disabled = false;
  };
  if (t.dataset.qLabel !== undefined) {
    f.fields[Number(t.dataset.qLabel)].label = t.value;
    mark();
  } else if (t.dataset.qOptions !== undefined) {
    f.fields[Number(t.dataset.qOptions)].options = t.value.split(",").map((s) => s.trim()).filter(Boolean);
    mark();
  } else if (t.id === "reg-intro") {
    f.intro = t.value;
    mark();
  } else if (t.id === "reg-closes") {
    f.closes_at = fromLocalInput(t.value);
    mark();
  } else if (t.dataset.input === "reg-search") {
    ui.regQuery = t.value;
    const pos = t.selectionStart;
    draw();
    const again = app.querySelector("[data-input=reg-search]");
    again.focus();
    again.setSelectionRange(pos, pos);
  }
});

app.addEventListener("change", (e) => {
  if (currentTab() !== "registrations") return;
  const f = formDraft();
  const t = e.target;
  if (t.dataset.qType !== undefined) {
    const q = f.fields[Number(t.dataset.qType)];
    q.type = t.value;
    if (q.type === "choice" && !q.options) q.options = [];
    ui.formDirty = true;
    draw();
  } else if (t.dataset.qRequired !== undefined) {
    f.fields[Number(t.dataset.qRequired)].required = t.checked;
    ui.formDirty = true;
    draw();
  } else if (t.dataset.regPick !== undefined) {
    if (t.checked) ui.regSelected.add(t.dataset.regPick);
    else ui.regSelected.delete(t.dataset.regPick);
    draw();
  } else if (t.dataset.regAll !== undefined) {
    const q = ui.regQuery.toLowerCase();
    ui.regs
      .filter((r) => r.status === "new" && (!q || `${r.full_name} ${r.email} ${r.school ?? ""} ${r.phone ?? ""}`.toLowerCase().includes(q)))
      .forEach((r) => (t.checked ? ui.regSelected.add(r.id) : ui.regSelected.delete(r.id)));
    draw();
  }
});

if (isAdmin) startRegistrations();

// ---------------------------------------------------------------- testing with bots

// The last test action's outcome stays put through live redraws.
function showTestMsg(text) {
  ui.testMsg = text;
  const el = app.querySelector("[data-test-msg]");
  if (el) el.innerHTML = text ? notice(text) : "";
}

function bots() {
  return store.profiles.filter((p) => p.is_bot);
}

// Shown on every tab while bots are in, so nobody forgets to clear them.
function testBanner(tab) {
  const n = bots().length;
  if (!n || tab === "groups") return "";
  return `<div class="test-banner">${icon("robot", "bold")}<span><strong>Test mode:</strong> ${n} bot${n === 1 ? "" : "s"} in the tournament.</span>
    <a class="btn btn-sm ml-auto" href="#groups">Testing tools ${icon("arrow-right")}</a></div>`;
}

function testPanel() {
  const n = bots().length;
  const empty = store.groups.length * 4 - store.groupPlayers.length;
  const isBot = (id) => store.profileById.get(id)?.is_bot;
  const botGames = store.matches.filter((m) => m.status !== "completed" && m.white_id && m.black_id && (isBot(m.white_id) || isBot(m.black_id))).length;
  return `<section class="panel pad test-panel" id="testing">
    <div class="row between wrap gap-4">
      <div><h2 class="section-title">${icon("robot", "bold")} Test with bots</h2>
        <p class="small muted mt-1" style="max-width:70ch">Rehearse the whole tournament before the real one. Bots are marked <span class="bot-tag">Bot</span> everywhere. When you're done, one click removes every bot and every game they played, and real players' ratings go back to what they were.</p></div>
      ${n ? `<span class="badge">${n} bots in</span>` : ""}
    </div>
    <div class="steps">
      <div class="step"><span class="num dim xs">01</span><strong>Fill the groups</strong><p class="small muted">Adds a bot to each of the ${empty} empty slot${empty === 1 ? "" : "s"}. Real players already placed keep their slots.</p>
        <button class="btn btn-primary btn-sm" data-action="fill-bots" ${empty ? "" : "disabled"}>${icon("user-plus", "bold")} Fill ${empty} slot${empty === 1 ? "" : "s"}</button></div>
      <div class="step"><span class="num dim xs">02</span><strong>Play</strong><p class="small muted">Generate fixtures and schedule a round on the Matches tab. Bots make their own moves in the Arena whenever someone has their game open, so you can also play against them. Or finish everything at once:</p>
        <label class="row gap-2 xs muted" style="cursor:pointer"><input type="checkbox" id="sim-real" style="accent-color:#d9dce2"> Also finish games between real players</label>
        <button class="btn btn-sm" data-action="simulate-bots" ${n ? "" : "disabled"}>${icon("lightning", "bold")} Finish ${botGames ? `${botGames} ` : ""}bot games instantly</button></div>
      <div class="step"><span class="num dim xs">03</span><strong>Clean up</strong><p class="small muted">Removes all bots, their games, the bracket built with them and the updates about those games.</p>
        <button class="btn btn-danger btn-sm" data-action="remove-bots" ${n ? "" : "disabled"}>${icon("trash", "bold")} Remove all test data</button></div>
    </div>
    <div data-test-msg class="mt-4">${ui.testMsg ? notice(ui.testMsg) : ""}</div>
  </section>`;
}

function drawModal() {
  const players = playerPool();
  const placed = new Set(store.groupPlayers.map((gp) => gp.player_id));
  const preselected = new Set(placed.size === 32 ? placed : players.slice(0, 32).map((p) => p.id));
  const d = openModal(
    "Seeded draw",
    `<p class="muted">Players are ranked by rating into four pots of eight. Each group gets one player from each pot, so the strongest players start in different groups. This replaces the current groups.</p>
     <p class="small mt-4"><span class="num strong" data-count></span><span class="muted"> of 32 players selected</span></p>
     <div class="pick-list">${players
       .map((p) => `<label><input type="checkbox" value="${p.id}" ${preselected.has(p.id) ? "checked" : ""}><span class="grow truncate">${esc(p.full_name)}</span><span class="num xs dim">${p.rating}</span></label>`)
       .join("")}</div>
     <div data-err class="mt-4"></div>
     <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-confirm>${icon("shuffle", "bold")} Run the draw</button></div>`,
    { wide: true },
  );
  const boxes = [...d.querySelectorAll("input[type=checkbox]")];
  const btn = d.querySelector("[data-confirm]");
  const sync = () => {
    const n = boxes.filter((b) => b.checked).length;
    const el = d.querySelector("[data-count]");
    el.textContent = n;
    el.classList.toggle("signal", n !== 32);
    btn.disabled = n !== 32;
  };
  boxes.forEach((b) => b.addEventListener("change", sync));
  sync();
  btn.addEventListener("click", () =>
    withBusy(btn, async () => {
      const ids = boxes.filter((b) => b.checked).map((b) => b.value);
      await seededDraw(store.tournament.id, store.groups, ids.map((id) => store.profileById.get(id)));
      d.close();
      await refresh();
    }, d.querySelector("[data-err]")),
  );
}

// ---------------------------------------------------------------- matches tab

function matchesTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first.");
  const groupGames = store.matches.filter((m) => m.stage === "group");
  const round = ROUNDS.find((r) => r.key === ui.round);
  const roundMatches = store.matches.filter(round.test).sort(sortByTime);
  const first = roundMatches.find((m) => m.scheduled_at)?.scheduled_at ?? null;
  const pending = roundMatches.filter((m) => m.status === "scheduled").length;

  const chips = ROUNDS.map(
    (r) => `<button class="chip${r.key === ui.round ? " active" : ""}" data-action="round" data-round="${r.key}">${r.label}<span class="count">${store.matches.filter(r.test).length}</span></button>`,
  ).join("");

  const rows = roundMatches
    .map((m) => {
      const g = store.groups.find((x) => x.id === m.group_id);
      return `<div class="admin-row">
        <div class="grow">
          <span class="xs dim" style="display:block;margin-bottom:0.25rem">${isFriendly(m) ? matchContext(m) : m.stage === "group" ? `Group ${g?.label ?? ""}` : m.tiebreak_of ? `${STAGE_LABEL[m.stage]} Armageddon` : `${STAGE_LABEL[m.stage]} ${m.bracket_slot}`}${m.rated === false && !isFriendly(m) && !m.tiebreak_of ? " · Unrated" : ""}${m.scheduled_at ? `, ${formatDateTime(m.scheduled_at)}` : ""}</span>
          <span class="vs">${playerHtml(m.white_id)}<span class="xs dim">vs</span>${playerHtml(m.black_id)}</span>
        </div>
        ${statusHtml(m)}
        <button class="icon-btn" data-action="edit-match" data-id="${m.id}" aria-label="Edit game">${icon("pencil-simple")}</button>
      </div>`;
    })
    .join("");

  return `<div class="stack gap-8">
    <section class="panel pad split">
      <div>
        <h2 class="section-title">Group fixtures</h2>
        <p class="small muted mt-1">${groupGames.length
          ? `${groupGames.length} games made: every player meets the other three in their group over three rounds.`
          : "Makes 48 games: each group plays a round robin over three rounds."}</p>
      </div>
      <button class="btn ${groupGames.length ? "" : "btn-primary"}" data-action="generate-fixtures" ${store.groupPlayers.length !== 32 || !tournamentMode() ? "disabled" : ""}>${groupGames.length ? "Generate again" : "Generate fixtures"}</button>
    </section>
    ${store.groupPlayers.length !== 32 && !groupGames.length ? notice("Place all 32 players in groups first.") : ""}
    ${store.groupPlayers.length === 32 && !tournamentMode() ? notice(`Choose a <a href="#groups" style="text-decoration:underline">rated or unrated tournament</a> on the Groups tab before generating fixtures.`) : ""}
    ${tournamentMode() ? `<p class="small muted">${icon(tournamentMode() === "rated" ? "chart-line-up" : "minus-circle")} This is ${tournamentMode() === "rated" ? "a <strong>rated</strong>" : "an <strong>unrated</strong>"} tournament. <a href="#groups" style="text-decoration:underline">Change</a></p>` : ""}
    <div data-err></div>

    <section>
      <div class="chips">${chips}</div>
      ${round.key === "friendly"
        ? `<div class="panel pad split">
            <div><h2 class="section-title">Friendly matches</h2>
              <p class="small muted mt-1" style="max-width:62ch">Arrange a game between any two people, outside the groups and the bracket, with its own clock. Choose <strong>unrated</strong> for practice or exhibition games: they never change ratings or the leaderboard. Choose <strong>rated</strong> to count it like a tournament game.</p></div>
            <button class="btn btn-primary" data-action="new-friendly">${icon("plus", "bold")} New match</button>
          </div>
          ${roundMatches.length ? `<div class="panel pad-sm mt-4">${rows}</div>` : ""}`
        : roundMatches.length
        ? `<div class="panel pad split" style="align-items:flex-end">
            <div class="field grow">
              <label for="round-time">Start time for all of ${round.label.toLowerCase()}</label>
              <input id="round-time" type="datetime-local" class="input" style="max-width:20rem" value="${toLocalInput(first)}">
              <p class="hint">Applies to the ${pending} games not yet started. Set individual times with the edit button.</p>
            </div>
            <button class="btn btn-primary" data-action="schedule-round">${icon("calendar-blank")} Schedule round</button>
          </div>
          <div class="panel pad-sm mt-4">${rows}</div>`
        : emptyState(`No ${round.label.toLowerCase()} games yet`, round.key.startsWith("g") ? "Generate the group fixtures above." : "These games appear when you generate the knockout bracket.")}
    </section>
  </div>`;
}

function matchModal(m) {
  // Friendlies can be between anyone; tournament games are between players.
  const players = store.profiles
    .filter((p) => isFriendly(m) || p.role === "player")
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
  const knockout = isKnockout(m);
  const started = m.status !== "scheduled" || m.move_count > 0;
  const options = (selected) => `<option value="">To be decided</option>${players.map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}`;
  const nameOf = (id) => esc(store.profileById.get(id)?.full_name ?? "");

  const d = openModal(
    isFriendly(m) ? "Friendly match" : m.stage === "group" ? `Group game, round ${m.round}` : m.tiebreak_of ? `${STAGE_LABEL[m.stage]} Armageddon` : `${STAGE_LABEL[m.stage]} ${m.bracket_slot}`,
    `<form class="stack gap-4">
      <div class="field">
        <label for="mm-when">Start time</label>
        <input class="input" id="mm-when" name="when" type="datetime-local" value="${toLocalInput(m.scheduled_at)}" ${started ? "disabled" : ""}>
        ${started ? `<p class="hint">This game has started, so its time is fixed. Reset it to reschedule.</p>` : ""}
      </div>
      <div class="vs-grid">
        <div class="field"><label for="mm-white">White</label><select class="input" id="mm-white" name="white" ${started ? "disabled" : ""}>${options(m.white_id)}</select></div>
        <button type="button" class="icon-btn" data-swap aria-label="Swap colours" ${started ? "disabled" : ""} style="margin-bottom:0.25rem">${icon("arrows-left-right")}</button>
        <div class="field"><label for="mm-black">Black</label><select class="input" id="mm-black" name="black" ${started ? "disabled" : ""}>${options(m.black_id)}</select></div>
      </div>
      <div class="field">
        <label for="mm-result">Result</label>
        <select class="input" id="mm-result" name="result">
          <option value="">No result yet</option>
          <option value="1-0" ${m.result === "1-0" ? "selected" : ""}>White wins (1 - 0)</option>
          <option value="0-1" ${m.result === "0-1" ? "selected" : ""}>Black wins (0 - 1)</option>
          <option value="1/2-1/2" ${m.result === "1/2-1/2" ? "selected" : ""}>Draw (½ - ½)</option>
        </select>
        <p class="hint">Use this for games played over the board, or to correct a result. Ratings update automatically.</p>
      </div>
      ${ratedSwitch(m.tiebreak_of ? false : m.rated !== false, Boolean(m.tiebreak_of))}
      <a class="btn btn-sm" href="play.html?id=${m.id}" style="align-self:flex-start">${icon("crown-simple", "bold")} Open in the Arena</a>
      ${knockout && !m.tiebreak_of
        ? `<div class="field" data-tiebreak>
            <label for="mm-winner">Tiebreak winner</label>
            <select class="input" id="mm-winner" name="winner"><option value="">Choose a player</option>${[m.white_id, m.black_id].filter(Boolean).map((id) => `<option value="${id}" ${id === m.winner_id ? "selected" : ""}>${nameOf(id)}</option>`).join("")}</select>
            <p class="hint">Knockout games need someone to go through. ${store.tournament?.auto_tiebreak ? "Leave it empty and an Armageddon game is created automatically, or pick the winner of a tiebreak played elsewhere." : "Pick who won the tiebreak."}</p>
          </div>`
        : ""}
      <div data-err></div>
      <div class="row between wrap gap-2" style="border-top:1px solid var(--line);padding-top:1.25rem">
        <span class="row gap-2">
          <button type="button" class="btn btn-danger btn-sm" data-reset ${!started && !m.result ? "disabled" : ""}>Reset game</button>
          ${isFriendly(m) ? `<button type="button" class="btn btn-ghost btn-sm" data-delete>${icon("trash")} Delete match</button>` : ""}
        </span>
        <div class="row gap-2"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></div>
      </div>
    </form>`,
  );
  const form = d.querySelector("form");
  const err = d.querySelector("[data-err]");
  const tiebreak = d.querySelector("[data-tiebreak]");
  const syncTiebreak = () => tiebreak && (tiebreak.hidden = form.result.value !== "1/2-1/2");
  form.result.addEventListener("change", syncTiebreak);
  syncTiebreak();
  d.querySelector("[data-swap]").addEventListener("click", () => {
    [form.white.value, form.black.value] = [form.black.value, form.white.value];
  });

  d.querySelector("[data-reset]").addEventListener("click", (e) => {
    if (!confirm("Reset this game to the starting position? Moves, clocks and the result are cleared, and any rating change is undone.")) return;
    withBusy(e.currentTarget, async () => {
      await resetGame(m.id);
      d.close();
      await refresh();
    }, err);
  });

  d.querySelector("[data-delete]")?.addEventListener("click", (e) => {
    if (!confirm("Delete this friendly match? Any rating change it caused is undone.")) return;
    withBusy(e.currentTarget, async () => {
      await deleteMatch(m.id);
      d.close();
      await refresh();
    }, err);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const white = form.white.value;
    const black = form.black.value;
    const result = form.result.value;
    if (white && white === black) {
      err.innerHTML = notice("A player can't play themselves.", "error");
      return;
    }
    if (knockout && !m.tiebreak_of && result === "1/2-1/2" && !form.winner.value && !store.tournament?.auto_tiebreak) {
      err.innerHTML = notice("A drawn knockout game needs a tiebreak winner.", "error");
      return;
    }
    const patch = started ? {} : { scheduled_at: fromLocalInput(form.when.value), white_id: white || null, black_id: black || null };
    if (result !== (m.result ?? "")) {
      patch.result = result || null;
      patch.status = result ? "completed" : m.move_count ? "live" : "scheduled";
      patch.end_reason = result ? "result recorded by staff" : null;
    }
    if (knockout && result === "1/2-1/2" && form.winner?.value) patch.winner_id = form.winner.value;
    // Rated or not; the database adds or undoes the rating change to match.
    if (!m.tiebreak_of && form.rated.checked !== (m.rated !== false)) patch.rated = form.rated.checked;
    await withBusy(form.querySelector("[type=submit]"), async () => {
      if (Object.keys(patch).length) await updateMatch(m.id, patch);
      d.close();
      await refresh();
    }, err);
  });
}

// The rated / unrated choice, the same in both dialogs.
function ratedSwitch(checked, locked = false) {
  return `<label class="row gap-3" style="cursor:${locked ? "default" : "pointer"};align-items:flex-start">
    <input type="checkbox" name="rated" ${checked ? "checked" : ""} ${locked ? "disabled" : ""} style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2;margin-top:0.2rem">
    <span><span class="strong small" style="display:block">Rated game</span><span class="hint">${locked
      ? "Armageddon tiebreaks are always unrated."
      : "Rated games change both players' Elo ratings and count on the leaderboard. Unrated games don't."}</span></span>
  </label>`;
}

function friendlyModal() {
  const people = store.profiles.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
  const options = people
    .map((p) => `<option value="${p.id}">${esc(p.full_name)}${p.role === "player" ? ` (${p.rating})` : ` · ${ROLE_LABEL[p.role]}`}</option>`)
    .join("");
  const soon = new Date(Date.now() + 10 * 60_000);
  soon.setSeconds(0, 0);
  const t = store.tournament;
  const d = openModal(
    "New friendly match",
    `<form class="stack gap-4">
      <div class="vs-grid">
        <div class="field"><label for="fm-white">White</label><select class="input" id="fm-white" name="white" required><option value="">Choose</option>${options}</select></div>
        <button type="button" class="icon-btn" data-swap aria-label="Swap colours" style="margin-bottom:0.25rem">${icon("arrows-left-right")}</button>
        <div class="field"><label for="fm-black">Black</label><select class="input" id="fm-black" name="black" required><option value="">Choose</option>${options}</select></div>
      </div>
      <div class="field"><label for="fm-when">Start time</label><input class="input" id="fm-when" name="when" type="datetime-local" required value="${toLocalInput(soon.toISOString())}"><p class="hint">Both players get an update now and a reminder 10 minutes before.</p></div>
      <div class="two-col">
        <div class="field"><label for="fm-min">Minutes each</label><input class="input" id="fm-min" name="minutes" type="number" min="1" max="180" value="${t?.time_control_minutes ?? 10}"></div>
        <div class="field"><label for="fm-inc">Increment (s)</label><input class="input" id="fm-inc" name="increment" type="number" min="0" max="60" value="${t?.increment_seconds ?? 5}"></div>
      </div>
      ${ratedSwitch(false)}
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Create match</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
  d.querySelector("[data-swap]").addEventListener("click", () => {
    [form.white.value, form.black.value] = [form.black.value, form.white.value];
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = d.querySelector("[data-err]");
    if (form.white.value === form.black.value) {
      err.innerHTML = notice("Pick two different people.", "error");
      return;
    }
    await withBusy(form.querySelector("[type=submit]"), async () => {
      await createFriendly({
        tournamentId: store.tournament.id,
        whiteId: form.white.value,
        blackId: form.black.value,
        when: fromLocalInput(form.when.value),
        minutes: Number(form.minutes.value),
        increment: Number(form.increment.value),
        rated: form.rated.checked,
      });
      d.close();
      ui.round = "friendly";
      await refresh();
    }, err);
  });
}

// ---------------------------------------------------------------- knockout tab

function knockoutTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first.");
  const groupGames = store.matches.filter((m) => m.stage === "group");
  const finished = groupGames.filter((m) => m.status === "completed").length;
  const existing = bracketGames(store.matches).filter(isKnockout);
  const started = existing.some((m) => m.status !== "scheduled" || m.move_count > 0);
  const q = qualifiers(store.groups, store.groupPlayers, store.matches, store.profileById);
  const name = (id) => (id ? esc(store.profileById.get(id)?.full_name ?? "Unknown") : `<span class="dim">To be decided</span>`);

  const cards = R16_PAIRINGS.map(([ga, pa, gb, pb], i) => {
    const m = existing.find((x) => x.stage === "r16" && x.bracket_slot === i + 1);
    const white = m ? m.white_id : q.get(ga)?.[pa - 1];
    const black = m ? m.black_id : q.get(gb)?.[pb - 1];
    return `<div class="panel small" style="padding:1rem"><p class="xs dim">Match ${i + 1}: ${ga}${pa} vs ${gb}${pb}</p><p class="truncate mt-2" style="font-weight:500">${name(white)}</p><p class="truncate" style="font-weight:500">${name(black)}</p></div>`;
  }).join("");

  return `<div class="stack gap-6">
    <section class="panel pad split">
      <div>
        <h2 class="section-title">Knockout bracket</h2>
        <p class="small muted mt-1" style="max-width:60ch">${existing.length
          ? "The bracket is set. Winners move into the next round on their own as games finish; drawn games get an Armageddon tiebreak."
          : `Group stage: ${finished} of ${groupGames.length || 48} games finished. The top two in each group go through. ${TIEBREAK_NOTE}${store.tournament.auto_knockout ? " The bracket builds itself when the last group game ends." : ""}`}</p>
      </div>
      <div class="row gap-2">
        ${existing.length ? `<a class="btn" href="bracket.html">View bracket</a>` : ""}
        <button class="btn ${existing.length ? "" : "btn-primary"}" data-action="generate-knockout" ${!groupGames.length || started ? "disabled" : ""}>${icon("tree-structure")} ${existing.length ? "Generate again" : "Generate bracket"}</button>
      </div>
    </section>
    ${started ? notice("Knockout games have started, so the bracket is locked. Fix individual games on the Matches tab.") : ""}
    <div data-err></div>
    <section>
      <h3 class="small strong muted mb-3">${existing.length ? "Round of 16 as generated" : "Round of 16 if the groups ended now"}</h3>
      <div class="grid sm-2 xl-4 tight">${cards}</div>
    </section>
  </div>`;
}

// ---------------------------------------------------------------- events

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (/^(reg|q)-/.test(el.dataset.action)) return registrationAction(el);
  const err = app.querySelector("[data-err]");
  const t = store.tournament;
  switch (el.dataset.action) {
    case "new-edition":
      return newEditionModal();
    case "new-friendly":
      return friendlyModal();
    case "set-mode": {
      const rated = el.dataset.rated === "true";
      if (tournamentMode() === (rated ? "rated" : "unrated")) return;
      const done = store.matches.filter((m) => !isFriendly(m) && !m.tiebreak_of && m.status === "completed").length;
      if (done && !confirm(`${done} finished game${done === 1 ? "" : "s"} will ${rated ? "now change" : "no longer change"} players' ratings. Continue?`)) return;
      return withBusy(el, async () => {
        await setTournamentRated(t.id, rated);
        await refresh();
      }, app.querySelector("[data-mode-err]"));
    }
    case "fill-bots":
      showTestMsg("");
      return withBusy(el, async () => {
        const res = await callFunction("admin-users", { action: "fill_bots", tournament_id: t.id });
        await refresh();
        showTestMsg(`Added ${res.added} bots. Next: Matches, Generate fixtures, then schedule a round.`);
      }, app.querySelector("[data-test-msg]"));
    case "simulate-bots": {
      const includeReal = app.querySelector("#sim-real")?.checked;
      showTestMsg("");
      return withBusy(el, async () => {
        const n = await simulateGames(t.id, store.profileById, { includeReal });
        await refresh();
        showTestMsg(n ? `Finished ${n} games. Standings, tiebreaks and the bracket updated on their own.` : "No unfinished bot games with both players set. Generate the fixtures first.");
      }, app.querySelector("[data-test-msg]"));
    }
    case "remove-bots": {
      const d = openModal(
        "Remove all test data?",
        `<p class="muted">Every bot account is deleted, with every game a bot played, the knockout bracket and the updates about those games. Real players' ratings are restored.</p>
         <label class="row gap-3 mt-4" style="cursor:pointer;align-items:flex-start"><input type="checkbox" id="rm-real" checked style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2;margin-top:0.2rem"><span class="small"><strong>Also reset games between real players</strong><span class="hint" style="display:block">Puts them back to not started. Leave this on unless real players have already played real games.</span></span></label>
         <div data-err class="mt-4"></div>
         <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-danger" data-confirm>${icon("trash", "bold")} Remove test data</button></div>`,
      );
      const btn = d.querySelector("[data-confirm]");
      btn.addEventListener("click", () =>
        withBusy(btn, async () => {
          await resetRealTestGames(t.id, store.profileById, { allRealGames: d.querySelector("#rm-real").checked });
          const res = await callFunction("admin-users", { action: "remove_bots" });
          d.close();
          await refresh();
          showTestMsg(`Removed ${res.removed} bots and ${res.games} games. The tournament is back to real players only.`);
        }, d.querySelector("[data-err]")),
      );
      return;
    }
    case "activate":
      return withBusy(el, async () => {
        await setActiveTournament(el.dataset.id);
        await refresh();
      });
    case "role-filter":
      ui.roleFilter = el.dataset.role;
      return draw();
    case "add-person":
      return personModal(null);
    case "edit-person":
      return personModal(store.profileById.get(el.dataset.id));
    case "delete-person":
      return deletePersonModal(store.profileById.get(el.dataset.id));
    case "clear-groups":
      if (!confirm("Remove every player from every group?")) return;
      return withBusy(el, async () => {
        await clearGroups(t.id);
        await refresh();
      }, err);
    case "draw":
      return drawModal();
    case "round":
      ui.round = el.dataset.round;
      return draw();
    case "generate-fixtures":
      if (!tournamentMode()) return;
      if (store.matches.some((m) => m.stage === "group") && !confirm("This deletes all group games, including any results, and makes them again from the current groups. Continue?")) return;
      return withBusy(el, async () => {
        await generateGroupFixtures(t.id, store.groups, store.groupPlayers);
        await refresh();
      }, err);
    case "schedule-round": {
      const value = app.querySelector("#round-time").value;
      if (!value) return;
      const round = ROUNDS.find((r) => r.key === ui.round);
      return withBusy(el, async () => {
        await scheduleRound(store.matches.filter(round.test), fromLocalInput(value));
        await refresh();
      }, err);
    }
    case "edit-match":
      return matchModal(store.matches.find((m) => m.id === el.dataset.id));
    case "generate-knockout": {
      const groupGames = store.matches.filter((m) => m.stage === "group");
      const finished = groupGames.filter((m) => m.status === "completed").length;
      const warn = finished < groupGames.length ? `Only ${finished} of ${groupGames.length} group games are finished, so the tables may still change. ` : "";
      const replace = bracketGames(store.matches).some(isKnockout) ? "This replaces the current bracket. " : "";
      if ((warn || replace) && !confirm(`${warn}${replace}Generate the bracket now?`)) return;
      return withBusy(el, async () => {
        await generateKnockout(t.id);
        await refresh();
      }, err);
    }
  }
});

// Arbiter buttons on the Live tab.
app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-game]");
  if (!el) return;
  const extra = el.dataset.game === "add_time" ? { color: el.dataset.color, seconds: 30 } : {};
  await withBusy(el, async () => {
    const res = await callFunction("game", { action: el.dataset.game, match_id: el.dataset.id, ...extra });
    const i = store.matches.findIndex((m) => m.id === res.match.id);
    if (i >= 0) store.matches[i] = res.match;
    draw();
  }, app.querySelector("[data-err]"));
});

app.addEventListener("change", async (e) => {
  const slot = e.target.closest("[data-slot]");
  if (!slot) return;
  slot.disabled = true;
  await withBusy(null, async () => {
    await setGroupSlot(store.tournament.id, slot.dataset.group, Number(slot.dataset.seed), slot.value || null);
  }, app.querySelector("[data-err]"));
  await refresh();
});

app.addEventListener("input", (e) => {
  if (e.target.dataset.input !== "search") return;
  ui.query = e.target.value;
  const pos = e.target.selectionStart;
  draw();
  const input = app.querySelector("[data-input=search]");
  input.focus();
  input.setSelectionRange(pos, pos);
});

app.addEventListener("submit", async (e) => {
  const auto = e.target.closest("[data-form=autopilot]");
  if (auto) {
    e.preventDefault();
    await withBusy(auto.querySelector("[type=submit]"), async () => {
      await updateTournament(store.tournament.id, {
        auto_tiebreak: auto.auto_tiebreak.checked,
        auto_knockout: auto.auto_knockout.checked,
        tiebreak_delay_minutes: Number(auto.delay.value),
        draw_offer_min_moves: Number(auto.draw_min.value),
      });
      await refresh();
      const m = app.querySelector("[data-form=autopilot] [data-msg]");
      if (m) m.textContent = "Saved.";
    }, auto.querySelector("[data-msg]"));
    return;
  }
  const bc = e.target.closest("[data-form=broadcast]");
  if (bc) {
    e.preventDefault();
    const ids = store.profiles.filter((p) => bc.to.value === "everyone" || p.role === "player").map((p) => p.id);
    await withBusy(bc.querySelector("[type=submit]"), async () => {
      await sendMessage(ids, bc.title.value.trim(), bc.body.value.trim() || null, "home.html");
      bc.reset();
      bc.querySelector("[data-msg]").textContent = `Sent to ${ids.length}.`;
    }, bc.querySelector("[data-msg]"));
    return;
  }
  const form = e.target.closest("[data-form=edition]");
  if (!form) return;
  e.preventDefault();
  const msg = form.querySelector("[data-msg]");
  await withBusy(form.querySelector("[type=submit]"), async () => {
    await updateTournament(store.tournament.id, {
      name: form.name.value.trim(),
      time_control_minutes: Number(form.minutes.value),
      increment_seconds: Number(form.increment.value),
      status: form.status.value,
    });
    await refresh();
    const m = app.querySelector("[data-msg]");
    if (m) m.textContent = "Saved.";
  }, msg);
});
