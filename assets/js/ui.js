// Shared building blocks. Pages build HTML strings with these and drop
// them into <main id="app">. Every piece of user text goes through esc().

import { ROLE_LABEL, isStaff, signOut } from "./auth.js";
import { store, effectiveStatus, matchContext } from "./store.js";
import { formatDate, formatTime, relative, serverNow } from "./time.js";
import { formatPoints, groupStandings } from "./standings.js";
import { mountBell, startFeed } from "./notify.js";

export function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const icon = (name, weight = "") => `<i class="ph${weight ? "-" + weight : ""} ph-${name}" aria-hidden="true"></i>`;

// ---------------------------------------------------------------- shell

const LINKS = [
  { href: "home.html", label: "Dashboard", short: "Home", icon: "house", key: "home" },
  { href: "play.html", label: "Arena", icon: "crown-simple", key: "arena" },
  { href: "fixtures.html", label: "Fixtures", icon: "list-bullets", key: "fixtures" },
  { href: "groups.html", label: "Groups", icon: "squares-four", key: "groups" },
  { href: "bracket.html", label: "Bracket", icon: "tree-structure", key: "bracket" },
  { href: "leaderboard.html", label: "Leaderboard", short: "Ranks", icon: "chart-bar", key: "leaderboard" },
];

// Top bar (desktop) and bottom tab bar (phones), with the current page lit.
// Staff get a switch between the two sides of the portal: what players
// see, and the Control Room where the tournament is run.
export function mountShell(profile, active) {
  const staff = isStaff(profile.role);
  const year = store.tournament?.year ?? "";
  const inControl = active === "admin";

  const header = document.createElement("header");
  header.className = "topbar";
  header.innerHTML = `
    <div class="topbar-inner">
      <a href="${inControl ? "admin.html" : "home.html"}" class="brand" aria-label="Home">
        <img src="assets/brand/logo.png" alt="" width="32" height="32">
        <span class="brand-text"><span class="display">Amaze Youth Chess</span><span class="display-light" data-year>${inControl ? "Control room" : `Tournament ${esc(year)}`}</span></span>
      </a>
      <nav class="nav" aria-label="Main">
        ${inControl ? "" : LINKS.map((l) => `<a href="${l.href}" class="${l.key === active ? "active" : ""}">${l.label}</a>`).join("")}
      </nav>
      ${staff
        ? `<div class="portal-switch" role="group" aria-label="Portal">
            <a href="home.html" class="${inControl ? "" : "on"}">${icon("users-three", "bold")}<span>Portal</span></a>
            <a href="admin.html" class="${inControl ? "on" : ""}">${icon("sliders-horizontal", "bold")}<span>Control room</span></a>
          </div>`
        : ""}
      <div class="account">
        <div class="account-text">
          <p class="name truncate">${esc(profile.full_name)}</p>
          <p class="role">${ROLE_LABEL[profile.role]}</p>
        </div>
        <a class="btn btn-sm btn-ghost" href="index.html" data-main-site aria-label="Main site" title="Back to the main site">${icon("globe-hemisphere-west")}<span class="signout-label">Main site</span></a>
        <span data-bell></span>
        <button class="btn btn-sm" data-signout aria-label="Sign out">${icon("sign-out")}<span class="signout-label">Sign out</span></button>
      </div>
    </div>`;

  // Every page is one tap away on phones too, as in the PC menu.
  const tabLinks = staff ? [...LINKS, { href: "admin.html", label: "Control", icon: "sliders-horizontal", key: "admin" }] : LINKS;
  const tabbar = document.createElement("nav");
  tabbar.className = `tabbar${tabLinks.length > 6 ? " many" : ""}`;
  tabbar.setAttribute("aria-label", "Main");
  tabbar.innerHTML = tabLinks
    .map((l) => `<a href="${l.href}" class="${l.key === active ? "active" : ""}" aria-label="${l.label}">${icon(l.icon, l.key === active ? "fill" : "")}${l.short ?? l.label}</a>`)
    .join("");

  document.body.prepend(header);
  document.body.append(tabbar);
  document.body.classList.add("has-tabbar");
  header.querySelector("[data-signout]").addEventListener("click", signOut);
  const bellSlot = header.querySelector("[data-bell]");
  mountBell(bellSlot);
  startFeed(profile.id);
}

// The year shows once the tournament has loaded.
export function refreshShellYear() {
  const el = document.querySelector("[data-year]");
  if (el) el.textContent = `Tournament ${store.tournament?.year ?? ""}`;
}

// Page title over a giant outline copy of itself.
export function pageHeader(title, subtitle = "", actions = "") {
  return `<header class="page-header">
    <span class="ghost" aria-hidden="true">${esc(title)}</span>
    <div><h1 class="display" data-split="load">${esc(title)}</h1>${subtitle ? `<p data-reveal="load" data-delay="0.15">${subtitle}</p>` : ""}</div>
    ${actions ? `<div class="row wrap gap-2">${actions}</div>` : ""}
  </header>`;
}

// ---------------------------------------------------------------- cinematic pieces (shared with the landing page)

// Full-width page band: a still from the hero film, a label, a two-tone
// headline, one line of context and live counters.
//   scene: pieces | path | distant | rising | king
//   stats: [{ value, label, live? }]
export function heroHtml({ scene = "king", eyebrow = "", bold, soft = "", lede = "", stats = [], actions = "", compact = false, shift }, { animate = false } = {}) {
  const stat = (s) =>
    `<div class="p-stat${s.live ? " live" : ""}"><span class="v"${animate && typeof s.value === "number" ? ` data-count="${s.value}"` : ""}>${esc(s.value)}</span><span class="k">${esc(s.label)}</span></div>`;
  const long = String(bold).length > 14 ? " long" : "";
  return `<section class="p-hero${compact ? " compact" : ""}${long}">
    <div class="p-hero__media" aria-hidden="true"><img src="assets/brand/scenes/${scene}.webp" alt="" width="1920" height="1080"${shift ? ` style="--shift:${shift}"` : ""}></div>
    <div class="p-hero__shade" aria-hidden="true"></div>
    <div class="p-hero__inner">
      ${eyebrow ? `<p class="eyebrow"${animate ? ' data-reveal="load"' : ""}>${eyebrow}</p>` : ""}
      <h1 class="p-hero__title">
        <span class="display"${animate ? ' data-split="load"' : ""}>${esc(bold)}</span>
        ${soft ? `<span class="display-light chrome-text"${animate ? ' data-reveal="load" data-delay="0.2"' : ""}>${esc(soft)}</span>` : ""}
      </h1>
      ${lede ? `<p class="p-hero__lede"${animate ? ' data-reveal="load" data-delay="0.3"' : ""}>${lede}</p>` : ""}
      ${stats.length ? `<div class="p-hero__stats"${animate ? ' data-stagger="load"' : ""}>${stats.map(stat).join("")}</div>` : ""}
      ${actions ? `<div class="p-hero__actions">${actions}</div>` : ""}
    </div>
  </section>`;
}

// Section head in the landing page's style: label, bold words, light words.
export function sectionHead(eyebrow, bold, soft = "", aside = "") {
  return `<div class="s-head">
    <div>${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ""}<h2>${esc(bold)}${soft ? ` <span class="soft">${esc(soft)}</span>` : ""}</h2></div>
    ${aside ? `<div class="aside">${aside}</div>` : ""}
  </div>`;
}

// The landing page's scrolling band.
export function tickerHtml(items) {
  const row = items.map((t, i) => `<span class="ticker__item${i % 2 ? " soft" : ""}">${esc(t)} <img src="assets/brand/logo.png" alt=""></span>`).join("");
  return `<div class="ticker" aria-hidden="true"><div class="ticker__track">${row}${row}</div></div>`;
}

// The landing page's footer, with the giant wordmark.
export function mountFooter() {
  const f = document.createElement("footer");
  f.className = "footer portal";
  f.innerHTML = `
    <div class="footer__cols">
      <div>
        <img src="assets/brand/logo.png" alt="" width="44" height="44">
        <p class="mt-4 muted" style="max-width:32ch">The annual Amaze Youth Chess Tournament. Think. Play. Become legendary.</p>
      </div>
      <div>
        <h4>Portal</h4>
        <ul><li><a href="home.html">Dashboard</a></li><li><a href="play.html">Arena</a></li><li><a href="fixtures.html">Fixtures</a></li><li><a href="groups.html">Groups</a></li><li><a href="bracket.html">Bracket</a></li><li><a href="leaderboard.html">Leaderboard</a></li></ul>
      </div>
      <div>
        <h4>Tournament</h4>
        <ul><li><a href="index.html">About the tournament</a></li><li><a href="index.html#format">Format</a></li><li><a href="index.html#faq">FAQ</a></li></ul>
      </div>
    </div>
    <div class="footer__base"><span>© ${esc(store.tournament?.year ?? new Date().getFullYear())} Amaze Youth Chess Tournament</span><span>Think. Play. Become legendary.</span></div>
    <p class="footer__word" aria-hidden="true">${[..."Amaze"].map((c) => `<span>${c}</span>`).join("")}</p>`;
  const tabbar = document.querySelector(".tabbar");
  if (tabbar) tabbar.before(f);
  else document.body.append(f);
  return f;
}

// ---------------------------------------------------------------- small pieces

export function playerHtml(id, { me = null, align = "" } = {}) {
  const p = id ? store.profileById.get(id) : null;
  if (!p) return `<span class="dim">To be decided</span>`;
  return `<span class="player${id === me ? " me" : ""}${align}"><span class="pname">${esc(p.full_name)}</span>${p.is_bot ? botTag() : ""}<span class="rating">${p.rating}</span></span>`;
}

// Marks a test bot wherever a name appears.
export function botTag() {
  return `<span class="bot-tag" title="Test bot">Bot</span>`;
}

export const liveTag = () => `<span class="live-tag"><span class="live-dot" aria-hidden="true"></span>Live</span>`;

export function resultText(m) {
  if (!m.result) return "";
  return m.result === "1/2-1/2" ? "½ - ½" : m.result.replace("-", " - ");
}

export function statusHtml(m) {
  const status = effectiveStatus(m, serverNow());
  if (status === "live") return liveTag();
  if (status === "completed") return `<span class="num small strong">${resultText(m)}</span>`;
  if (!m.scheduled_at) return `<span class="small dim">Not scheduled</span>`;
  return `<span class="status"><span class="small">${formatTime(m.scheduled_at)}</span><span class="xs dim">${relative(m.scheduled_at) ?? formatDate(m.scheduled_at)}</span></span>`;
}

export function matchRowHtml(m, me = null) {
  const ctx = esc(matchContext(m));
  const side = (id, colour) =>
    `<span class="side${m.winner_id && m.winner_id !== id ? " lost" : ""}"><span class="colour-dot ${colour}" aria-label="${colour}"></span>${playerHtml(id, { me })}</span>`;
  return `<a href="play.html?id=${m.id}" class="match-row">
    <span class="context">${ctx}${m.scheduled_at ? `<span class="mt-1" style="display:block">${formatDate(m.scheduled_at)}</span>` : ""}</span>
    <span class="sides">${side(m.white_id, "white")}${side(m.black_id, "black")}<span class="context-mobile">${ctx}</span></span>
    ${statusHtml(m)}
  </a>`;
}

export function emptyState(title, body, action = "") {
  return `<div class="panel empty"><h3>${esc(title)}</h3><p>${esc(body)}</p>${action ? `<div class="actions">${action}</div>` : ""}</div>`;
}

export const notice = (text, tone = "") => `<div class="notice ${tone}" role="${tone === "error" ? "alert" : "status"}">${text}</div>`;

export const skeleton = (height) => `<div class="skeleton" style="height:${height}"></div>`;

// ---------------------------------------------------------------- group table

export function groupTableHtml(group, { me = null, compact = false } = {}) {
  const rows = groupStandings(group.id, store.groupPlayers, store.matches, store.profileById);
  const games = store.matches.filter((m) => m.group_id === group.id);
  const played = games.filter((m) => m.status === "completed").length;
  if (!rows.length) {
    return `<section class="panel group-card"><span class="ghost ghost-letter" aria-hidden="true">${group.label}</span><div class="group-head"><h3 class="display">Group ${group.label}</h3></div><p class="small dim" style="padding:0 1.25rem 1.25rem">No players drawn into this group yet.</p></section>`;
  }
  const head = compact
    ? `<th class="c" title="Played">P</th>`
    : `<th class="c" title="Wins">W</th><th class="c" title="Draws">D</th><th class="c" title="Losses">L</th><th class="c" title="Sonneborn-Berger">SB</th>`;
  const body = rows
    .map((r, i) => {
      const p = store.profileById.get(r.playerId);
      const cells = compact
        ? `<td class="c num muted">${r.played}</td>`
        : `<td class="c num muted">${r.wins}</td><td class="c num muted">${r.draws}</td><td class="c num muted">${r.losses}</td><td class="c num dim">${formatPoints(r.sb)}</td>`;
      return `<tr class="${r.playerId === me ? "me" : ""}">
        <td style="width:3.5rem"><span class="rank${i < 2 ? " through" : ""}">${i + 1}</span></td>
        <td style="max-width:0"><span class="truncate" style="display:block;${r.playerId === me ? "font-weight:600" : ""}">${esc(p?.full_name ?? "Unknown player")}</span><span class="num xs dim">${p?.rating ?? ""}</span></td>
        ${cells}
        <td class="r num strong">${formatPoints(r.points)}</td>
      </tr>`;
    })
    .join("");
  return `<section class="panel group-card">
    <span class="ghost ghost-letter" aria-hidden="true">${group.label}</span>
    <div class="group-head"><h3 class="display">Group ${group.label}</h3>${games.length ? `<span class="num xs dim">${played}/${games.length} played</span>` : ""}</div>
    <table class="table group-table"><thead><tr><th>#</th><th>Player</th>${head}<th class="r">Pts</th></tr></thead><tbody>${body}</tbody></table>
  </section>`;
}

// ---------------------------------------------------------------- modal

// Opens a dialog and returns it; the body can hold forms with data-close buttons.
export function openModal(title, bodyHtml, { wide = false } = {}) {
  const d = document.createElement("dialog");
  d.className = `modal${wide ? " wide" : ""}`;
  d.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon("x")}</button></div><div class="modal-body">${bodyHtml}</div>`;
  document.body.append(d);
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close]")) d.close();
  });
  d.addEventListener("close", () => d.remove());
  d.showModal();
  return d;
}

export const modalOpen = () => Boolean(document.querySelector("dialog.modal[open]"));

// Runs an async action with a spinner on the button, and shows any error
// in the given element (or an alert).
export async function withBusy(button, action, errorEl) {
  if (errorEl) errorEl.innerHTML = "";
  button?.classList.add("loading");
  if (button) button.disabled = true;
  try {
    return await action();
  } catch (err) {
    if (errorEl) errorEl.innerHTML = notice(esc(err.message), "error");
    else alert(err.message);
    return undefined;
  } finally {
    button?.classList.remove("loading");
    if (button) button.disabled = false;
  }
}
