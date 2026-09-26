import { isStaff } from "../auth.js";
import { store, effectiveStatus, involves, sortByTime, matchContext, STAGE_LABEL } from "../store.js";
import { countdownHtml, formatDateTime, serverNow } from "../time.js";
import { esc, emptyState, groupTableHtml, icon, liveTag, matchRowHtml, playerHtml } from "../ui.js";
import { mountMiniBoards } from "../board.js";
import { startPage } from "../page.js";

const { app, draw } = await startPage("home", { render });
mountMiniBoards(app);

// Keep "live" and "in 2h" labels fresh, and redraw boards after updates.
setInterval(draw, 15_000);
new MutationObserver(() => mountMiniBoards(app)).observe(app, { childList: true });

function render(profile) {
  if (!store.tournament) {
    return isStaff(profile.role)
      ? emptyState("No tournament yet", "Create this year's edition to start adding players, drawing groups and scheduling games.", `<a class="btn btn-primary" href="admin.html#tournament">Set up the tournament</a>`)
      : emptyState("The tournament isn't set up yet", "Check back soon. Your group and fixtures will appear here once the organisers publish them.");
  }

  const now = serverNow();
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").sort(sortByTime);
  const upcoming = store.matches.filter((m) => effectiveStatus(m, now) === "scheduled" && m.scheduled_at).sort(sortByTime);

  return `<div class="stack gap-12">
    <header class="welcome">
      <span class="ghost" aria-hidden="true">${store.tournament.year}</span>
      <p class="eyebrow" data-reveal="load">Welcome back, ${esc(profile.full_name.split(" ")[0])}</p>
      <h1 class="display" data-split="load">${esc(store.tournament.name)}</h1>
    </header>
    ${store.tournament.status === "complete" ? champion() : ""}
    ${profile.role === "player" ? playerSection(profile) : ""}
    ${isStaff(profile.role) ? checklist() : ""}

    <section>
      <div class="row gap-3 mb-4"><h2 class="section-title">Live now</h2>${live.length ? `<span class="num small dim">${live.length}</span>` : ""}</div>
      ${live.length ? `<div class="grid sm-2 lg-4" data-stagger>${live.map(liveCard).join("")}</div>` : `<p class="muted">No games are being played right now.</p>`}
    </section>

    <section>
      <div class="row between mb-3">
        <h2 class="section-title">Coming up</h2>
        <a href="fixtures.html" class="small muted row gap-1">All fixtures ${icon("arrow-right")}</a>
      </div>
      ${upcoming.length ? `<div class="panel pad-sm">${upcoming.slice(0, 6).map((m) => matchRowHtml(m, profile.id)).join("")}</div>` : `<p class="muted">Nothing scheduled yet.</p>`}
    </section>
  </div>`;
}

function champion() {
  const final = store.matches.find((m) => m.stage === "final");
  const p = final?.winner_id ? store.profileById.get(final.winner_id) : null;
  if (!p) return "";
  return `<div class="panel pad">
    <i class="ph-fill ph-crown" style="font-size:28px;color:var(--chrome)"></i>
    <p class="muted mt-4">Champion</p>
    <p class="display chrome-text mt-1" style="font-size:var(--text-2xl);padding-bottom:0.25rem">${esc(p.full_name)}</p>
  </div>`;
}

// ---------------------------------------------------------------- player view

function playerSection(profile) {
  const now = serverNow();
  const mine = store.matches.filter((m) => involves(m, profile.id)).sort(sortByTime);
  const liveGame = mine.find((m) => effectiveStatus(m, now) === "live");
  const next = liveGame ?? mine.find((m) => effectiveStatus(m, now) === "scheduled" && m.scheduled_at);
  const myGroup = store.groups.find((g) => store.groupPlayers.some((gp) => gp.group_id === g.id && gp.player_id === profile.id));
  const played = mine.filter((m) => m.status === "completed");

  return `<div class="grid lg-hero">
    ${nextGameHero(next, Boolean(liveGame), profile)}
    <div class="stack gap-6">
      ${myGroup ? groupTableHtml(myGroup, { me: profile.id, compact: true }) : ""}
      ${played.length ? `<section class="panel pad-sm"><h3 class="small strong muted" style="padding:0.75rem 1rem 0.25rem">Your results</h3>${played.map((m) => matchRowHtml(m, profile.id)).join("")}</section>` : ""}
    </div>
  </div>`;
}

function nextGameHero(m, live, profile) {
  const art = `<img class="art" src="assets/brand/pawn.webp" alt="" aria-hidden="true">`;
  if (!m) {
    return `<div class="panel hero" style="justify-content:flex-end">${art}
      <i class="ph ph-hourglass dim" style="font-size:28px"></i>
      <h2 class="mt-4" style="font-size:var(--text-lg);font-weight:600">No game scheduled for you yet</h2>
      <p class="muted mt-2" style="max-width:44ch">When the organisers set your next game, the countdown will start here.</p>
    </div>`;
  }
  const white = m.white_id === profile.id;
  return `<div class="panel lit hero" data-reveal="load" data-delay="0.2">${art}
    <div class="row gap-3">${live ? liveTag() : `<span class="small muted">Your next game</span>`}<span class="small dim">${esc(matchContext(m))}</span></div>
    <div class="mt-6">
      <p class="small muted">You play ${white ? "white" : "black"} against</p>
      <p class="opponent">${playerHtml(white ? m.black_id : m.white_id)}</p>
    </div>
    <div class="hero-foot">
      ${live
        ? `<p class="muted" style="max-width:36ch">Your clock may already be running. Head to the board.</p>`
        : m.scheduled_at
          ? `<div>${countdownHtml(m.scheduled_at, { big: true })}<p class="small dim mt-3">${formatDateTime(m.scheduled_at)}</p></div>`
          : ""}
      <a class="btn btn-lg ${live ? "btn-primary" : ""}" href="match.html?id=${m.id}">${live ? "Play now" : "Open board"} <i class="ph-bold ph-arrow-right"></i></a>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- staff view

function checklist() {
  const players = store.profiles.filter((p) => p.role === "player").length;
  const groupGames = store.matches.filter((m) => m.stage === "group");
  const scheduled = groupGames.filter((m) => m.scheduled_at).length;
  const finished = groupGames.filter((m) => m.status === "completed").length;
  const knockout = store.matches.filter((m) => m.stage !== "group");
  const steps = [
    { label: "Player accounts", detail: `${players} of 32`, done: players >= 32, href: "admin.html#people" },
    { label: "Groups drawn", detail: `${store.groupPlayers.length} of 32 placed`, done: store.groupPlayers.length === 32, href: "admin.html#groups" },
    { label: "Group fixtures", detail: groupGames.length ? `${groupGames.length} games, ${scheduled} scheduled` : "Not generated", done: groupGames.length === 48 && scheduled === 48, href: "admin.html#matches" },
    { label: "Group stage played", detail: `${finished} of ${groupGames.length || 48} finished`, done: groupGames.length > 0 && finished === groupGames.length, href: "fixtures.html" },
    { label: "Knockout bracket", detail: knockout.length ? "Generated" : "Not generated", done: knockout.length > 0, href: "admin.html#knockout" },
    { label: "Champion crowned", detail: store.tournament.status === "complete" ? "Done" : "Pending", done: store.tournament.status === "complete", href: "bracket.html" },
  ];
  const next = steps.find((s) => !s.done);
  return `<section class="panel lit pad" data-reveal="load" data-delay="0.2">
    <div class="split">
      <h2 class="section-title">Tournament setup</h2>
      ${next ? `<a class="btn btn-primary btn-sm" href="${next.href}">Next: ${next.label.toLowerCase()} <i class="ph-bold ph-arrow-right"></i></a>` : ""}
    </div>
    <ol class="checklist">${steps
      .map(
        (s) => `<li><a href="${s.href}">
          <i class="check-icon ${s.done ? "ph-fill ph-check-circle done" : "ph ph-circle"}"></i>
          <span><span class="step-label${s.done ? " done" : ""}">${s.label}</span><span class="step-detail">${s.detail}</span></span>
        </a></li>`,
      )
      .join("")}</ol>
  </section>`;
}

// ---------------------------------------------------------------- live boards

function liveCard(m) {
  const stage = m.stage === "group" ? `Group ${store.groups.find((g) => g.id === m.group_id)?.label ?? ""}` : STAGE_LABEL[m.stage];
  return `<a class="panel live-card" href="match.html?id=${m.id}">
    <div class="meta"><span>${stage}</span><span class="num">Move ${Math.ceil(m.move_count / 2) || 1}</span></div>
    <div class="who mb-3">${playerHtml(m.black_id)}</div>
    <div class="mini-board" data-mini-fen="${esc(m.fen)}"></div>
    <div class="who mt-3">${playerHtml(m.white_id)}</div>
  </a>`;
}
