import { store, formatOf, clockLabel, GROUP_GAMES } from "../store.js";
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
    lede: `Eight groups of four, seeded from the Selection Round. Everyone plays everyone twice, once with each colour, at ${clockLabel(formatOf("group"))}. ${TIEBREAK_NOTE}`,
    stats: [
      { value: store.groups.length || 8, label: "Groups" },
      { value: store.groupPlayers.length, label: "Players placed" },
      { value: games.filter((m) => m.status === "completed").length, label: `of ${games.length || GROUP_GAMES} played` },
    ],
  };
}

function render(profile) {
  const header = "";
  if (!store.groupPlayers.length) return header + emptyState("The groups are set after the Selection Round", "The top 32 from the Selection Round are placed by rank: Group A holds ranks 1, 9, 17 and 25, Group B 2, 10, 18 and 26, and so on to Group H. All eight tables appear here once they are in.");
  return `${header}<div class="grid md-2">${store.groups.map((g) => groupTableHtml(g, { me: profile.id })).join("")}</div>`;
}
