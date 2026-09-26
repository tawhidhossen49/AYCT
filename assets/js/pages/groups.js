import { store } from "../store.js";
import { TIEBREAK_NOTE } from "../standings.js";
import { emptyState, groupTableHtml, pageHeader } from "../ui.js";
import { startPage } from "../page.js";

await startPage("groups", { render });

function render(profile) {
  const header = pageHeader("Groups", `Eight groups of four. The top two in each group reach the round of 16. ${TIEBREAK_NOTE}`);
  if (!store.groupPlayers.length) return header + emptyState("The draw hasn't happened yet", "Once the organisers draw the groups, all eight tables will appear here.");
  return `${header}<div class="grid md-2">${store.groups.map((g) => groupTableHtml(g, { me: profile.id })).join("")}</div>`;
}
