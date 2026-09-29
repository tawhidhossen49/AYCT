// Dashboard: the players' side of the portal.
//
// A player sees their own tournament: next game and countdown, updates,
// record, rating history, group table and results. Staff see the
// organiser's overview, and can open any player's dashboard (?player=<id>)
// to see exactly what that player sees.

import { isStaff } from "../auth.js";
import { store, effectiveStatus, involves, sortByTime, matchContext, bracketGames, isKnockout, timeControlLabel, tournamentUnrated } from "../store.js";
import { countdownHtml, formatDateTime, serverNow } from "../time.js";
import { formatPoints, groupStandings } from "../standings.js";
import { esc, groupTableHtml, icon, liveTag, matchRowHtml, playerHtml, resultText, sectionHead } from "../ui.js";
import { mountMiniBoards } from "../board.js";
import { feed, feedItemHtml, loadFeed, onFeed } from "../notify.js";
import { startPage } from "../page.js";

const STATUS_LINE = {
  setup: "The organisers are setting up this year's edition.",
  groups: "Group stage in progress. The top two in each group go through.",
  knockout: "Knockout stage. One game, one winner, every round.",
  complete: "The tournament is complete. A champion has been crowned.",
};
const STAGE_NAME = { group: "Group stage", r16: "Round of 16", qf: "Quarterfinal", sf: "Semifinal", final: "Final" };
const STAGE_ORDER = ["group", "r16", "qf", "sf", "final"];

// Whose dashboard this is, and their updates feed. Declared before the
// page draws for the first time.
const viewAsId = new URLSearchParams(location.search).get("player");
let subjectId = null;
let feedItems = [];

const { app, draw, redrawHero, profile } = await startPage("home", { render, hero, ticker });
mountMiniBoards(app);

if (subjectId === profile.id) {
  onFeed((f) => {
    feedItems = f.items;
    draw();
  });
} else if (subjectId) {
  feedItems = await loadFeed(subjectId);
  draw();
}

// Keep "live" and "in 2h" labels fresh, and redraw boards after updates.
setInterval(() => {
  redrawHero();
  draw();
}, 15_000);
new MutationObserver(() => mountMiniBoards(app)).observe(app, { childList: true });
app.addEventListener("change", (e) => {
  if (e.target.id !== "view-as") return;
  location.href = e.target.value ? `home.html?player=${e.target.value}` : "home.html";
});

// Whose dashboard to show. Players always see their own.
function subjectFor(p) {
  if (p.role === "player") return p.id;
  if (isStaff(p.role) && viewAsId && store.profileById.has(viewAsId)) return viewAsId;
  return null;
}

// "Amaze Youth Chess Tournament 2027" -> bold "Amaze Youth Chess", light "Tournament 2027".
function splitName(name) {
  const i = name.toLowerCase().lastIndexOf("tournament");
  return i > 0 ? [name.slice(0, i).trim(), name.slice(i)] : [name, ""];
}

// ---------------------------------------------------------------- header band

function hero(p) {
  const band = heroBand(p);
  if (band.lede && tournamentUnrated()) band.lede += " This is an unrated tournament: ratings don't change.";
  return band;
}

function heroBand(p) {
  subjectId = subjectFor(p);
  const first = esc(p.full_name.split(" ")[0]);
  const t = store.tournament;
  if (!t) {
    return {
      scene: "king",
      eyebrow: `Welcome back, ${first}`,
      bold: "The board",
      soft: "is set.",
      lede: isStaff(p.role)
        ? "Create this year's edition to start adding players, drawing groups and scheduling games."
        : "The organisers are preparing this year's tournament. Your group and fixtures will appear here soon.",
      actions: isStaff(p.role) ? `<a class="btn btn-primary btn-lg" href="admin.html#tournament" data-magnetic>Set up the tournament ${icon("arrow-right", "bold")}</a>` : "",
    };
  }

  const now = serverNow();
  const games = bracketGames(store.matches);
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").length;
  const played = games.filter((m) => m.status === "completed").length;
  const entrants = store.groupPlayers.length || store.profiles.filter((x) => x.role === "player").length;

  if (subjectId) {
    const who = store.profileById.get(subjectId);
    const next = nextGame(subjectId);
    const mine = subjectId === p.id;
    const opp = next ? store.profileById.get(next.white_id === subjectId ? next.black_id : next.white_id) : null;
    const isLive = next && effectiveStatus(next, now) === "live";
    const rec = record(subjectId);
    return {
      scene: "king",
      shift: "26%",
      eyebrow: mine ? `Welcome back, ${first}` : "Player dashboard",
      bold: mine ? "Your" : who.full_name.split(" ")[0],
      soft: mine ? "tournament." : "at a glance.",
      lede: next
        ? `${mine ? "Your" : "Their"} ${isLive ? "game is live" : "next game"}: ${opp ? `against ${esc(opp.full_name)}` : "opponent to be decided"}${isLive ? "" : `, ${formatDateTime(next.scheduled_at)}`}.`
        : STATUS_LINE[t.status],
      actions: next ? `<a class="btn btn-primary btn-lg" href="play.html?id=${next.id}" data-magnetic>${isLive ? (mine ? "Play now" : "Watch now") : "Enter the Arena"} ${icon("arrow-right", "bold")}</a>` : "",
      stats: [
        { value: who.rating, label: "Rating" },
        { value: `${rec.w}-${rec.d}-${rec.l}`, label: "Won-drawn-lost" },
        { value: formatPoints(rec.points), label: "Points" },
      ],
    };
  }

  const [bold, soft] = splitName(t.name);
  return {
    scene: "king",
    shift: "26%",
    eyebrow: `Welcome back, ${first}`,
    bold,
    soft,
    lede: STATUS_LINE[t.status],
    stats: [
      { value: entrants, label: "Players" },
      { value: live, label: "Live now", live: live > 0 },
      { value: played, label: `of ${games.length || 63} games played` },
    ],
  };
}

function ticker() {
  const t = store.tournament;
  return [t?.name ?? "Amaze Youth Chess Tournament", "32 Players", "8 Groups", "63 Games", "One Champion", "Think. Play. Become legendary."];
}

// ---------------------------------------------------------------- derived player data

function nextGame(id) {
  const now = serverNow();
  const mine = store.matches.filter((m) => involves(m, id) && m.status !== "completed" && m.scheduled_at).sort(sortByTime);
  return mine.find((m) => effectiveStatus(m, now) === "live") ?? mine[0] ?? null;
}

function scoreFor(m, id) {
  if (m.result === "1/2-1/2") return 0.5;
  return (m.result === "1-0") === (m.white_id === id) ? 1 : 0;
}

// Tournament record: group and bracket games (not Armageddon tiebreaks or
// friendly matches).
function record(id) {
  const done = bracketGames(store.matches).filter((m) => involves(m, id) && m.status === "completed" && m.result);
  const r = { w: 0, d: 0, l: 0, points: 0, games: done.length };
  for (const m of done) {
    const s = scoreFor(m, id);
    r.points += s;
    if (s === 1) r.w += 1;
    else if (s === 0.5) r.d += 1;
    else r.l += 1;
  }
  return r;
}

// Where the player stands in the tournament, in a few words.
function standing(id) {
  const ko = bracketGames(store.matches).filter((m) => isKnockout(m) && involves(m, id));
  if (ko.length) {
    const deepest = ko.sort((a, b) => STAGE_ORDER.indexOf(b.stage) - STAGE_ORDER.indexOf(a.stage))[0];
    if (deepest.stage === "final" && deepest.winner_id === id) return { value: "Champion", sub: "Won the final" };
    if (deepest.winner_id && deepest.winner_id !== id) return { value: "Out", sub: `Lost in the ${STAGE_NAME[deepest.stage]}` };
    return { value: STAGE_NAME[deepest.stage], sub: deepest.winner_id === id ? "Through to the next round" : "Still in" };
  }
  const gp = store.groupPlayers.find((x) => x.player_id === id);
  if (!gp) return { value: "-", sub: "Not drawn yet" };
  const g = store.groups.find((x) => x.id === gp.group_id);
  const table = groupStandings(gp.group_id, store.groupPlayers, store.matches, store.profileById);
  const rank = table.findIndex((r) => r.playerId === id) + 1;
  const games = store.matches.filter((m) => m.group_id === gp.group_id);
  const done = games.length > 0 && games.every((m) => m.status === "completed");
  const suffix = ["th", "st", "nd", "rd"][rank] ?? "th";
  const note = done ? (rank <= 2 ? " · qualified" : " · eliminated") : rank <= 2 ? " · qualifying place" : "";
  return { value: `${rank}${suffix}`, sub: `Group ${g?.label ?? ""}${note}` };
}

// Ratings after each rated game, oldest first, ending at today's rating.
function ratingHistory(id) {
  const p = store.profileById.get(id);
  const games = store.matches
    .filter((m) => involves(m, id) && m.status === "completed" && m.ratings_applied)
    .sort((a, b) => new Date(a.ended_at ?? a.updated_at) - new Date(b.ended_at ?? b.updated_at));
  const deltas = games.map((m) => (m.white_id === id ? m.white_rating_delta : m.black_rating_delta) ?? 0);
  let r = p.rating - deltas.reduce((a, b) => a + b, 0);
  const points = [{ rating: r, label: "Start" }];
  games.forEach((m, i) => {
    r += deltas[i];
    points.push({ rating: r, label: matchContext(m), delta: deltas[i] });
  });
  return points;
}

// ---------------------------------------------------------------- content

function render(p) {
  subjectId = subjectFor(p);
  if (!store.tournament) return isStaff(p.role) ? firstSteps() : "";
  if (subjectId) return (isStaff(p.role) ? viewAsBar(p) : "") + dashboard(subjectId, p);
  return overview(p);
}

function viewAsBar(p) {
  const players = store.profiles.filter((x) => x.role === "player").sort((a, b) => a.full_name.localeCompare(b.full_name));
  return `<div class="view-as mb-6">
    ${icon("eye", "bold")}<span>${subjectId ? `Viewing <strong>${esc(store.profileById.get(subjectId)?.full_name)}</strong>'s dashboard, as they see it.` : "See any player's dashboard as they see it."}</span>
    <label for="view-as" class="sr-only">Choose a player</label>
    <select id="view-as" class="input sm ml-auto"><option value="">Organiser overview</option>${players.map((x) => `<option value="${x.id}" ${x.id === subjectId ? "selected" : ""}>${esc(x.full_name)}</option>`).join("")}</select>
    ${isStaff(p.role) ? `<a class="btn btn-sm" href="admin.html">Control room</a>` : ""}
  </div>`;
}

function dashboard(id, viewer) {
  const who = store.profileById.get(id);
  const mine = id === viewer.id;
  const rec = record(id);
  const st = standing(id);
  const hist = ratingHistory(id);
  const change = who.rating - hist[0].rating;
  const next = nextGame(id);
  const myGroup = store.groups.find((g) => store.groupPlayers.some((gp) => gp.group_id === g.id && gp.player_id === id));
  const results = store.matches
    .filter((m) => involves(m, id) && m.status === "completed")
    .sort((a, b) => new Date(b.ended_at ?? 0) - new Date(a.ended_at ?? 0));
  const upcoming = store.matches.filter((m) => involves(m, id) && m.status !== "completed" && m.id !== next?.id).sort(sortByTime);

  const tiles = `<div class="stat-tiles" data-stagger="load">
    <div class="panel stat-tile"><span class="v">${who.rating}</span><span class="k">Rating</span><span class="sub">${tournamentUnrated() ? "Unrated tournament: no change" : change === 0 ? "No change yet" : `${change > 0 ? "+" : ""}${change} this tournament`}</span></div>
    <div class="panel stat-tile"><span class="v">${rec.w}<span class="dim">-</span>${rec.d}<span class="dim">-</span>${rec.l}</span><span class="k">Won-drawn-lost</span><span class="sub">${rec.games} game${rec.games === 1 ? "" : "s"} played</span></div>
    <div class="panel stat-tile"><span class="v">${formatPoints(rec.points)}</span><span class="k">Points</span><span class="sub">Win 1, draw ½</span></div>
    <div class="panel stat-tile"><span class="v">${esc(st.value)}</span><span class="k">Standing</span><span class="sub">${esc(st.sub)}</span></div>
  </div>`;

  const updates = `<section class="panel pad-sm feed-panel">
    <div class="row between" style="padding:0.85rem 1rem 0.35rem"><h3 class="eyebrow">Updates</h3>${mine && feed.unread ? `<span class="badge">${feed.unread} new</span>` : ""}</div>
    ${feedItems.length ? feedItems.slice(0, 8).map(feedItemHtml).join("") : `<p class="small dim" style="padding:0.5rem 1rem 1rem">Nothing yet. Game times, results, advancement and messages from the arbiter appear here.</p>`}
  </section>`;

  return `<div>
    <section class="s-block">${tiles}</section>

    <section class="s-block">
      ${sectionHead(mine ? "Your tournament" : "Their tournament", "Next", "up.")}
      <div class="grid lg-hero">
        ${nextGameHero(next, id, mine)}
        ${updates}
      </div>
    </section>

    <section class="s-block">
      ${sectionHead("Form", "Rating", "history.", `${hist.length - 1} rated game${hist.length === 2 ? "" : "s"}. Elo, K = 32. ${tournamentUnrated() ? "This tournament is unrated, so its games don't appear here." : "Armageddon games are not rated."}`)}
      <div class="panel pad">${ratingChart(hist)}</div>
    </section>

    <section class="s-block">
      ${sectionHead("Games", mine ? "Your" : "Their", "games.", "Open a finished game to replay it with a Stockfish review.")}
      <div class="grid lg-hero">
        <div class="stack gap-6">
          ${upcoming.length ? `<section class="panel pad-sm"><h3 class="eyebrow" style="padding:0.85rem 1rem 0.35rem">Coming up</h3>${upcoming.map((m) => matchRowHtml(m, id)).join("")}</section>` : ""}
          ${results.length ? `<section class="panel pad-sm"><h3 class="eyebrow" style="padding:0.85rem 1rem 0.35rem">Results</h3>${results.map((m) => resultRow(m, id)).join("")}</section>` : `<div class="panel pad muted">No games played yet.</div>`}
        </div>
        <div>${myGroup ? groupTableHtml(myGroup, { me: id, compact: true }) : `<div class="panel pad muted">Not drawn into a group yet.</div>`}</div>
      </div>
    </section>
  </div>`;
}

function resultRow(m, id) {
  const s = m.result ? scoreFor(m, id) : null;
  const opp = m.white_id === id ? m.black_id : m.white_id;
  const d = m.white_id === id ? m.white_rating_delta : m.black_rating_delta;
  const mark = s === 1 ? "Won" : s === 0.5 ? "Drew" : "Lost";
  return `<a href="play.html?id=${m.id}" class="match-row">
    <span class="context">${esc(matchContext(m))}</span>
    <span class="sides"><span class="side"><span class="colour-dot ${m.white_id === id ? "white" : "black"}" aria-label="${m.white_id === id ? "white" : "black"}"></span><span class="small dim">vs</span> ${playerHtml(opp)}</span><span class="context-mobile">${esc(matchContext(m))}${m.end_reason ? ` · ${esc(m.end_reason)}` : ""}</span></span>
    <span class="status"><span class="num small strong">${mark} ${resultText(m)}</span><span class="xs ${d < 0 ? "signal" : "dim"}">${d != null ? `${d > 0 ? "+" : ""}${d}` : "Review"}</span></span>
  </a>`;
}

function ratingChart(points) {
  if (points.length < 2) {
    return `<p class="muted small">The chart starts after the first rated game. Starting rating: <span class="num strong" style="color:var(--fg)">${points[0].rating}</span>.</p>`;
  }
  const W = 600;
  const H = 180;
  const pad = 18;
  const values = points.map((p) => p.rating);
  const min = Math.min(...values) - 10;
  const max = Math.max(...values) + 10;
  const x = (i) => pad + (i / (points.length - 1)) * (W - pad * 2);
  const y = (v) => H - pad - ((v - min) / (max - min)) * (H - pad * 2);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.rating).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${pad},${H - pad} Z`;
  const dots = points
    .map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.rating).toFixed(1)}" r="3.5" fill="#07070a" stroke="#e4e7ec" stroke-width="1.5"><title>${esc(p.label)}: ${p.rating}${p.delta != null ? ` (${p.delta > 0 ? "+" : ""}${p.delta})` : ""}</title></circle>`)
    .join("");
  return `<div class="row between mb-3"><span class="num dim small">${points[0].rating}</span><span class="num strong">${points[points.length - 1].rating}</span></div>
    <svg class="rating-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Rating history">
      <defs><linearGradient id="rc" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e4e7ec" stop-opacity="0.28"/><stop offset="1" stop-color="#e4e7ec" stop-opacity="0"/></linearGradient></defs>
      <path d="${area}" fill="url(#rc)"/>
      <path d="${line}" fill="none" stroke="#e4e7ec" stroke-width="2" vector-effect="non-scaling-stroke"/>
      ${dots}
    </svg>`;
}

function nextGameHero(m, id, mine) {
  const art = `<img class="art" src="assets/brand/scenes/rising.webp" alt="" aria-hidden="true">`;
  if (!m) {
    return `<div class="panel lit hero" style="justify-content:flex-end">${art}
      <i class="ph ph-hourglass dim" style="font-size:28px"></i>
      <h3 class="hero-empty-title mt-4">No game scheduled yet</h3>
      <p class="muted mt-2" style="max-width:44ch">When the organisers set the next game, the countdown starts here and an update arrives in the bell.</p>
    </div>`;
  }
  const live = effectiveStatus(m, serverNow()) === "live";
  const white = m.white_id === id;
  return `<div class="panel lit hero">${art}
    <div class="row gap-3">${live ? liveTag() : `<span class="eyebrow">${mine ? "Your" : "Their"} next game</span>`}<span class="small dim">${esc(matchContext(m))} · ${timeControlLabel(m)}</span></div>
    <div class="mt-6">
      <p class="small muted">${mine ? "You play" : "Plays"} ${white ? "white" : "black"} against</p>
      <p class="opponent">${playerHtml(white ? m.black_id : m.white_id)}</p>
      ${m.draw_odds ? `<p class="small muted mt-2">${icon("lightning", "bold")} Armageddon: ${white ? "White must win" : "a draw is enough for Black"}.</p>` : ""}
    </div>
    <div class="hero-foot">
      ${live
        ? `<p class="muted" style="max-width:36ch">${mine ? "Your clock may already be running. Head to the board." : "This game is being played now."}</p>`
        : `<div>${countdownHtml(m.scheduled_at, { big: true })}<p class="small dim mt-3">${formatDateTime(m.scheduled_at)}</p></div>`}
      <a class="btn btn-lg ${live ? "btn-primary" : ""}" href="play.html?id=${m.id}">${live ? (mine ? "Play now" : "Watch") : "Enter the Arena"} <i class="ph-bold ph-arrow-right"></i></a>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- organiser and commentator overview

function overview(p) {
  const now = serverNow();
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").sort(sortByTime);
  const upcoming = store.matches.filter((m) => effectiveStatus(m, now) === "scheduled" && m.scheduled_at).sort(sortByTime);
  return `<div>
    ${isStaff(p.role) ? viewAsBar(p) : ""}
    ${store.tournament.status === "complete" ? `<section class="s-block">${champion()}</section>` : ""}
    ${isStaff(p.role) ? `<section class="s-block">${sectionHead("Organiser", "Tournament", "setup.", "Work through these in order. Each step opens the right Control Room tab.")}${checklist()}</section>` : ""}
    <section class="s-block">
      ${sectionHead("On the boards", "Live", "now.", live.length ? `${live.length} game${live.length === 1 ? "" : "s"} in progress. Open one to watch.` : "")}
      ${live.length ? `<div class="grid sm-2 lg-4" data-stagger>${live.map(liveCard).join("")}</div>` : `<div class="panel pad muted">No games are being played right now.</div>`}
    </section>
    <section class="s-block">
      ${sectionHead("Schedule", "Coming", "up.", `<a href="fixtures.html" class="btn btn-sm">All fixtures ${icon("arrow-right")}</a>`)}
      ${upcoming.length ? `<div class="panel pad-sm">${upcoming.slice(0, 6).map((m) => matchRowHtml(m, p.id)).join("")}</div>` : `<div class="panel pad muted">Nothing scheduled yet.</div>`}
    </section>
  </div>`;
}

// Before any edition exists: the three first steps, as cards.
function firstSteps() {
  const steps = [
    { n: "01", title: "Create the edition", body: "Name this year's tournament and set the clock. Eight empty groups are made for you.", href: "admin.html#tournament", cta: "Create edition" },
    { n: "02", title: "Add the players", body: "Give each of the 32 players, moderators and commentators an email and password.", href: "admin.html#people", cta: "Add people" },
    { n: "03", title: "Run the draw", body: "A seeded draw places one player from each rating pot into every group.", href: "admin.html#groups", cta: "Open the draw" },
  ];
  return `<section class="s-block">
    ${sectionHead("Getting started", "Three steps", "to the first move.")}
    <div class="grid lg-3" data-stagger="load">${steps
      .map(
        (s) => `<a class="panel lit pad step-card" href="${s.href}">
          <span class="num dim">${s.n}</span>
          <h3>${s.title}</h3>
          <p class="muted">${s.body}</p>
          <span class="btn btn-sm mt-6">${s.cta} ${icon("arrow-right")}</span>
        </a>`,
      )
      .join("")}</div>
  </section>`;
}

function champion() {
  const final = store.matches.find((m) => m.stage === "final" && !m.tiebreak_of);
  const p = final?.winner_id ? store.profileById.get(final.winner_id) : null;
  if (!p) return "";
  return `<div class="panel lit pad champion">
    <i class="ph-fill ph-crown" style="font-size:28px;color:var(--chrome)"></i>
    <p class="eyebrow mt-4">Champion</p>
    <p class="display chrome-text mt-2" style="font-size:clamp(2rem,5vw,4rem);padding-bottom:0.25rem">${esc(p.full_name)}</p>
  </div>`;
}

function checklist() {
  const players = store.profiles.filter((p) => p.role === "player").length;
  const groupGames = store.matches.filter((m) => m.stage === "group");
  const scheduled = groupGames.filter((m) => m.scheduled_at).length;
  const finished = groupGames.filter((m) => m.status === "completed").length;
  const knockout = bracketGames(store.matches).filter(isKnockout);
  const steps = [
    { label: "Player accounts", detail: `${players} of 32`, done: players >= 32, href: "admin.html#people" },
    { label: "Groups drawn", detail: `${store.groupPlayers.length} of 32 placed`, done: store.groupPlayers.length === 32, href: "admin.html#groups" },
    { label: "Group fixtures", detail: groupGames.length ? `${groupGames.length} games, ${scheduled} scheduled` : "Not generated", done: groupGames.length === 48 && scheduled === 48, href: "admin.html#matches" },
    { label: "Group stage played", detail: `${finished} of ${groupGames.length || 48} finished`, done: groupGames.length > 0 && finished === groupGames.length, href: "admin.html#live" },
    { label: "Knockout bracket", detail: knockout.length ? "Generated" : store.tournament.auto_knockout ? "Builds itself after the last group game" : "Not generated", done: knockout.length > 0, href: "admin.html#knockout" },
    { label: "Champion crowned", detail: store.tournament.status === "complete" ? "Done" : "Pending", done: store.tournament.status === "complete", href: "bracket.html" },
  ];
  const next = steps.find((s) => !s.done);
  return `<div class="panel lit pad" data-reveal="load" data-delay="0.2">
    ${next ? `<div class="row between wrap gap-4"><p class="muted">Next step: <strong style="color:var(--fg)">${next.label}</strong></p><a class="btn btn-primary btn-sm" href="${next.href}">Continue <i class="ph-bold ph-arrow-right"></i></a></div>` : ""}
    <ol class="checklist">${steps
      .map(
        (s) => `<li><a href="${s.href}">
          <i class="check-icon ${s.done ? "ph-fill ph-check-circle done" : "ph ph-circle"}"></i>
          <span><span class="step-label${s.done ? " done" : ""}">${s.label}</span><span class="step-detail">${s.detail}</span></span>
        </a></li>`,
      )
      .join("")}</ol>
  </div>`;
}

function liveCard(m) {
  return `<a class="panel live-card" href="play.html?id=${m.id}">
    <div class="meta"><span>${esc(matchContext(m))}</span><span class="num">Move ${Math.ceil(m.move_count / 2) || 1}</span></div>
    <div class="who mb-3">${playerHtml(m.black_id)}</div>
    <div class="mini-board" data-mini-fen="${esc(m.fen)}"></div>
    <div class="who mt-3">${playerHtml(m.white_id)}</div>
  </a>`;
}
