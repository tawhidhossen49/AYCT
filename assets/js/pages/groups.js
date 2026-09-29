import { store, tournamentUnrated } from "../store.js";
import { TIEBREAK_NOTE } from "../standings.js";
import { emptyState, groupTableHtml } from "../ui.js";
import { startPage } from "../page.js";

await startPage("groups", { render, hero });

function hero() {
  const games = store.matches.filter((m) => m.stage === "group");
  return {
    scene: "pieces",
    eyebrow: "Group stage",
    bold: "Eight groups.",
    soft: "Top two go through.",
    lede: `Eight groups of four, everyone plays everyone once. ${TIEBREAK_NOTE}${tournamentUnrated() ? " This is an unrated tournament: results count for the tables, the bracket and the title, but ratings don't change." : ""}`,
    stats: [
      { value: store.groups.length || 8, label: "Groups" },
      { value: store.groupPlayers.length, label: "Players drawn" },
      { value: games.filter((m) => m.status === "completed").length, label: `of ${games.length || 48} played` },
    ],
  };
}

function render(profile) {
  const header = "";
  if (!store.groupPlayers.length) return header + emptyState("The draw hasn't happened yet", "Once the organisers draw the groups, all eight tables will appear here.");
  return `${header}<div class="grid md-2">${store.groups.map((g) => groupTableHtml(g, { me: profile.id })).join("")}</div>`;
}
