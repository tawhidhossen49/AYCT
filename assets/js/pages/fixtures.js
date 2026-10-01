import { store, involves, sortByTime, effectiveStatus, STAGE_LABEL } from "../store.js";
import { formatDate, serverNow } from "../time.js";
import { emptyState, matchRowHtml } from "../ui.js";
import { startPage } from "../page.js";

const FILTERS = [
  { id: "all", label: "All", test: () => true },
  { id: "mine", label: "My games", test: () => true },
  { id: "g1", label: "Group round 1", test: (m) => m.stage === "group" && m.round === 1 },
  { id: "g2", label: "Group round 2", test: (m) => m.stage === "group" && m.round === 2 },
  { id: "g3", label: "Group round 3", test: (m) => m.stage === "group" && m.round === 3 },
  { id: "r16", label: STAGE_LABEL.r16, test: (m) => m.stage === "r16" },
  { id: "qf", label: "Quarterfinals", test: (m) => m.stage === "qf" },
  { id: "sf", label: "Semifinals", test: (m) => m.stage === "sf" },
  { id: "third", label: STAGE_LABEL.third, test: (m) => m.stage === "third" },
  { id: "final", label: STAGE_LABEL.final, test: (m) => m.stage === "final" },
  { id: "friendly", label: "Friendlies", test: (m) => m.stage === "friendly" },
];

let filter = null;

const { app, draw, redrawHero } = await startPage("fixtures", { render, hero });
// Games go live at their start time without a database change; keep the
// "live now" counts and labels current.
setInterval(() => {
  redrawHero();
  draw();
}, 30_000);

app.addEventListener("click", (e) => {
  const chip = e.target.closest("[data-filter]");
  if (!chip) return;
  filter = chip.dataset.filter;
  draw();
});

function hero() {
  const now = serverNow();
  const count = (st) => store.matches.filter((m) => effectiveStatus(m, now) === st).length;
  const live = count("live");
  return {
    scene: "path",
    eyebrow: "Every game",
    bold: "Fixtures",
    soft: "& results.",
    lede: `Every game in the tournament, in order. Open any game to watch the board live.`,
    stats: [
      { value: store.matches.length, label: "Games" },
      { value: live, label: "Live now", live: live > 0 },
      { value: count("completed"), label: "Finished" },
      { value: count("scheduled"), label: "To play" },
    ],
  };
}

function render(profile) {
  const isPlayer = profile.role === "player";
  filter ??= isPlayer ? "mine" : "all";
  const f = FILTERS.find((x) => x.id === filter);
  const visible = store.matches.filter((m) => (filter === "mine" ? involves(m, profile.id) : f.test(m))).sort(sortByTime);

  // Rows grouped under a heading per day.
  const days = [];
  for (const m of visible) {
    const key = m.scheduled_at ? new Date(m.scheduled_at).toDateString() : "unscheduled";
    let day = days.find((d) => d.key === key);
    if (!day) days.push((day = { key, label: m.scheduled_at ? formatDate(m.scheduled_at) : "Not scheduled yet", items: [] }));
    day.items.push(m);
  }

  const chips = FILTERS.filter((x) => x.id !== "mine" || isPlayer)
    .map((x) => `<button class="chip${x.id === filter ? " active" : ""}" data-filter="${x.id}" aria-pressed="${x.id === filter}">${x.label}</button>`)
    .join("");

  return `<div class="chips" role="toolbar" aria-label="Filter fixtures">${chips}</div>
    ${days.length
      ? `<div class="stack gap-8">${days
          .map((d) => `<section><h2 class="day-heading">${d.label}</h2><div class="panel pad-sm">${d.items.map((m) => matchRowHtml(m, profile.id)).join("")}</div></section>`)
          .join("")}</div>`
      : emptyState(filter === "mine" ? "You have no games yet" : "No games here yet", "Fixtures appear once the organisers generate them. Each one gets a start time and a countdown.")}`;
}
