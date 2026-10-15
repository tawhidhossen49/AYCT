// The Control Room: the organisers' side of the portal. Live boards with
// arbiter tools, the organising team's room, editions and autopilot, accounts,
// the group draw, fixtures and results, the knockout bracket, and the activity
// log. Moderators get everything except accounts.

import { ROLE_LABEL } from "../auth.js";
import { callFunction, supabase } from "../supabase.js";
import {
  store, loadAll, loadEmails, subscribe, sortByTime, STAGE_LABEL, effectiveStatus, matchContext, baseClocks, bracketGames, isKnockout, isFriendly,
  GROUP_ROUNDS, GROUP_GAMES, TOTAL_GAMES, KNOCKOUT_STAGES, formatOf, clockLabel, seriesState, seriesGames, rankOf, rankFor,
} from "../store.js";
import { formatClock, formatDateTime, formatTime, fromLocalInput, serverNow, toLocalInput } from "../time.js";
import { TIEBREAK_NOTE, formatPoints } from "../standings.js";
import { FORM_KINDS, COUNTDOWN_LABEL, countdownOf, formLink, formLinks } from "../registration.js";
import {
  clearGroups, createTournament, generateGroupFixtures, generateKnockout, qualifiers, R16_PAIRINGS,
  createFriendly, deleteMatch, resetGame, randomDraw, resetRealTestGames, scheduleRound, sendMessage, simulateGames, setActiveTournament, setGroupSlot, updateMatch, updateTournament,
  placeByRank, setTieWinner,
} from "../ops.js";
import { emptyState, esc, icon, liveTag, modalOpen, notice, openModal, playerHtml, statusHtml, withBusy } from "../ui.js";
import { mountMiniBoards } from "../board.js";
import { KIND_ICON, timeAgo } from "../notify.js";
import { startPage } from "../page.js";
import { animateIn } from "../motion.js";

const TABS = [
  { id: "live", label: "Live" },
  { id: "team", label: "Organising team" },
  { id: "tournament", label: "Tournament" },
  { id: "registrations", label: "Registrations", admin: true },
  { id: "people", label: "People" },
  { id: "groups", label: "Groups" },
  { id: "matches", label: "Matches" },
  { id: "knockout", label: "Knockout" },
  { id: "activity", label: "Activity" },
];
const ROLES = ["player", "moderator", "commentator", "admin"];
const STATUS_LABEL = { setup: "Setting up", groups: "Group stage", knockout: "Knockout stage", complete: "Complete" };
const ROUNDS = [
  ...Array.from({ length: GROUP_ROUNDS }, (_, i) => ({ key: `g${i + 1}`, label: `Group round ${i + 1}`, test: (m) => m.stage === "group" && m.round === i + 1 })),
  { key: "r16", label: STAGE_LABEL.r16, test: (m) => m.stage === "r16" },
  { key: "qf", label: "Quarterfinals", test: (m) => m.stage === "qf" },
  { key: "sf", label: "Semifinals", test: (m) => m.stage === "sf" },
  { key: "third", label: STAGE_LABEL.third, test: (m) => m.stage === "third" },
  { key: "final", label: STAGE_LABEL.final, test: (m) => m.stage === "final" },
  { key: "friendly", label: "Friendlies", test: (m) => m.stage === "friendly" },
];

// View state that survives redraws, plus what the Live, Organising team and
// Activity tabs watch: who is in which game room, the team's tasks and chat,
// and the fair-play log.
const ui = {
  roleFilter: "all",
  query: "",
  round: "g1",
  gameNo: 1,
  testMsg: "",
  // Organising team tab
  taskFilter: "all",
  arbFilter: "open",
  chatDraft: "",
  // Registrations tab
  regMsg: "",
  regDraft: {},
  regErr: "",
};
const watch = {
  presence: new Map(), goneSince: new Map(), events: [], notes: [], loaded: false, botAsked: new Map(), drawTimer: null, lastDraw: 0,
  team: { tasks: [], messages: [], online: new Map(), loaded: false, error: "", seenAt: 0 },
};
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
  colour_chosen: "chose the colours for the decider",
};
// The stages whose clocks are set on the Tournament tab, in order.
const CLOCK_ROWS = [
  ["group", "Group stage", "Double round robin"],
  ["r16", "Round of 16", "Two-game series"],
  ["qf", "Quarterfinals", "Two-game series"],
  ["sf", "Semifinals", "Two-game series"],
  ["third", "Third place", "Two-game series"],
  ["final", "Final", "Four games, all played"],
  ["tiebreak", "Tiebreak and decider", "One game each, when a series is level"],
];


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

// The registration form links are set by admins.
function visibleTabs() {
  return TABS.filter((t) => !t.admin || profile.role === "admin");
}

function draw() {
  const tab = currentTab();
  const tabs = `<nav class="tabs" aria-label="Admin sections">${visibleTabs()
    .map((t) => `<a class="tab${t.id === tab ? " active" : ""}" href="#${t.id}">${t.label}${tabCount(t.id, tab) ? ` <span class="tab-count">${tabCount(t.id, tab)}</span>` : ""}</a>`)
    .join("")}</nav>`;
  const body = { live: liveTab, team: teamTab, tournament: tournamentTab, registrations: registrationsTab, people: peopleTab, groups: groupsTab, matches: matchesTab, knockout: knockoutTab, activity: activityTab }[tab]();
  app.innerHTML = tabs + (store.error ? notice(esc(store.error), "error") : "") + testBanner(tab) + body;
  if (tab === "live") mountMiniBoards(app);
  if (tab === "team") teamShown();
}

// The small number on a tab: unread team messages.
function tabCount(id, current) {
  if (id === "team" && current !== "team") return teamUnread();
  return 0;
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
  loadTeam().then(() => {
    watchTeam();
    if (currentTab() === "team") calmDraw();
    else scheduleDraw();
  });
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
  const turn = (m.fen.split(" ")[1] ?? "w") === "w" ? "white" : "black";
  const w = m.white_ms ?? base.white;
  const b = m.black_ms ?? base.black;
  // No clock runs until both players have made their first move.
  if (m.status !== "live" || (m.move_count ?? 0) < 2 || m.paused_at || !m.clock_started_at) return { white: w, black: b, turn };
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
    <div class="ctl-arb">${icon("gavel")}${m.arbiter_id
      ? `<span class="truncate">Arbiter: ${teamName(m.arbiter_id)}</span>`
      : `<span>No arbiter</span><button class="btn btn-sm btn-ghost" data-action="team-arb-take" data-id="${m.id}">Take it</button>`}</div>
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
      <span class="${t.auto_tiebreak ? "on" : ""}">Series tiebreaks ${t.auto_tiebreak ? "on" : "off"}</span>
      <span class="${t.auto_knockout ? "on" : ""}">Bracket after groups ${t.auto_knockout ? "on" : "off"}</span>
      <span class="on">Timeouts and 5-minute forfeits</span>
      <span class="on">Reminders 15 min before</span>
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
        <div class="span-2"><h2 class="section-title">Current edition</h2><p class="small muted mt-1">Clock changes apply to every game that hasn't started yet, and to games made later.</p></div>
        <div class="field span-2"><label for="ed-name">Name</label><input class="input" id="ed-name" name="name" value="${esc(t.name)}" required></div>
        <div class="span-2">
          <p class="strong small">Clocks by stage <span class="hint">(minutes + seconds added per move)</span></p>
          <div class="clock-grid mt-3">${CLOCK_ROWS.map(([key, label, hint]) => {
            const f = formatOf(key, t);
            return `<div class="clock-row"><span><span class="small strong" style="display:block">${label}</span><span class="hint">${hint}</span></span>
              <label class="sr-only" for="ck-${key}-m">${label} minutes</label><input class="input sm" id="ck-${key}-m" name="ck-${key}-m" type="number" min="1" max="180" value="${f.minutes}">
              <span class="dim">+</span>
              <label class="sr-only" for="ck-${key}-i">${label} increment</label><input class="input sm" id="ck-${key}-i" name="ck-${key}-i" type="number" min="0" max="60" value="${f.increment}"></div>`;
          }).join("")}
            <div class="clock-row"><span><span class="small strong" style="display:block">Friendly matches</span><span class="hint">The suggested clock for a new friendly</span></span>
              <label class="sr-only" for="ed-min">Friendly minutes</label><input class="input sm" id="ed-min" name="minutes" type="number" min="1" max="180" value="${t.time_control_minutes}">
              <span class="dim">+</span>
              <label class="sr-only" for="ed-inc">Friendly increment</label><input class="input sm" id="ed-inc" name="increment" type="number" min="0" max="60" value="${t.increment_seconds}"></div>
          </div>
        </div>
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
        <div class="span-2"><h2 class="section-title">${icon("robot", "bold")} Autopilot</h2><p class="small muted mt-1">What the tournament does by itself. Timeouts, no-shows, standings, advancement and reminders always run.</p></div>
        <label class="row gap-3 span-2" style="cursor:pointer"><input type="checkbox" name="auto_tiebreak" ${t.auto_tiebreak ? "checked" : ""} style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2"><span><span class="strong small" style="display:block">Series tiebreaks</span><span class="hint">When a knockout series is level, create a ${clockLabel(formatOf("tiebreak", t))} tiebreak game with the colours of the last game reversed. If that is drawn too, a decider: the lower-ranked player picks the colour and a draw sends the higher-ranked player through. Switched off, you set the winner of a level series on the Knockout tab.</span></span></label>
        <label class="row gap-3 span-2" style="cursor:pointer"><input type="checkbox" name="auto_knockout" ${t.auto_knockout ? "checked" : ""} style="width:1.1rem;height:1.1rem;flex-shrink:0;accent-color:#d9dce2"><span><span class="strong small" style="display:block">Build the bracket after the groups</span><span class="hint">When the last group game ends, the round of 16 is drawn from the final tables.</span></span></label>
        <div class="field"><label for="ap-delay">Tiebreak and decider start after (minutes)</label><input class="input" id="ap-delay" name="delay" type="number" min="1" max="1440" value="${t.tiebreak_delay_minutes}"></div>
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
  return `<div class="stack gap-8">${form}${t ? countdownPanel(t) : ""}${autopilot}${list}</div>`;
}

// The countdown on the main page: a time and a line of text, saved on the
// edition beside the registration form links.
function countdownPanel(t) {
  const cd = countdownOf(t.registration);
  const left = cd ? cd.at - Date.now() : 0;
  const days = Math.floor(left / 86_400_000);
  // With the year, so a date set in the wrong year is easy to spot.
  const when = cd ? new Date(cd.at).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  const state = !cd
    ? "No countdown is set, so the main page shows none."
    : left <= 0
      ? `This time has passed (${when}), so the main page no longer shows it.`
      : `Counting down to ${when}: ${days > 0 ? `${days} day${days === 1 ? "" : "s"}` : "less than a day"} to go.`;
  return `<form class="panel pad form-grid md-2" data-form="countdown">
    <div class="span-2"><h2 class="section-title">${icon("hourglass-medium", "bold")} Main page countdown</h2>
      <p class="small muted mt-1" style="max-width:68ch">Shown on the first screen of the main page and again above the last "Register now" button. It disappears by itself once the time has passed.</p></div>
    <div class="field"><label for="cd-at">Counts down to</label><input class="input" id="cd-at" name="at" type="datetime-local" value="${cd ? toLocalInput(new Date(cd.at).toISOString()) : ""}"><p class="hint">Your local time. Visitors anywhere see the same moment.</p></div>
    <div class="field"><label for="cd-label">Line above the numbers</label><input class="input" id="cd-label" name="label" maxlength="60" value="${esc(t.registration?.countdown?.label ?? "")}" placeholder="${COUNTDOWN_LABEL}"><p class="hint">Leave empty for "${COUNTDOWN_LABEL}".</p></div>
    <p class="span-2 small muted">${esc(state)}</p>
    <div class="span-2" data-err></div>
    <div class="span-2 row gap-3 wrap"><button class="btn btn-primary" type="submit">Save countdown</button>
      ${cd ? `<button class="btn btn-ghost" type="button" data-action="countdown-remove">${icon("trash")} Remove countdown</button>` : ""}
      <a class="btn" href="index.html" target="_blank" rel="noopener">${icon("eye")} See the main page</a>
      <span data-msg class="small muted"></span></div>
  </form>`;
}

// Saves or clears it without touching the form links kept in the same field.
async function saveCountdown(countdown, button, errEl) {
  await withBusy(button, async () => {
    const registration = { ...(store.tournament.registration ?? {}) };
    if (countdown) registration.countdown = countdown;
    else delete registration.countdown;
    await updateTournament(store.tournament.id, { registration });
    await refresh();
    const m = app.querySelector("[data-form=countdown] [data-msg]");
    if (m) m.textContent = countdown ? "Saved. It is on the main page now." : "Removed.";
  }, errEl);
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
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th style="width:9rem"></th></tr></thead>
        <tbody>${visible
          .map(
            (p) => `<tr>
              <td><span style="font-weight:500">${esc(p.full_name)}</span>${p.school ? `<span class="xs dim" style="display:block">${esc(p.school)}</span>` : ""}</td>
              <td class="muted">${esc(p.email)}</td>
              <td>${ROLE_LABEL[p.role]}</td>
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
      <div class="field"><label for="pf-role">Role</label><select class="input" id="pf-role" name="role">${ROLES.map((r) => `<option value="${r}" ${r === (person?.role ?? "player") ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select></div>
      <div class="field"><label for="pf-school">School or club</label><input class="input" id="pf-school" name="school" value="${esc(person?.school ?? "")}"><p class="hint">Optional. Shown next to their name in the group tables.</p></div>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${person ? "Save changes" : "Create account"}</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
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
  return store.profiles.filter((p) => p.role === "player").sort((a, b) => a.full_name.localeCompare(b.full_name));
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
            .map((p) => `<option value="${p.id}" ${p.id === current?.player_id ? "selected" : ""}>${esc(p.full_name)}</option>`)
            .join("");
          return `<div class="slot"><span class="pot" title="Selection Round rank ${rankFor(g.label, seed)}">${rankFor(g.label, seed)}</span>
            <label class="sr-only" for="slot-${g.id}-${seed}">Group ${g.label}, rank ${rankFor(g.label, seed)}</label>
            <select class="input sm" id="slot-${g.id}-${seed}" data-slot data-group="${g.id}" data-seed="${seed}"><option value="">Empty</option>${options}</select></div>`;
        })
        .join("");
      return `<section class="panel" style="padding:1rem"><h3 class="display mb-3" style="font-size:var(--text-base)">Group ${g.label}</h3><div class="stack gap-2">${slots}</div></section>`;
    })
    .join("");

  return `<div class="stack gap-6">
    <div class="split">
      <p class="muted" style="max-width:66ch"><span class="num" style="color:var(--fg)">${store.groupPlayers.length}</span> of 32 players placed. The groups come from the Lichess Selection Round: enter the top 32 in rank order and each lands in their group, Group A holding ranks 1, 9, 17 and 25, Group B 2, 10, 18 and 26, and so on. The number beside each slot is its rank.</p>
      <div class="row gap-2 wrap">
        <button class="btn btn-ghost" data-action="clear-groups" ${store.groupPlayers.length ? "" : "disabled"}>Clear all</button>
        <button class="btn btn-ghost" data-action="draw" ${players.length < 32 ? "disabled" : ""} title="A random order, for rehearsals">${icon("shuffle", "bold")} Random order</button>
        <button class="btn btn-primary" data-action="ranking" ${players.length < 32 ? "disabled" : ""}>${icon("list-numbers", "bold")} Enter the Selection Round ranking</button>
      </div>
    </div>
    ${players.length < 32 ? notice(`You have ${players.length} player accounts. Add an account for each of the 32 qualifiers on the People tab first.`) : ""}
    ${hasFixtures ? notice("Group fixtures already exist. If you change the groups, generate the fixtures again on the Matches tab.") : ""}
    <div data-err></div>
    <div class="grid sm-2 xl-4 tight">${groups}</div>
    ${isAdmin ? testPanel() : ""}
  </div>`;
}

// ---------------------------------------------------------------- registrations tab (admins)

// People register in Google Forms: one each for players, campus
// ambassadors, partners and organisers. The links are saved on the edition.
// "Register now" on the main page asks which one the visitor wants, and
// says "Registration coming soon" while there are no links at all.
function registrationsTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first, then add its registration forms here.");
  const links = formLinks(store.tournament.registration);
  const open = FORM_KINDS.filter((k) => links[k.key]).length;
  const rows = FORM_KINDS.map((k) => {
    const link = links[k.key];
    return `<div class="field reg-form-row">
      <label for="reg-url-${k.key}">${icon(k.icon, "bold")} ${esc(k.label)}</label>
      <div class="row gap-2">
        <input class="input grow" id="reg-url-${k.key}" name="${k.key}" data-reg-url="${k.key}" type="url" inputmode="url" autocomplete="off" placeholder="https://forms.gle/..." value="${esc(ui.regDraft[k.key] ?? link ?? "")}">
        ${link ? `<a class="btn" href="${esc(link)}" target="_blank" rel="noopener" aria-label="Open the ${esc(k.label)} form" title="Open the form">${icon("arrow-square-out")}</a>` : ""}
      </div>
      <p class="hint">${link ? "On the main page now." : "No link: shown as \"Coming soon\" on the main page."}</p>
    </div>`;
  }).join("");
  return `<div class="stack gap-8">
    <section class="panel pad stack gap-4">
      <div class="split">
        <div>
          <h2 class="section-title">${icon("clipboard-text", "bold")} Registration forms</h2>
          <p class="small muted mt-1" style="max-width:66ch">"Register now" on the main page asks visitors what they want to register for, then opens that Google Form. Paste each form's link here. To close one, empty its box and save.</p>
        </div>
        <span class="badge">Main page now: ${open ? `Register now, ${open} of ${FORM_KINDS.length} forms open` : "Registration coming soon"}</span>
      </div>
      <form class="stack gap-4" data-form="reg-link">
        ${rows}
        <p class="hint">In Google Forms press Send, choose the link icon and copy the link. It starts with https://forms.gle/ or https://docs.google.com/forms/.</p>
        <div data-err>${ui.regErr ? notice(esc(ui.regErr), "error") : ""}</div>
        <div class="row gap-2 wrap">
          <button class="btn btn-primary" type="submit">${icon("floppy-disk", "bold")} Save links</button>
          <a class="btn" href="index.html" target="_blank" rel="noopener">${icon("eye")} See the main page</a>
          <span data-msg class="small muted">${esc(ui.regMsg)}</span>
        </div>
      </form>
    </section>
    <section class="panel pad">
      <h2 class="section-title">${icon("list-numbers", "bold")} How registration works</h2>
      <ol class="small muted mt-4 stack gap-2" style="padding-left:1.2rem;list-style:decimal;max-width:70ch">
        <li>Make each form in Google Forms and paste its link above.</li>
        <li>Visitors press "Register now", choose what they are registering for, and the form opens in a new tab.</li>
        <li>Answers arrive in Google Forms (and its spreadsheet), not here. When you have confirmed a player, create their account on the <a href="#people" style="text-decoration:underline">People</a> tab and send them their sign-in.</li>
        <li>With no links at all, the main page says "Registration coming soon".</li>
      </ol>
    </section>
  </div>`;
}

async function saveFormLinks(form) {
  const forms = {};
  const bad = [];
  for (const k of FORM_KINDS) {
    const raw = form[k.key].value.trim();
    forms[k.key] = formLink(raw);
    if (raw && !forms[k.key]) bad.push(k.label);
  }
  // Kept in the view state, so a live redraw doesn't wipe the message.
  ui.regErr = bad.length ? `${bad.join(", ")}: that doesn't look like a Google Form link. It should start with https://forms.gle/ or https://docs.google.com/forms/.` : "";
  if (ui.regErr) return draw();
  await withBusy(form.querySelector("[type=submit]"), async () => {
    await updateTournament(store.tournament.id, { registration: { ...(store.tournament.registration ?? {}), forms } });
    const open = Object.values(forms).filter(Boolean).length;
    ui.regMsg = open ? `Saved. ${open} of ${FORM_KINDS.length} forms are open on the main page.` : `Saved. The main page says "Registration coming soon".`;
    ui.regDraft = {};
    await refresh();
    ui.regMsg = "";
  }, app.querySelector("[data-err]"));
}

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
        <p class="small muted mt-1" style="max-width:70ch">Rehearse the whole tournament before the real one. Bots are marked <span class="bot-tag">Bot</span> everywhere. When you're done, one click removes every bot and every game they played.</p></div>
      ${n ? `<span class="badge">${n} bots in</span>` : ""}
    </div>
    <div class="steps">
      <div class="step"><span class="num dim xs">01</span><strong>Fill the groups</strong><p class="small muted">Adds a bot to each of the ${empty} empty slot${empty === 1 ? "" : "s"}. Real players already placed keep their slots.</p>
        <button class="btn btn-primary btn-sm" data-action="fill-bots" ${empty ? "" : "disabled"}>${icon("user-plus", "bold")} Fill ${empty} slot${empty === 1 ? "" : "s"}</button></div>
      <div class="step"><span class="num dim xs">02</span><strong>Play</strong><p class="small muted">Generate fixtures and schedule a round on the Matches tab. Bots make their own moves in the Arena whenever someone has their game open, so you can also play against them. Or finish everything at once:</p>
        <label class="row gap-2 xs muted" style="cursor:pointer"><input type="checkbox" id="sim-real" style="accent-color:#d9dce2"> Also finish games between real players</label>
        <button class="btn btn-sm" data-action="simulate-bots" ${n ? "" : "disabled"}>${icon("lightning", "bold")} Finish the whole tournament instantly</button>
        <p class="hint">Every unfinished bot game, round after round to the final${botGames ? ` (${botGames} waiting now)` : ""}.</p></div>
      <div class="step"><span class="num dim xs">03</span><strong>Clean up</strong><p class="small muted">Removes all bots, their games, the bracket built with them and the updates about those games.</p>
        <button class="btn btn-danger btn-sm" data-action="remove-bots" ${n ? "" : "disabled"}>${icon("trash", "bold")} Remove all test data</button></div>
    </div>
    <div data-test-msg class="mt-4">${ui.testMsg ? notice(ui.testMsg) : ""}</div>
  </section>`;
}

// The Selection Round result, typed or pasted in rank order. Names are
// matched to player accounts; each rank then has a box to check or change.
function rankingModal() {
  const players = playerPool();
  const byRank = Array.from({ length: 32 }, (_, i) => store.groupPlayers.find((gp) => rankOf(gp.player_id) === i + 1)?.player_id ?? "");
  const options = (selected) => `<option value="">Choose</option>${players.map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}`;
  const group = (rank) => String.fromCharCode(64 + ((rank - 1) % 8) + 1);
  const d = openModal(
    "Selection Round ranking",
    `<p class="muted">Enter the top 32 from the Lichess Selection Round, best first. Rank 1 goes to Group A, 2 to Group B and so on to 8 in Group H, then 9 back in Group A. This replaces the current groups.</p>
     <div class="field mt-4"><label for="rk-paste">Paste the names (optional)</label><textarea class="input" id="rk-paste" rows="4" placeholder="One name per line, rank 1 first. Lichess usernames work if they match a name on the People tab."></textarea>
       <div class="row gap-2 mt-2"><button class="btn btn-sm" type="button" data-fill>${icon("magic-wand", "bold")} Fill the ranks below</button><span class="xs muted" data-fill-msg></span></div></div>
     <div class="rank-grid mt-4">${byRank
       .map((id, i) => `<label class="rank-row"><span class="num strong">${i + 1}</span><span class="xs dim">${group(i + 1)}</span><select class="input sm" data-rank="${i + 1}">${options(id)}</select></label>`)
       .join("")}</div>
     <div data-err class="mt-4"></div>
     <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-confirm>${icon("check", "bold")} Place into groups</button></div>`,
    { wide: true },
  );
  const selects = [...d.querySelectorAll("[data-rank]")];
  const err = d.querySelector("[data-err]");
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  d.querySelector("[data-fill]").addEventListener("click", () => {
    const lines = d.querySelector("#rk-paste").value.split(/\r?\n/).map((l) => l.replace(/^\s*\d+[.)\s-]*/, "").trim()).filter(Boolean);
    const missing = [];
    lines.slice(0, 32).forEach((line, i) => {
      const p = players.find((x) => norm(x.full_name) === norm(line)) ?? players.find((x) => norm(x.full_name).startsWith(norm(line)));
      if (p) selects[i].value = p.id;
      else missing.push(`${i + 1}. ${line}`);
    });
    d.querySelector("[data-fill-msg]").textContent = missing.length ? `No account found for: ${missing.join(", ")}` : `Filled ${Math.min(lines.length, 32)} ranks.`;
  });
  const btn = d.querySelector("[data-confirm]");
  btn.addEventListener("click", () => {
    const ids = selects.map((s) => s.value);
    const empty = ids.map((id, i) => (id ? null : i + 1)).filter(Boolean);
    if (empty.length) {
      err.innerHTML = notice(`Choose a player for rank ${empty.join(", ")}.`, "error");
      return;
    }
    const twice = ids.find((id, i) => ids.indexOf(id) !== i);
    if (twice) {
      err.innerHTML = notice(`${esc(store.profileById.get(twice)?.full_name)} is in the list twice.`, "error");
      return;
    }
    withBusy(btn, async () => {
      await placeByRank(store.tournament.id, store.groups, ids.map((id) => store.profileById.get(id)));
      d.close();
      await refresh();
    }, err);
  });
}

// For rehearsals: the ticked players in a random Selection Round order.
function drawModal() {
  const players = playerPool();
  const placed = new Set(store.groupPlayers.map((gp) => gp.player_id));
  const preselected = new Set(placed.size === 32 ? placed : players.slice(0, 32).map((p) => p.id));
  const d = openModal(
    "Random order",
    `<p class="muted">For rehearsals. The 32 players you tick are given a random Selection Round rank and placed into the groups by it. This replaces the current groups.</p>
     <p class="small mt-4"><span class="num strong" data-count></span><span class="muted"> of 32 players selected</span></p>
     <div class="pick-list">${players
       .map((p) => `<label><input type="checkbox" value="${p.id}" ${preselected.has(p.id) ? "checked" : ""}><span class="grow truncate">${esc(p.full_name)}</span>${p.school ? `<span class="xs dim truncate">${esc(p.school)}</span>` : ""}</label>`)
       .join("")}</div>
     <div data-err class="mt-4"></div>
     <div class="modal-actions"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" data-confirm>${icon("shuffle", "bold")} Place in a random order</button></div>`,
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
      await randomDraw(store.tournament.id, store.groups, ids.map((id) => store.profileById.get(id)));
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
  // A knockout round is scheduled one game number at a time (all the game
  // 1s, then all the game 2s); tiebreak games schedule themselves.
  const ko = KNOCKOUT_STAGES.includes(round.key);
  const gameNos = ko ? [...new Set(roundMatches.filter((m) => m.game_kind === "game").map((m) => m.game_no))].sort((a, b) => a - b) : [];
  ui.gameNo = gameNos.includes(ui.gameNo) ? ui.gameNo : gameNos.find((n) => roundMatches.some((m) => m.game_no === n && m.game_kind === "game" && m.status === "scheduled")) ?? gameNos[0] ?? 1;
  const target = ko ? roundMatches.filter((m) => m.game_kind === "game" && m.game_no === ui.gameNo) : roundMatches;
  const first = target.find((m) => m.scheduled_at)?.scheduled_at ?? null;
  const pending = target.filter((m) => m.status === "scheduled").length;

  const chips = ROUNDS.map(
    (r) => `<button class="chip${r.key === ui.round ? " active" : ""}" data-action="round" data-round="${r.key}">${r.label}<span class="count">${store.matches.filter(r.test).length}</span></button>`,
  ).join("");

  const rows = roundMatches
    .map((m) => {
      const g = store.groups.find((x) => x.id === m.group_id);
      return `<div class="admin-row">
        <div class="grow">
          <span class="xs dim" style="display:block;margin-bottom:0.25rem">${isFriendly(m) ? matchContext(m) : m.stage === "group" ? `Group ${g?.label ?? ""}` : knockoutLabel(m)}${m.scheduled_at ? `, ${formatDateTime(m.scheduled_at)}` : ""}</span>
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
          ? `${groupGames.length} games made: every player meets the other three in their group twice, once with each colour, over six rounds.`
          : `Makes ${GROUP_GAMES} games at ${clockLabel(formatOf("group"))}: a double round robin in each group over six rounds. Rounds 4 to 6 repeat rounds 1 to 3 with the colours reversed.`}</p>
      </div>
      <button class="btn ${groupGames.length ? "" : "btn-primary"}" data-action="generate-fixtures" ${store.groupPlayers.length !== 32 ? "disabled" : ""}>${groupGames.length ? "Generate again" : "Generate fixtures"}</button>
    </section>
    ${store.groupPlayers.length !== 32 && !groupGames.length ? notice("Place all 32 players in groups first.") : ""}
    <div data-err></div>

    <section>
      <div class="chips">${chips}</div>
      ${round.key === "friendly"
        ? `<div class="panel pad split">
            <div><h2 class="section-title">Friendly matches</h2>
              <p class="small muted mt-1" style="max-width:62ch">Arrange a game between any two people, outside the groups and the bracket, with its own clock. Friendlies never count towards the group tables or the bracket.</p></div>
            <button class="btn btn-primary" data-action="new-friendly">${icon("plus", "bold")} New match</button>
          </div>
          ${roundMatches.length ? `<div class="panel pad-sm mt-4">${rows}</div>` : ""}`
        : roundMatches.length
        ? `<div class="panel pad split" style="align-items:flex-end">
            <div class="field grow">
              <label for="round-time">Start time for ${ko ? `game ${ui.gameNo} of every ${round.label.toLowerCase().replace(/s$/, "")} series` : `all of ${round.label.toLowerCase()}`}</label>
              <div class="row gap-2 wrap">
                ${gameNos.length > 1 ? `<select class="input" id="round-game" data-action-change="round-game" style="max-width:9rem">${gameNos.map((n) => `<option value="${n}" ${n === ui.gameNo ? "selected" : ""}>Game ${n}</option>`).join("")}</select>` : ""}
                <input id="round-time" type="datetime-local" class="input" style="max-width:20rem" value="${toLocalInput(first)}">
              </div>
              <p class="hint">Applies to the ${pending} games not yet started. Set individual times with the edit button.</p>
            </div>
            <button class="btn btn-primary" data-action="schedule-round">${icon("calendar-blank")} Schedule round</button>
          </div>
          <div class="panel pad-sm mt-4">${rows}</div>`
        : emptyState(`No ${round.label.toLowerCase()} games yet`, round.key.startsWith("g") ? "Generate the group fixtures above." : "A series' games appear as soon as both of its players are known. Tiebreak games are added when a series ends level.")}
    </section>
  </div>`;
}

// "Quarterfinal 3 · Game 2", "Final · Game 4", "Semifinal 1 · Tiebreak".
function knockoutLabel(m) {
  if (m.tiebreak_of) return `${STAGE_LABEL[m.stage]} Armageddon`;
  const base = m.stage === "final" || m.stage === "third" ? STAGE_LABEL[m.stage] : `${STAGE_LABEL[m.stage]} ${m.bracket_slot}`;
  const game = m.game_kind === "tiebreak" ? "Tiebreak" : m.game_kind === "decider" ? "Decider" : m.game_no ? `Game ${m.game_no}` : "";
  return game ? `${base} · ${game}` : base;
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
    isFriendly(m) ? "Friendly match" : m.stage === "group" ? `Group game, round ${m.round}` : knockoutLabel(m),
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
          <option value="0-0" ${m.result === "0-0" ? "selected" : ""}>Both forfeit (0 - 0)</option>
        </select>
        <p class="hint">Use this for a ruling, a game played elsewhere, or to correct a result. Standings, series scores, tiebreak games and the bracket follow automatically.${m.game_kind === "decider" && m.draw_winner_id ? ` In this decider a draw sends ${nameOf(m.draw_winner_id)} through.` : ""}</p>
      </div>
      <div class="field">
        <label for="mm-arbiter">Arbiter</label>
        <select class="input" id="mm-arbiter" name="arbiter"><option value="">No arbiter</option>${staffList().map((p) => `<option value="${p.id}" ${p.id === m.arbiter_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select>
        <p class="hint">Who on the organising team watches this game.</p>
      </div>
      <a class="btn btn-sm" href="play.html?id=${m.id}" style="align-self:flex-start">${icon("crown-simple", "bold")} Open in the Arena</a>
      ${knockout && m.series_id ? `<p class="hint">${icon("info")} The series decides who goes through. To overrule it, set the series winner on the Knockout tab.</p>` : ""}
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
  d.querySelector("[data-swap]").addEventListener("click", () => {
    [form.white.value, form.black.value] = [form.black.value, form.white.value];
  });

  d.querySelector("[data-reset]").addEventListener("click", (e) => {
    if (!confirm("Reset this game to the starting position? Moves, clocks and the result are cleared.")) return;
    withBusy(e.currentTarget, async () => {
      await resetGame(m.id);
      d.close();
      await refresh();
    }, err);
  });

  d.querySelector("[data-delete]")?.addEventListener("click", (e) => {
    if (!confirm("Delete this friendly match?")) return;
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
    const patch = started ? {} : { scheduled_at: fromLocalInput(form.when.value), white_id: white || null, black_id: black || null };
    if (result !== (m.result ?? "")) {
      patch.result = result || null;
      patch.status = result ? "completed" : m.move_count ? "live" : "scheduled";
      patch.end_reason = result ? "result recorded by staff" : null;
    }
    if ((form.arbiter.value || null) !== (m.arbiter_id ?? null)) patch.arbiter_id = form.arbiter.value || null;
    await withBusy(form.querySelector("[type=submit]"), async () => {
      if (Object.keys(patch).length) await updateMatch(m.id, patch);
      d.close();
      await refresh();
    }, err);
  });
}

function friendlyModal() {
  const people = store.profiles.slice().sort((a, b) => a.full_name.localeCompare(b.full_name));
  const options = people
    .map((p) => `<option value="${p.id}">${esc(p.full_name)}${p.role === "player" ? "" : ` · ${ROLE_LABEL[p.role]}`}</option>`)
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
      <div class="field"><label for="fm-when">Start time</label><input class="input" id="fm-when" name="when" type="datetime-local" required value="${toLocalInput(soon.toISOString())}"><p class="hint">Both players get an update now and a reminder 15 minutes before.</p></div>
      <div class="two-col">
        <div class="field"><label for="fm-min">Minutes each</label><input class="input" id="fm-min" name="minutes" type="number" min="1" max="180" value="${t?.time_control_minutes ?? 10}"></div>
        <div class="field"><label for="fm-inc">Increment (s)</label><input class="input" id="fm-inc" name="increment" type="number" min="0" max="60" value="${t?.increment_seconds ?? 5}"></div>
      </div>
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
  const existing = store.ties;
  const started = store.matches.some((m) => isKnockout(m) && m.series_id && (m.status !== "scheduled" || m.move_count > 0));
  const q = qualifiers(store.groups, store.groupPlayers, store.matches, store.profileById);
  const name = (id) => (id ? `${rankOf(id) ? `<span class="num xs dim">${rankOf(id)}</span> ` : ""}${esc(store.profileById.get(id)?.full_name ?? "Unknown")}` : `<span class="dim">To be decided</span>`);

  const cards = R16_PAIRINGS.map(([ga, pa, gb, pb], i) => {
    const m = existing.find((x) => x.stage === "r16" && x.bracket_slot === i + 1);
    const white = m ? m.white_id : q.get(ga)?.[pa - 1];
    const black = m ? m.black_id : q.get(gb)?.[pb - 1];
    return `<div class="panel small" style="padding:1rem"><p class="xs dim">Match ${i + 1}: ${ga}${pa} vs ${gb}${pb} · to QF ${Math.floor(i / 2) + 1}</p><p class="truncate mt-2" style="font-weight:500">${name(white)}</p><p class="truncate" style="font-weight:500">${name(black)}</p></div>`;
  }).join("");

  // Every series: its score, its games, and an override for the organisers.
  const order = (t) => KNOCKOUT_STAGES.indexOf(t.stage) * 10 + t.bracket_slot;
  const tieRow = (t) => {
    const s = seriesState(t);
    const label = t.stage === "final" || t.stage === "third" ? STAGE_LABEL[t.stage] : `${STAGE_LABEL[t.stage]} ${t.bracket_slot}`;
    const games = s.games
      .map((g) => `<button class="chip${g.status === "completed" ? " active" : ""}" data-action="edit-match" data-id="${g.id}" title="${esc(knockoutLabel(g))}">${g.game_kind === "game" ? `G${g.game_no}` : g.game_kind === "tiebreak" ? "TB" : "Dec"} ${g.result ? esc(g.result.replace("1/2-1/2", "½-½")) : g.scheduled_at ? formatTime(g.scheduled_at) : "unscheduled"}</button>`)
      .join("");
    const state = t.winner_id
      ? `<span class="badge">${esc(store.profileById.get(t.winner_id)?.full_name ?? "")} through</span>`
      : t.white_id && t.black_id
        ? `<button class="btn btn-ghost btn-sm" data-action="tie-winner" data-id="${t.id}">Set winner</button>`
        : "";
    return `<div class="admin-row" style="align-items:flex-start">
      <div class="grow">
        <span class="xs dim" style="display:block;margin-bottom:0.25rem">${label} · ${clockLabel(formatOf(t.stage))}</span>
        <span class="vs">${name(t.white_id)} <span class="num strong">${t.white_id && t.black_id ? `${formatPoints(s.a)} - ${formatPoints(s.b)}` : ""}</span> ${name(t.black_id)}</span>
        ${games ? `<div class="chips mt-2" style="margin-bottom:0">${games}</div>` : ""}
      </div>
      ${state}
    </div>`;
  };
  const series = existing.slice().sort((a, b) => order(a) - order(b)).map(tieRow).join("");

  return `<div class="stack gap-6">
    <section class="panel pad split">
      <div>
        <h2 class="section-title">Knockout bracket</h2>
        <p class="small muted mt-1" style="max-width:66ch">${existing.length
          ? "The bracket is set. Each series' games appear once both players are known: schedule them on the Matches tab. A level series gets its tiebreak game (and decider) automatically, and winners move on by themselves. The semifinal losers play for third place."
          : `Group stage: ${finished} of ${groupGames.length || GROUP_GAMES} games finished. The top two in each group go through. ${TIEBREAK_NOTE}${store.tournament.auto_knockout ? " The bracket builds itself when the last group game ends." : ""}`}</p>
      </div>
      <div class="row gap-2">
        ${existing.length ? `<a class="btn" href="bracket.html">View bracket</a>` : ""}
        <button class="btn ${existing.length ? "" : "btn-primary"}" data-action="generate-knockout" ${!groupGames.length || started ? "disabled" : ""}>${icon("tree-structure")} ${existing.length ? "Generate again" : "Generate bracket"}</button>
      </div>
    </section>
    ${started ? notice("Knockout games have started, so the bracket is locked. Fix individual games on the Matches tab.") : ""}
    <div data-err></div>
    ${series ? `<section><h3 class="small strong muted mb-3">Series</h3><div class="panel pad-sm">${series}</div></section>` : ""}
    <section>
      <h3 class="small strong muted mb-3">${existing.length ? "Round of 16 as generated" : "Round of 16 if the groups ended now"}</h3>
      <div class="grid sm-2 xl-4 tight">${cards}</div>
    </section>
  </div>`;
}

// The organisers decide a series: tiebreaks switched off, or a ruling.
function tieWinnerModal(tie) {
  const s = seriesState(tie);
  const player = (id) => `<label class="row gap-3" style="cursor:pointer;padding:0.4rem 0"><input type="radio" name="winner" value="${id}" style="accent-color:#d9dce2"><span>${esc(store.profileById.get(id)?.full_name ?? "")}</span></label>`;
  const d = openModal(
    "Set the series winner",
    `<form class="stack gap-4"><p class="muted">Series score ${formatPoints(s.a)} - ${formatPoints(s.b)}. The winner moves into the next round straight away${tie.stage === "sf" ? ", and the other player into the third-place series" : ""}. Unplayed games in this series stay as they are.</p>
      <div>${player(tie.white_id)}${player(tie.black_id)}</div>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">Confirm</button></div></form>`,
  );
  const form = d.querySelector("form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const winner = form.winner.value;
    if (!winner) return;
    withBusy(form.querySelector("[type=submit]"), async () => {
      await setTieWinner(tie.id, winner);
      d.close();
      await refresh();
    }, d.querySelector("[data-err]"));
  });
}

// ---------------------------------------------------------------- organising team tab

// Where admins and moderators run the event together: who is on duty, a
// shared task board, the team chat, and who arbitrates which game.

function staffList() {
  return store.profiles
    .filter((p) => (p.role === "admin" || p.role === "moderator") && !p.is_bot)
    .sort((a, b) => a.full_name.localeCompare(b.full_name));
}

function initials(name) {
  return (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
}

function teamName(id) {
  return esc(store.profileById.get(id)?.full_name ?? "Someone");
}

// Games still to be played that have both players.
function arbiterGames() {
  return store.matches.filter((m) => m.status !== "completed" && m.white_id && m.black_id).sort(sortByTime);
}

function taskOverdue(t) {
  return t.status !== "done" && t.due_at && new Date(t.due_at).getTime() < Date.now();
}

async function loadTeam() {
  const team = watch.team;
  const [tasks, messages] = await Promise.all([
    supabase.from("team_tasks").select("*").order("created_at"),
    supabase.from("team_messages").select("*").order("created_at", { ascending: false }).limit(200),
  ]);
  team.error = tasks.error?.message ?? messages.error?.message ?? "";
  team.tasks = tasks.data ?? [];
  team.messages = (messages.data ?? []).reverse();
  try {
    team.seenAt = Number(localStorage.getItem("amaze-team-seen")) || 0;
  } catch {
    team.seenAt = 0;
  }
  team.loaded = true;
}

// Tasks and chat arrive live; presence says who has the Control Room open.
function watchTeam() {
  const team = watch.team;
  const apply = (list) => (p) => {
    teamApply(list(), p.eventType === "DELETE" ? p.old : p.new, p.eventType === "DELETE");
    teamPatch();
  };
  supabase
    .channel("team-room")
    .on("postgres_changes", { event: "*", schema: "public", table: "team_tasks" }, apply(() => team.tasks))
    .on("postgres_changes", { event: "*", schema: "public", table: "team_messages" }, apply(() => team.messages))
    .subscribe();

  const room = supabase.channel("team-presence", { config: { presence: { key: profile.id } } });
  const announce = () => room.track({ user_id: profile.id, tab: currentTab() });
  room.on("presence", { event: "sync" }, () => {
    const online = new Map();
    for (const metas of Object.values(room.presenceState())) {
      for (const meta of metas) if (meta.user_id) online.set(meta.user_id, meta.tab);
    }
    team.online = online;
    if (currentTab() === "team") teamPatch();
  });
  room.subscribe((status) => {
    if (status === "SUBSCRIBED") announce();
  });
  window.addEventListener("hashchange", announce);
}

function teamApply(list, row, removed = false) {
  const i = list.findIndex((x) => x.id === row.id);
  if (removed) {
    if (i >= 0) list.splice(i, 1);
  } else if (i >= 0) list[i] = row;
  else list.push(row);
}

async function teamRun(query) {
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

// Team chat messages from others since this person last had the tab open.
function teamUnread() {
  const team = watch.team;
  return team.messages.filter((m) => m.author_id !== profile.id && new Date(m.created_at).getTime() > team.seenAt).length;
}

// After the tab is drawn: newest chat message in view, and nothing unread.
function teamShown() {
  const list = app.querySelector("[data-team=chat]");
  if (list) list.scrollTop = list.scrollHeight;
  watch.team.seenAt = Date.now();
  try {
    localStorage.setItem("amaze-team-seen", String(watch.team.seenAt));
  } catch {
    // Private windows may refuse storage; the count then resets per visit.
  }
}

// Redraws the parts of the tab that changed, leaving alone whatever the
// person is typing in or choosing from.
function teamPatch() {
  if (currentTab() !== "team") return scheduleDraw();
  if (!watch.team.loaded) return;
  const parts = { brief: teamBrief, roster: teamRoster, board: teamBoard, pinned: teamPinned, chat: teamChat, arbiters: teamArbiters };
  for (const [key, html] of Object.entries(parts)) {
    const el = app.querySelector(`[data-team="${key}"]`);
    if (!el) return calmDraw();
    if (el.contains(document.activeElement) && /SELECT|INPUT|TEXTAREA/.test(document.activeElement.tagName)) continue;
    el.innerHTML = html();
  }
  teamShown();
}

function teamTab() {
  const team = watch.team;
  if (!team.loaded) return `<p class="muted">Opening the team room...</p>`;
  const chip = (group, value, label, count) =>
    `<button class="chip${ui[group] === value ? " active" : ""}" data-action="team-filter" data-group="${group}" data-value="${value}">${label}${count == null ? "" : `<span class="count">${count}</span>`}</button>`;
  const games = arbiterGames();
  return `<div class="stack gap-8">
    ${team.error ? notice(esc(team.error), "error") : ""}
    <div data-err></div>
    <div class="grid sm-2 xl-4 tight" data-team="brief">${teamBrief()}</div>

    <section>
      <div class="split mb-4">
        <div><h2 class="section-title">${icon("users-three", "bold")} On duty</h2><p class="small muted mt-1">Admins and moderators. A green dot means they have the Control Room open right now.</p></div>
      </div>
      <div class="tm-roster" data-team="roster">${teamRoster()}</div>
    </section>

    <section>
      <div class="split mb-4">
        <div><h2 class="section-title">${icon("kanban", "bold")} Task board</h2><p class="small muted mt-1">What has to happen, who has it and by when. Everyone on the team sees changes straight away.</p></div>
        <button class="btn btn-primary" data-action="team-task-new">${icon("plus", "bold")} New task</button>
      </div>
      <div class="chips mb-4">${chip("taskFilter", "all", "Everyone's", team.tasks.length)}${chip("taskFilter", "mine", "Mine", team.tasks.filter((t) => t.assignee_id === profile.id).length)}</div>
      <div data-team="board">${teamBoard()}</div>
    </section>

    <div class="tm-split">
      <section class="panel tm-chat">
        <div class="tm-chat-head"><h2 class="section-title">${icon("chats-circle", "bold")} Team chat</h2><p class="xs dim mt-1">Only admins and moderators can read this.</p></div>
        <div data-team="pinned">${teamPinned()}</div>
        <div class="tm-chat-list" data-team="chat" aria-live="polite">${teamChat()}</div>
        <form class="tm-chat-form" data-form="team-chat">
          <label class="sr-only" for="tm-say">Message the team</label>
          <input class="input" id="tm-say" name="body" data-input="team-chat" maxlength="600" autocomplete="off" placeholder="Message the team" value="${esc(ui.chatDraft)}">
          <button class="btn btn-primary" type="submit" aria-label="Send">${icon("paper-plane-right", "bold")}</button>
        </form>
      </section>

      <section>
        <div class="split mb-4">
          <div><h2 class="section-title">${icon("gavel", "bold")} Arbiters</h2><p class="small muted mt-1">Put a name on every game, so each board has someone watching it.</p></div>
          <button class="btn" data-action="team-arb-share" ${games.some((m) => !m.arbiter_id) ? "" : "disabled"}>${icon("shuffle", "bold")} Share out evenly</button>
        </div>
        <div class="chips mb-4">${chip("arbFilter", "open", "No arbiter", games.filter((m) => !m.arbiter_id).length)}${chip("arbFilter", "mine", "Mine", games.filter((m) => m.arbiter_id === profile.id).length)}${chip("arbFilter", "all", "All games", games.length)}</div>
        <div class="panel pad-sm tm-arb-list" data-team="arbiters">${teamArbiters()}</div>
      </section>
    </div>
  </div>`;
}

function teamBrief() {
  const team = watch.team;
  const open = team.tasks.filter((t) => t.status !== "done");
  const overdue = open.filter(taskOverdue).length;
  const games = arbiterGames();
  const bare = games.filter((m) => !m.arbiter_id).length;
  const staff = staffList();
  const online = staff.filter((p) => team.online.has(p.id)).length;
  const tile = (v, k, sub, warn = false) => `<div class="panel stat-tile"><span class="v${warn ? " signal" : ""}">${v}</span><span class="k">${k}</span><span class="sub">${sub}</span></div>`;
  return (
    tile(online, "Online now", `of ${staff.length} on the team`) +
    tile(open.length, "Open tasks", `${open.filter((t) => t.assignee_id === profile.id).length} assigned to you`) +
    tile(overdue, "Overdue", overdue ? "Past their due time" : "Nothing is late", overdue > 0) +
    tile(bare, "Games without an arbiter", `of ${games.length} still to be played`, bare > 0 && games.length > 0)
  );
}

function teamRoster() {
  const team = watch.team;
  const games = arbiterGames();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return staffList()
    .map((p) => {
      const tab = team.online.get(p.id);
      const where = TABS.find((t) => t.id === tab)?.label;
      const open = team.tasks.filter((t) => t.assignee_id === p.id && t.status !== "done").length;
      const arb = games.filter((m) => m.arbiter_id === p.id).length;
      return `<article class="panel tm-member${tab ? " on" : ""}">
        <span class="tm-avatar">${esc(initials(p.full_name))}<i class="tm-dot" title="${tab ? "Online" : "Offline"}"></i></span>
        <div class="grow" style="min-width:0">
          <p class="strong truncate">${esc(p.full_name)}${p.id === profile.id ? ` <span class="xs dim">you</span>` : ""}</p>
          <p class="xs dim truncate">${ROLE_LABEL[p.role]} · ${tab ? `In the Control Room${where ? `, ${where}` : ""}` : "Offline"}</p>
          <p class="tm-pills"><span>${plural(open, "open task")}</span><span>${plural(arb, "game")} to arbitrate</span></p>
        </div>
      </article>`;
    })
    .join("");
}

function teamBoard() {
  const team = watch.team;
  if (!team.tasks.length) {
    return emptyState(
      "No tasks yet",
      "Add your own, or start from the standard checklist for running the tournament.",
      `<button class="btn" data-action="team-checklist">${icon("list-checks", "bold")} Add the standard checklist</button>`,
    );
  }
  const columns = [
    ["todo", "To do"],
    ["doing", "In progress"],
    ["done", "Done"],
  ];
  const shown = team.tasks.filter((t) => ui.taskFilter !== "mine" || t.assignee_id === profile.id);
  const byDue = (a, b) => (a.due_at ? new Date(a.due_at).getTime() : Infinity) - (b.due_at ? new Date(b.due_at).getTime() : Infinity) || new Date(a.created_at) - new Date(b.created_at);
  const card = (t, ci) => {
    const late = taskOverdue(t);
    const move = (to, glyph, label) => `<button class="icon-btn" data-action="team-task-move" data-id="${t.id}" data-to="${to}" aria-label="${label}" title="${label}">${icon(glyph, "bold")}</button>`;
    return `<article class="tm-task${late ? " late" : ""}${t.status === "done" ? " done" : ""}">
      <p class="small strong">${esc(t.title)}</p>
      ${t.notes ? `<p class="xs muted tm-notes">${esc(t.notes)}</p>` : ""}
      <p class="tm-pills">
        <span>${icon("user")} ${t.assignee_id ? teamName(t.assignee_id) : "Anyone"}</span>
        ${t.due_at ? `<span class="${late ? "late" : ""}">${icon("clock")} ${late ? "Was due" : "Due"} ${formatDateTime(t.due_at)}</span>` : ""}
      </p>
      <div class="tm-task-tools">
        ${ci > 0 ? move(columns[ci - 1][0], "arrow-left", `Move back to ${columns[ci - 1][1]}`) : ""}
        ${ci < 2 ? move(columns[ci + 1][0], ci === 1 ? "check" : "arrow-right", ci === 1 ? "Mark as done" : "Start this task") : ""}
        ${t.status !== "done" && t.assignee_id !== profile.id ? `<button class="btn btn-sm btn-ghost" data-action="team-task-take" data-id="${t.id}">I'll take it</button>` : ""}
        <span class="grow"></span>
        <button class="icon-btn" data-action="team-task-edit" data-id="${t.id}" aria-label="Edit task">${icon("pencil-simple")}</button>
        <button class="icon-btn danger" data-action="team-task-del" data-id="${t.id}" aria-label="Delete task">${icon("trash")}</button>
      </div>
    </article>`;
  };
  return `<div class="tm-board">${columns
    .map(([key, label], ci) => {
      const tasks = shown.filter((t) => t.status === key).sort(byDue);
      return `<section class="tm-col" data-col="${key}">
        <h3><span>${label}</span><span class="num xs dim">${tasks.length}</span></h3>
        ${tasks.length ? tasks.map((t) => card(t, ci)).join("") : `<p class="xs dim tm-none">Nothing here.</p>`}
      </section>`;
    })
    .join("")}</div>`;
}

function teamPinned() {
  const pinned = watch.team.messages.filter((m) => m.pinned);
  if (!pinned.length) return "";
  return `<div class="tm-pinned">${pinned
    .map((m) => `<p class="small">${icon("push-pin", "fill")}<span class="grow">${esc(m.body)} <span class="xs dim">${teamName(m.author_id)}</span></span><button class="icon-btn" data-action="team-pin" data-id="${m.id}" aria-label="Unpin" title="Unpin">${icon("x")}</button></p>`)
    .join("")}</div>`;
}

function teamChat() {
  const messages = watch.team.messages;
  if (!messages.length) return `<p class="small dim tm-none">No messages yet. Say hello, or leave a note for whoever is on duty next.</p>`;
  return messages
    .map((m) => {
      const mine = m.author_id === profile.id;
      return `<div class="tm-msg${mine ? " mine" : ""}">
        <span class="tm-avatar sm">${esc(initials(store.profileById.get(m.author_id)?.full_name))}</span>
        <div class="grow" style="min-width:0">
          <p class="xs dim"><span class="who">${mine ? "You" : teamName(m.author_id)}</span> · ${formatDateTime(m.created_at)}</p>
          <p class="small tm-body">${esc(m.body)}</p>
        </div>
        <span class="tm-msg-tools">
          <button class="icon-btn" data-action="team-pin" data-id="${m.id}" aria-label="${m.pinned ? "Unpin" : "Pin"} this message" title="${m.pinned ? "Unpin" : "Pin for the team"}">${icon("push-pin", m.pinned ? "fill" : "regular")}</button>
          ${mine || isAdmin ? `<button class="icon-btn danger" data-action="team-msg-del" data-id="${m.id}" aria-label="Delete this message">${icon("trash")}</button>` : ""}
        </span>
      </div>`;
    })
    .join("");
}

function teamArbiters() {
  const staff = staffList();
  const all = arbiterGames();
  if (!all.length) return `<p class="small dim tm-none">No games are waiting to be played. They appear here once the fixtures are made.</p>`;
  const games = all.filter((m) => (ui.arbFilter === "open" ? !m.arbiter_id : ui.arbFilter === "mine" ? m.arbiter_id === profile.id : true));
  if (!games.length) return `<p class="small dim tm-none">${ui.arbFilter === "open" ? "Every game has an arbiter." : "No games are assigned to you."}</p>`;
  const more = games.length - 40;
  return (
    games
      .slice(0, 40)
      .map(
        (m) => `<div class="admin-row tm-arb">
          <div class="grow" style="min-width:0">
            <span class="xs dim" style="display:block;margin-bottom:0.25rem">${esc(matchContext(m))}, ${m.scheduled_at ? formatDateTime(m.scheduled_at) : "not scheduled"}</span>
            <span class="vs">${playerHtml(m.white_id)}<span class="xs dim">vs</span>${playerHtml(m.black_id)}</span>
          </div>
          <label class="sr-only" for="arb-${m.id}">Arbiter</label>
          <select class="input sm" id="arb-${m.id}" data-arbiter="${m.id}"><option value="">No arbiter</option>${staff.map((p) => `<option value="${p.id}" ${p.id === m.arbiter_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select>
        </div>`,
      )
      .join("") + (more > 0 ? `<p class="xs dim tm-none">And ${more} more. Assign these first, or share them out evenly.</p>` : "")
  );
}

// The usual jobs for one edition, in order.
function standardChecklist() {
  return [
    ["Open registration and share the link", "Registrations tab: paste the Google Form links."],
    ["Review registrations and add the 32 players", "Check the Google Form answers, then create the accounts on the People tab."],
    ["Enter the Selection Round ranking", "After the Lichess Swiss: Groups tab, Enter the Selection Round ranking. The top 32 are placed into groups A to H by rank."],
    ["Generate the group fixtures and schedule the rounds", `Matches tab. ${GROUP_GAMES} games over six rounds (double round robin).`],
    ["Put an arbiter on every game", "Use Share out evenly below, then swap where needed."],
    ["Rehearse with test bots, then remove the test data", "Groups tab, Test with bots."],
    ["Message the players with the start time and the rules", "Tournament tab, Message everyone."],
    ["Run the knockout", `Schedule each series' games as players come through: two-game series to the semifinals and for third place, a four-game final. ${TOTAL_GAMES} games in all, plus any tiebreaks.`],
    ["Announce the champion and close the edition", "Set the edition to Complete."],
  ];
}

function taskModal(task) {
  const staff = staffList();
  const d = openModal(
    task ? "Edit task" : "New task",
    `<form class="stack gap-4">
      <div class="field"><label for="tk-title">Task</label><input class="input" id="tk-title" name="title" maxlength="120" required value="${esc(task?.title ?? "")}" placeholder="Schedule group round 2"></div>
      <div class="field"><label for="tk-notes">Notes</label><textarea class="input" id="tk-notes" name="notes" rows="3" maxlength="600" placeholder="Optional details">${esc(task?.notes ?? "")}</textarea></div>
      <div class="two-col">
        <div class="field"><label for="tk-who">Assigned to</label><select class="input" id="tk-who" name="who"><option value="">Anyone</option>${staff.map((p) => `<option value="${p.id}" ${p.id === task?.assignee_id ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}</select></div>
        <div class="field"><label for="tk-due">Due</label><input class="input" id="tk-due" name="due" type="datetime-local" value="${task?.due_at ? toLocalInput(task.due_at) : ""}"></div>
      </div>
      <div class="field"><label for="tk-status">Status</label><select class="input" id="tk-status" name="status">${[["todo", "To do"], ["doing", "In progress"], ["done", "Done"]].map(([v, l]) => `<option value="${v}" ${v === (task?.status ?? "todo") ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div data-err></div>
      <div class="modal-actions"><button class="btn" type="button" data-close>Cancel</button><button class="btn btn-primary" type="submit">${task ? "Save task" : "Add task"}</button></div>
    </form>`,
  );
  const form = d.querySelector("form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await withBusy(form.querySelector("[type=submit]"), async () => {
      const row = {
        title: form.title.value.trim(),
        notes: form.notes.value.trim() || null,
        assignee_id: form.who.value || null,
        due_at: form.due.value ? fromLocalInput(form.due.value) : null,
        status: form.status.value,
      };
      const saved = task
        ? await teamRun(supabase.from("team_tasks").update({ ...row, updated_at: new Date().toISOString() }).eq("id", task.id).select("*").single())
        : await teamRun(supabase.from("team_tasks").insert({ ...row, created_by: profile.id }).select("*").single());
      teamApply(watch.team.tasks, saved);
      if (saved.assignee_id && saved.assignee_id !== profile.id && saved.assignee_id !== task?.assignee_id) {
        await sendMessage([saved.assignee_id], "A task for you", saved.title, "admin.html#team");
      }
      d.close();
      draw();
    }, d.querySelector("[data-err]"));
  });
}

async function patchTask(id, patch) {
  const saved = await teamRun(supabase.from("team_tasks").update({ ...patch, updated_at: new Date().toISOString() }).eq("id", id).select("*").single());
  teamApply(watch.team.tasks, saved);
}

// Puts one person on one game, and tells them.
async function setArbiter(matchId, userId) {
  const saved = await updateMatch(matchId, { arbiter_id: userId || null });
  const i = store.matches.findIndex((m) => m.id === matchId);
  if (i >= 0) store.matches[i] = saved;
  if (userId && userId !== profile.id) {
    const names = [saved.white_id, saved.black_id].map((id) => store.profileById.get(id)?.full_name ?? "?").join(" vs ");
    await sendMessage([userId], "You're the arbiter", `${matchContext(saved)}: ${names}.`, `play.html?id=${matchId}`);
  }
}

// Gives every game without an arbiter to the team member with the fewest.
async function shareArbiters() {
  const staff = staffList();
  const games = arbiterGames();
  const load = new Map(staff.map((p) => [p.id, games.filter((m) => m.arbiter_id === p.id).length]));
  const given = new Map(staff.map((p) => [p.id, []]));
  for (const m of games.filter((x) => !x.arbiter_id)) {
    const next = staff.slice().sort((a, b) => load.get(a.id) - load.get(b.id))[0];
    load.set(next.id, load.get(next.id) + 1);
    given.get(next.id).push(m.id);
  }
  for (const [id, ids] of given) {
    if (!ids.length) continue;
    await teamRun(supabase.from("matches").update({ arbiter_id: id }).in("id", ids));
    if (id !== profile.id) await sendMessage([id], "You're the arbiter", `You have ${ids.length} more game${ids.length === 1 ? "" : "s"} to arbitrate.`, "admin.html#team");
  }
}

async function teamAction(el) {
  const team = watch.team;
  const err = app.querySelector("[data-err]");
  const id = el.dataset.id;
  const task = team.tasks.find((t) => t.id === id);
  switch (el.dataset.action) {
    case "team-filter":
      ui[el.dataset.group] = el.dataset.value;
      return draw();
    case "team-task-new":
      return taskModal(null);
    case "team-task-edit":
      return task && taskModal(task);
    case "team-task-move":
      return withBusy(el, async () => {
        await patchTask(id, { status: el.dataset.to });
        draw();
      }, err);
    case "team-task-take":
      return withBusy(el, async () => {
        await patchTask(id, { assignee_id: profile.id, status: task?.status === "todo" ? "doing" : task?.status });
        draw();
      }, err);
    case "team-task-del":
      if (!task || !confirm(`Delete the task "${task.title}"?`)) return;
      return withBusy(el, async () => {
        await teamRun(supabase.from("team_tasks").delete().eq("id", id));
        teamApply(team.tasks, { id }, true);
        draw();
      }, err);
    case "team-checklist":
      return withBusy(el, async () => {
        const rows = standardChecklist().map(([title, notes]) => ({ title, notes, created_by: profile.id }));
        const saved = await teamRun(supabase.from("team_tasks").insert(rows).select("*"));
        saved.forEach((row) => teamApply(team.tasks, row));
        draw();
      }, err);
    case "team-pin": {
      const msg = team.messages.find((m) => m.id === id);
      if (!msg) return;
      return withBusy(el, async () => {
        const saved = await teamRun(supabase.from("team_messages").update({ pinned: !msg.pinned }).eq("id", id).select("*").single());
        teamApply(team.messages, saved);
        teamPatch();
      }, err);
    }
    case "team-msg-del":
      if (!confirm("Delete this message for everyone on the team?")) return;
      return withBusy(el, async () => {
        await teamRun(supabase.from("team_messages").delete().eq("id", id));
        teamApply(team.messages, { id }, true);
        teamPatch();
      }, err);
    case "team-arb-take":
      return withBusy(el, async () => {
        await setArbiter(id, profile.id);
        draw();
      }, err);
    case "team-arb-share": {
      const bare = arbiterGames().filter((m) => !m.arbiter_id).length;
      const staff = staffList().length;
      if (!confirm(`Share ${bare} game${bare === 1 ? "" : "s"} between the ${staff} ${staff === 1 ? "person" : "people"} on the team? Games that already have an arbiter are left alone.`)) return;
      return withBusy(el, async () => {
        await shareArbiters();
        await refresh();
      }, err);
    }
  }
}

async function sendTeamMessage(form) {
  const body = form.body.value.trim();
  if (!body) return;
  await withBusy(form.querySelector("[type=submit]"), async () => {
    const saved = await teamRun(supabase.from("team_messages").insert({ author_id: profile.id, body }).select("*").single());
    teamApply(watch.team.messages, saved);
    ui.chatDraft = "";
    form.body.value = "";
    teamPatch();
    form.body.focus();
  }, app.querySelector("[data-err]"));
}

// ---------------------------------------------------------------- events

app.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  if (el.dataset.action.startsWith("team-")) return teamAction(el);
  const err = app.querySelector("[data-err]");
  const t = store.tournament;
  switch (el.dataset.action) {
    case "new-edition":
      return newEditionModal();
    case "countdown-remove":
      if (!confirm("Remove the countdown from the main page?")) return;
      return saveCountdown(null, el, app.querySelector("[data-form=countdown] [data-err]"));
    case "new-friendly":
      return friendlyModal();
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
        `<p class="muted">Every bot account is deleted, with every game a bot played, the knockout bracket and the updates about those games.</p>
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
    case "ranking":
      return rankingModal();
    case "tie-winner":
      return tieWinnerModal(store.ties.find((x) => x.id === el.dataset.id));
    case "round":
      ui.round = el.dataset.round;
      return draw();
    case "generate-fixtures":
      if (store.matches.some((m) => m.stage === "group") && !confirm("This deletes all group games, including any results, and makes them again from the current groups. Continue?")) return;
      return withBusy(el, async () => {
        await generateGroupFixtures(t, store.groups, store.groupPlayers);
        await refresh();
      }, err);
    case "schedule-round": {
      const value = app.querySelector("#round-time").value;
      if (!value) return;
      const round = ROUNDS.find((r) => r.key === ui.round);
      const ko = KNOCKOUT_STAGES.includes(round.key);
      return withBusy(el, async () => {
        await scheduleRound(store.matches.filter((m) => round.test(m) && (!ko || (m.game_kind === "game" && m.game_no === ui.gameNo))), fromLocalInput(value));
        await refresh();
      }, err);
    }
    case "edit-match":
      return matchModal(store.matches.find((m) => m.id === el.dataset.id));
    case "generate-knockout": {
      const groupGames = store.matches.filter((m) => m.stage === "group");
      const finished = groupGames.filter((m) => m.status === "completed").length;
      const warn = finished < groupGames.length ? `Only ${finished} of ${groupGames.length} group games are finished, so the tables may still change. ` : "";
      const replace = store.ties.length ? "This replaces the current bracket. " : "";
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
  const arbiter = e.target.closest("[data-arbiter]");
  if (arbiter) {
    await withBusy(null, () => setArbiter(arbiter.dataset.arbiter, arbiter.value), app.querySelector("[data-err]"));
    arbiter.blur();
    return draw();
  }
  if (e.target.id === "round-game") {
    ui.gameNo = Number(e.target.value);
    return draw();
  }
  const slot = e.target.closest("[data-slot]");
  if (!slot) return;
  slot.disabled = true;
  await withBusy(null, async () => {
    await setGroupSlot(store.tournament.id, slot.dataset.group, Number(slot.dataset.seed), slot.value || null);
  }, app.querySelector("[data-err]"));
  await refresh();
});

app.addEventListener("input", (e) => {
  if (e.target.dataset.input === "team-chat") ui.chatDraft = e.target.value;
  if (e.target.dataset.regUrl) ui.regDraft[e.target.dataset.regUrl] = e.target.value;
  if (e.target.dataset.input !== "search") return;
  ui.query = e.target.value;
  const pos = e.target.selectionStart;
  draw();
  const input = app.querySelector("[data-input=search]");
  input.focus();
  input.setSelectionRange(pos, pos);
});

app.addEventListener("submit", async (e) => {
  const link = e.target.closest("[data-form=reg-link]");
  if (link) {
    e.preventDefault();
    return saveFormLinks(link);
  }
  const chat = e.target.closest("[data-form=team-chat]");
  if (chat) {
    e.preventDefault();
    return sendTeamMessage(chat);
  }
  const cd = e.target.closest("[data-form=countdown]");
  if (cd) {
    e.preventDefault();
    const errEl = cd.querySelector("[data-err]");
    if (!cd.at.value) {
      errEl.innerHTML = notice("Choose the date and time to count down to.", "error");
      return;
    }
    return saveCountdown({ at: fromLocalInput(cd.at.value), label: cd.label.value.trim() }, cd.querySelector("[type=submit]"), errEl);
  }
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
    const format = {};
    for (const [key] of CLOCK_ROWS) {
      const minutes = Number(form[`ck-${key}-m`].value);
      const increment = Number(form[`ck-${key}-i`].value);
      if (!(minutes >= 1 && minutes <= 180 && increment >= 0 && increment <= 60)) throw new Error("Each clock needs 1 to 180 minutes and 0 to 60 seconds.");
      format[key] = { ...formatOf(key), minutes, increment };
    }
    const t = store.tournament;
    await updateTournament(t.id, {
      name: form.name.value.trim(),
      time_control_minutes: Number(form.minutes.value),
      increment_seconds: Number(form.increment.value),
      status: form.status.value,
      format,
    });
    // Games not started yet take the new clocks.
    for (const [key] of CLOCK_ROWS) {
      const f = format[key];
      const clock = { white_base_ms: f.minutes * 60_000, black_base_ms: f.minutes * 60_000, increment_ms: f.increment * 1000 };
      let q = supabase.from("matches").update(clock).eq("tournament_id", t.id).eq("status", "scheduled").eq("move_count", 0);
      if (key === "group") q = q.eq("stage", "group");
      else if (key === "tiebreak") q = q.in("game_kind", ["tiebreak", "decider"]);
      else q = q.eq("stage", key).eq("game_kind", "game");
      const { error } = await q;
      if (error) throw new Error(error.message);
    }
    await refresh();
    const m = app.querySelector("[data-msg]");
    if (m) m.textContent = "Saved.";
  }, msg);
});
