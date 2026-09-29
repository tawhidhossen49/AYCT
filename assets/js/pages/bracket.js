import { store, effectiveStatus, isKnockout, STAGE_LABEL } from "../store.js";
import { formatDate, formatTime, serverNow } from "../time.js";
import { R16_PAIRINGS } from "../ops.js";
import { emptyState, esc, liveTag, resultText } from "../ui.js";
import { startPage } from "../page.js";

const COLUMNS = ["r16", "qf", "sf", "final"];

// Card height and gap in the first column; later columns double the
// spacing so each game sits level between the two that feed it.
const CARD_H = 76;
const GAP = 16;

const { draw } = await startPage("bracket", { render, hero });
setInterval(draw, 30_000);

function hero() {
  const ko = store.matches.filter(isKnockout);
  const decided = ko.filter((m) => m.winner_id).length;
  return {
    scene: "rising",
    eyebrow: "Knockout",
    bold: "The road",
    soft: "to the crown.",
    lede: "Single games from the round of 16 to the final. Group winners play white against a runner-up from the neighbouring group.",
    stats: [
      { value: ko.length ? 16 - decided : 16, label: "Players left" },
      { value: decided, label: `of ${ko.length || 15} decided` },
      { value: 4, label: "Rounds" },
    ],
  };
}

function render() {
  const header = "";
  const knockout = store.matches.filter(isKnockout);

  if (!knockout.length) {
    return `${header}${emptyState("The bracket is set after the group stage", "These are the round of 16 pairings, filled in once the group tables are final.")}
      <div class="grid sm-4 tight mt-6">${R16_PAIRINGS.map(
        ([ga, pa, gb, pb], i) => `<div class="panel" style="padding:0.75rem 1rem"><p class="small">${ga}${pa} <span class="dim">vs</span> ${gb}${pb}</p><p class="xs dim mt-1">Match ${i + 1}</p></div>`,
      ).join("")}</div>`;
  }

  const unit = CARD_H + GAP;
  const cols = COLUMNS.map((stage, ci) => {
    const items = knockout.filter((m) => m.stage === stage).sort((a, b) => a.bracket_slot - b.bracket_slot);
    const step = unit * 2 ** ci;
    const offset = (step - unit) / 2;
    const cards = items
      .map((m, i) => {
        const connector = ci < COLUMNS.length - 1 ? `<span class="connector ${i % 2 === 0 ? "down" : "up"}" style="height:${step / 2}px" aria-hidden="true"></span>` : "";
        const stub = ci > 0 ? `<span class="stub" aria-hidden="true"></span>` : "";
        return `<div class="bracket-slot" style="top:${offset + i * step}px;height:${CARD_H}px">${card(m)}${connector}${stub}</div>`;
      })
      .join("");
    return `<div>
      <h2>${stage === "final" ? `<i class="ph-fill ph-trophy" style="color:var(--chrome)"></i>` : ""}${STAGE_LABEL[stage]}</h2>
      <div class="bracket-col${stage === "final" ? " final-col" : ""}" style="height:${unit * 8 - GAP}px">${cards}</div>
    </div>`;
  }).join("");

  return `${header}<p class="swipe-hint"><i class="ph ph-hand-swipe-right" aria-hidden="true"></i> Swipe for later rounds</p><div class="bracket-scroll"><div class="bracket">${cols}</div></div>`;
}

function card(m) {
  const status = effectiveStatus(m, serverNow());
  const line = (id) => {
    const p = id ? store.profileById.get(id) : null;
    const cls = m.winner_id ? (m.winner_id === id ? " won" : id ? " lost" : "") : "";
    return `<span class="line${cls}"><span class="pname truncate">${p ? esc(p.full_name) : `<span class="dim">To be decided</span>`}</span>${p ? `<span class="num xs dim">${p.rating}</span>` : ""}</span>`;
  };
  let foot;
  if (status === "live") foot = liveTag();
  else if (status === "completed") foot = `<span class="num">${resultText(m)}${m.result === "1/2-1/2" && !m.winner_id ? " · tiebreak pending" : ""}</span>`;
  else if (m.scheduled_at) foot = `${formatDate(m.scheduled_at)}, ${formatTime(m.scheduled_at)}`;
  else foot = "Not scheduled";
  return `<a href="play.html?id=${m.id}" class="panel bracket-card${status === "live" ? " live" : ""}">${line(m.white_id)}${line(m.black_id)}<span class="foot">${foot}</span></a>`;
}
