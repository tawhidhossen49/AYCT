import { isStaff } from "../auth.js";
import { store, effectiveStatus, involves, sortByTime, matchContext, STAGE_LABEL } from "../store.js";
import { countdownHtml, formatDateTime, serverNow } from "../time.js";
import { esc, groupTableHtml, icon, liveTag, matchRowHtml, playerHtml, sectionHead } from "../ui.js";
import { mountMiniBoards } from "../board.js";
import { startPage } from "../page.js";

const STATUS_LINE = {
  setup: "The organisers are setting up this year's edition.",
  groups: "Group stage in progress. The top two in each group go through.",
  knockout: "Knockout stage. One game, one winner, every round.",
  complete: "The tournament is complete. A champion has been crowned.",
};

const { app, draw, redrawHero } = await startPage("home", { render, hero, ticker });
mountMiniBoards(app);

// Keep "live" and "in 2h" labels fresh (games go live at their start time
// without any database change), and redraw boards after updates.
setInterval(() => {
  redrawHero();
  draw();
}, 15_000);
new MutationObserver(() => mountMiniBoards(app)).observe(app, { childList: true });


// "Amaze Youth Chess Tournament 2026" -> bold "Amaze Youth Chess", light "Tournament 2026".
function splitName(name) {
  const i = name.toLowerCase().lastIndexOf("tournament");
  return i > 0 ? [name.slice(0, i).trim(), name.slice(i)] : [name, ""];
}

// ---------------------------------------------------------------- header band

function hero(profile) {
  const first = esc(profile.full_name.split(" ")[0]);
  const t = store.tournament;
  if (!t) {
    return {
      scene: "king",
      eyebrow: `Welcome back, ${first}`,
      bold: "The board",
      soft: "is set.",
      lede: isStaff(profile.role)
        ? "Create this year's edition to start adding players, drawing groups and scheduling games."
        : "The organisers are preparing this year's tournament. Your group and fixtures will appear here soon.",
      actions: isStaff(profile.role)
        ? `<a class="btn btn-primary btn-lg" href="admin.html#tournament" data-magnetic>Set up the tournament ${icon("arrow-right", "bold")}</a>`
        : "",
    };
  }

  const now = serverNow();
  const [bold, soft] = splitName(t.name);
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").length;
  const played = store.matches.filter((m) => m.status === "completed").length;
  const entrants = store.groupPlayers.length || store.profiles.filter((p) => p.role === "player").length;
  let lede = STATUS_LINE[t.status];
  let actions = "";

  if (profile.role === "player") {
    const next = store.matches
      .filter((m) => involves(m, profile.id) && effectiveStatus(m, now) !== "completed" && m.scheduled_at)
      .sort(sortByTime)[0];
    if (next) {
      const opp = store.profileById.get(next.white_id === profile.id ? next.black_id : next.white_id);
      lede = `Your next game: ${opp ? `against ${esc(opp.full_name)}` : "opponent to be decided"}, ${formatDateTime(next.scheduled_at)}.`;
      actions = `<a class="btn btn-primary btn-lg" href="match.html?id=${next.id}" data-magnetic>Open your board ${icon("arrow-right", "bold")}</a>`;
    }
  }

  return {
    scene: "king",
    shift: "26%",
    eyebrow: `Welcome back, ${first}`,
    bold,
    soft,
    lede,
    actions,
    stats: [
      { value: entrants, label: "Players" },
      { value: live, label: "Live now", live: live > 0 },
      { value: played, label: `of ${store.matches.length || 63} games played` },
    ],
  };
}

function ticker() {
  const t = store.tournament;
  return [t?.name ?? "Amaze Youth Chess Tournament", "32 Players", "8 Groups", "63 Games", "One Champion", "Think. Play. Become legendary."];
}

// ---------------------------------------------------------------- content

function render(profile) {
  if (!store.tournament) return isStaff(profile.role) ? firstSteps() : "";

  const now = serverNow();
  const live = store.matches.filter((m) => effectiveStatus(m, now) === "live").sort(sortByTime);
  const upcoming = store.matches.filter((m) => effectiveStatus(m, now) === "scheduled" && m.scheduled_at).sort(sortByTime);

  return `<div>
    ${store.tournament.status === "complete" ? `<section class="s-block">${champion()}</section>` : ""}
    ${profile.role === "player" ? `<section class="s-block">${sectionHead("Your tournament", "Next", "up.")}${playerSection(profile)}</section>` : ""}
    ${isStaff(profile.role) ? `<section class="s-block">${sectionHead("Organiser", "Tournament", "setup.", "Work through these in order. Each step opens the right admin tab.")}${checklist()}</section>` : ""}

    <section class="s-block">
      ${sectionHead("On the boards", "Live", "now.", live.length ? `${live.length} game${live.length === 1 ? "" : "s"} in progress. Open one to watch.` : "")}
      ${live.length ? `<div class="grid sm-2 lg-4" data-stagger>${live.map(liveCard).join("")}</div>` : `<div class="panel pad muted">No games are being played right now.</div>`}
    </section>

    <section class="s-block">
      ${sectionHead("Schedule", "Coming", "up.", `<a href="fixtures.html" class="btn btn-sm">All fixtures ${icon("arrow-right")}</a>`)}
      ${upcoming.length ? `<div class="panel pad-sm">${upcoming.slice(0, 6).map((m) => matchRowHtml(m, profile.id)).join("")}</div>` : `<div class="panel pad muted">Nothing scheduled yet.</div>`}
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
  const final = store.matches.find((m) => m.stage === "final");
  const p = final?.winner_id ? store.profileById.get(final.winner_id) : null;
  if (!p) return "";
  return `<div class="panel lit pad champion">
    <i class="ph-fill ph-crown" style="font-size:28px;color:var(--chrome)"></i>
    <p class="eyebrow mt-4">Champion</p>
    <p class="display chrome-text mt-2" style="font-size:clamp(2rem,5vw,4rem);padding-bottom:0.25rem">${esc(p.full_name)}</p>
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
      ${played.length ? `<section class="panel pad-sm"><h3 class="eyebrow" style="padding:0.85rem 1rem 0.35rem">Your results</h3>${played.map((m) => matchRowHtml(m, profile.id)).join("")}</section>` : ""}
    </div>
  </div>`;
}

function nextGameHero(m, live, profile) {
  const art = `<img class="art" src="assets/brand/scenes/rising.webp" alt="" aria-hidden="true">`;
  if (!m) {
    return `<div class="panel lit hero" style="justify-content:flex-end">${art}
      <i class="ph ph-hourglass dim" style="font-size:28px"></i>
      <h3 class="hero-empty-title mt-4">No game scheduled yet</h3>
      <p class="muted mt-2" style="max-width:44ch">When the organisers set your next game, the countdown will start here.</p>
    </div>`;
  }
  const white = m.white_id === profile.id;
  return `<div class="panel lit hero" data-reveal="load" data-delay="0.2">${art}
    <div class="row gap-3">${live ? liveTag() : `<span class="eyebrow">Your next game</span>`}<span class="small dim">${esc(matchContext(m))}</span></div>
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
