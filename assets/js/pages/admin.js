// Admin panel: editions, accounts, the group draw, fixtures and results,
// and the knockout bracket. Moderators get everything except accounts.

import { ROLE_LABEL } from "../auth.js";
import { callFunction } from "../supabase.js";
import { store, loadAll, subscribe, sortByTime, STAGE_LABEL } from "../store.js";
import { formatDateTime, fromLocalInput, toLocalInput } from "../time.js";
import { TIEBREAK_NOTE } from "../standings.js";
import {
  clearGroups, createTournament, generateGroupFixtures, generateKnockout, qualifiers, R16_PAIRINGS,
  resetGame, scheduleRound, seededDraw, setActiveTournament, setGroupSlot, updateMatch, updateTournament,
} from "../ops.js";
import { emptyState, esc, icon, modalOpen, notice, openModal, pageHeader, playerHtml, statusHtml, withBusy } from "../ui.js";
import { startPage } from "../page.js";
import { animateIn } from "../motion.js";

const TABS = [
  { id: "tournament", label: "Tournament" },
  { id: "people", label: "People" },
  { id: "groups", label: "Groups" },
  { id: "matches", label: "Matches" },
  { id: "knockout", label: "Knockout" },
];
const ROLES = ["player", "moderator", "commentator", "admin"];
const STATUS_LABEL = { setup: "Setting up", groups: "Group stage", knockout: "Knockout stage", complete: "Complete" };
const ROUNDS = [
  { key: "g1", label: "Group round 1", test: (m) => m.stage === "group" && m.round === 1 },
  { key: "g2", label: "Group round 2", test: (m) => m.stage === "group" && m.round === 2 },
  { key: "g3", label: "Group round 3", test: (m) => m.stage === "group" && m.round === 3 },
  { key: "r16", label: STAGE_LABEL.r16, test: (m) => m.stage === "r16" },
  { key: "qf", label: "Quarterfinals", test: (m) => m.stage === "qf" },
  { key: "sf", label: "Semifinals", test: (m) => m.stage === "sf" },
  { key: "final", label: STAGE_LABEL.final, test: (m) => m.stage === "final" },
];

// View state that survives redraws.
const ui = { roleFilter: "all", query: "", round: "g1" };

const { profile, app } = await startPage("admin", { staff: true });
const isAdmin = profile.role === "admin";

function currentTab() {
  const id = location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? id : store.tournament ? "matches" : "tournament";
}

function draw() {
  const tab = currentTab();
  const subtitle = isAdmin
    ? "Run the whole tournament from here: accounts, the draw, fixtures, results and the bracket."
    : "As a moderator you can run the draw, fixtures, results and the bracket. Accounts are managed by admins.";
  const tabs = `<nav class="tabs" aria-label="Admin sections">${TABS.map((t) => `<a class="tab${t.id === tab ? " active" : ""}" href="#${t.id}">${t.label}</a>`).join("")}</nav>`;
  const body = { tournament: tournamentTab, people: peopleTab, groups: groupsTab, matches: matchesTab, knockout: knockoutTab }[tab]();
  app.innerHTML = pageHeader("Admin", subtitle) + tabs + (store.error ? notice(esc(store.error), "error") : "") + body;
}

async function refresh() {
  await loadAll();
  draw();
}

draw();
animateIn(app);
window.addEventListener("hashchange", draw);
// Live updates, unless someone is in the middle of typing or a dialog.
subscribe(() => {
  const typing = app.contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (!modalOpen() && !typing) draw();
});

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
  return `<div class="stack gap-8">${form}${list}</div>`;
}

function newEditionModal() {
  const year = new Date().getFullYear();
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
    (p) => (ui.roleFilter === "all" || p.role === ui.roleFilter) && (!q || `${p.full_name} ${p.email} ${p.school ?? ""}`.toLowerCase().includes(q)),
  );
  const chips = ["all", ...ROLES]
    .map((r) => `<button class="chip${ui.roleFilter === r ? " active" : ""}" data-action="role-filter" data-role="${r}">${r === "all" ? "Everyone" : `${ROLE_LABEL[r]}s`}<span class="count">${counts[r] ?? 0}</span></button>`)
    .join("");

  const table = visible.length
    ? `<div class="panel table-wrap"><table class="table" style="min-width:720px">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="r">Rating</th><th style="width:7rem"></th></tr></thead>
        <tbody>${visible
          .map(
            (p) => `<tr>
              <td><span style="font-weight:500">${esc(p.full_name)}</span>${p.school ? `<span class="xs dim" style="display:block">${esc(p.school)}</span>` : ""}</td>
              <td class="muted">${esc(p.email)}</td>
              <td>${ROLE_LABEL[p.role]}</td>
              <td class="r num">${p.role === "player" ? p.rating : "-"}</td>
              <td class="r">${isAdmin
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
    <div class="grid sm-2 xl-4 tight">${groups}</div>
  </div>`;
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
          <span class="xs dim" style="display:block;margin-bottom:0.25rem">${m.stage === "group" ? `Group ${g?.label ?? ""}` : `${STAGE_LABEL[m.stage]} ${m.bracket_slot}`}${m.scheduled_at ? `, ${formatDateTime(m.scheduled_at)}` : ""}</span>
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
      <button class="btn ${groupGames.length ? "" : "btn-primary"}" data-action="generate-fixtures" ${store.groupPlayers.length !== 32 ? "disabled" : ""}>${groupGames.length ? "Generate again" : "Generate fixtures"}</button>
    </section>
    ${store.groupPlayers.length !== 32 && !groupGames.length ? notice("Place all 32 players in groups first.") : ""}
    <div data-err></div>

    <section>
      <div class="chips">${chips}</div>
      ${roundMatches.length
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
  const players = store.profiles.filter((p) => p.role === "player").sort((a, b) => a.full_name.localeCompare(b.full_name));
  const knockout = m.stage !== "group";
  const started = m.status !== "scheduled" || m.move_count > 0;
  const options = (selected) => `<option value="">To be decided</option>${players.map((p) => `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.full_name)}</option>`).join("")}`;
  const nameOf = (id) => esc(store.profileById.get(id)?.full_name ?? "");

  const d = openModal(
    m.stage === "group" ? `Group game, round ${m.round}` : `${STAGE_LABEL[m.stage]} ${m.bracket_slot}`,
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
      ${knockout
        ? `<div class="field" data-tiebreak>
            <label for="mm-winner">Tiebreak winner</label>
            <select class="input" id="mm-winner" name="winner"><option value="">Choose a player</option>${[m.white_id, m.black_id].filter(Boolean).map((id) => `<option value="${id}" ${id === m.winner_id ? "selected" : ""}>${nameOf(id)}</option>`).join("")}</select>
            <p class="hint">Knockout games need someone to go through. Pick who won the tiebreak.</p>
          </div>`
        : ""}
      <div data-err></div>
      <div class="row between wrap gap-2" style="border-top:1px solid var(--line);padding-top:1.25rem">
        <button type="button" class="btn btn-danger btn-sm" data-reset ${!started && !m.result ? "disabled" : ""}>Reset game</button>
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

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const white = form.white.value;
    const black = form.black.value;
    const result = form.result.value;
    if (white && white === black) {
      err.innerHTML = notice("A player can't play themselves.", "error");
      return;
    }
    if (knockout && result === "1/2-1/2" && !form.winner.value) {
      err.innerHTML = notice("A drawn knockout game needs a tiebreak winner.", "error");
      return;
    }
    const patch = started ? {} : { scheduled_at: fromLocalInput(form.when.value), white_id: white || null, black_id: black || null };
    if (result !== (m.result ?? "")) {
      patch.result = result || null;
      patch.status = result ? "completed" : m.move_count ? "live" : "scheduled";
      patch.end_reason = result ? "result recorded by staff" : null;
    }
    if (knockout && result === "1/2-1/2") patch.winner_id = form.winner.value;
    await withBusy(form.querySelector("[type=submit]"), async () => {
      if (Object.keys(patch).length) await updateMatch(m.id, patch);
      d.close();
      await refresh();
    }, err);
  });
}

// ---------------------------------------------------------------- knockout tab

function knockoutTab() {
  if (!store.tournament) return emptyState("No edition yet", "Create the tournament first.");
  const groupGames = store.matches.filter((m) => m.stage === "group");
  const finished = groupGames.filter((m) => m.status === "completed").length;
  const existing = store.matches.filter((m) => m.stage !== "group");
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
          ? "The bracket is set. Winners move into the next round on their own as games finish."
          : `Group stage: ${finished} of ${groupGames.length || 48} games finished. The top two in each group go through. ${TIEBREAK_NOTE}`}</p>
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
  const err = app.querySelector("[data-err]");
  const t = store.tournament;
  switch (el.dataset.action) {
    case "new-edition":
      return newEditionModal();
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
      const replace = store.matches.some((m) => m.stage !== "group") ? "This replaces the current bracket. " : "";
      if ((warn || replace) && !confirm(`${warn}${replace}Generate the bracket now?`)) return;
      return withBusy(el, async () => {
        await generateKnockout(t.id, store.groups, store.groupPlayers, store.matches, store.profileById);
        await refresh();
      }, err);
    }
  }
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
