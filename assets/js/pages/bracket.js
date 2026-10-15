import { store, effectiveStatus, STAGE_LABEL, seriesState, rankOf, formatOf, clockLabel } from "../store.js";
import { formatDate, formatTime, serverNow } from "../time.js";
import { R16_PAIRINGS } from "../ops.js";
import { formatPoints } from "../standings.js";
import { emptyState, esc, liveTag } from "../ui.js";
import { startPage } from "../page.js";

const COLUMNS = ["r16", "qf", "sf", "final"];

// Card height and gap in the first column; later columns double the
// spacing so each tie sits level between the two that feed it.
const CARD_H = 76;
const GAP = 16;

const { draw } = await startPage("bracket", { render, hero });
setInterval(draw, 30_000);

function hero() {
  // The road to the final: the third-place series is counted with the
  // others, but it doesn't knock anyone out.
  const ties = store.ties;
  const decided = ties.filter((t) => t.winner_id).length;
  const out = ties.filter((t) => t.winner_id && t.stage !== "third").length;
  const f = (s) => clockLabel(formatOf(s));
  return {
    scene: "rising",
    eyebrow: "Knockout",
    bold: "The road",
    soft: "to the crown.",
    lede: `Every tie is a two-game series with colours reversed: ${f("r16")} in the round of 16, ${f("qf")} in the quarterfinals, ${f("sf")} in the semifinals and ${f("third")} for third place. The final is four games at ${f("final")}. A level series goes to a ${f("tiebreak")} tiebreak game.`,
    stats: [
      { value: 16 - out, label: "Players left" },
      { value: decided, label: `of ${ties.length || 16} series decided` },
      { value: 4, label: "Rounds" },
    ],
  };
}

function render() {
  const ties = store.ties;

  if (!ties.length) {
    return `${emptyState("The bracket is set after the group stage", "These are the round of 16 pairings, filled in once the group tables are final. Matches 1 and 2 meet in quarterfinal 1, 3 and 4 in quarterfinal 2, and so on.")}
      <div class="grid sm-4 tight mt-6">${R16_PAIRINGS.map(
        ([ga, pa, gb, pb], i) => `<div class="panel" style="padding:0.75rem 1rem"><p class="small">${ga}${pa} <span class="dim">vs</span> ${gb}${pb}</p><p class="xs dim mt-1">Match ${i + 1} · QF ${Math.floor(i / 2) + 1}</p></div>`,
      ).join("")}</div>`;
  }

  const unit = CARD_H + GAP;
  const cols = COLUMNS.map((stage, ci) => {
    const items = ties.filter((m) => m.stage === stage).sort((a, b) => a.bracket_slot - b.bracket_slot);
    const step = unit * 2 ** ci;
    const offset = (step - unit) / 2;
    // The third-place series sits under the final.
    const third = stage === "final" ? ties.find((m) => m.stage === "third") : null;
    const thirdCard = third
      ? `<div class="bracket-slot third" style="top:${offset + CARD_H + 56}px;height:${CARD_H}px"><span class="bracket-label">${STAGE_LABEL.third}</span>${card(third)}</div>`
      : "";
    const cards = items
      .map((m, i) => {
        const connector = ci < COLUMNS.length - 1 ? `<span class="connector ${i % 2 === 0 ? "down" : "up"}" style="height:${step / 2}px" aria-hidden="true"></span>` : "";
        const stub = ci > 0 ? `<span class="stub" aria-hidden="true"></span>` : "";
        return `<div class="bracket-slot" style="top:${offset + i * step}px;height:${CARD_H}px">${card(m)}${connector}${stub}</div>`;
      })
      .join("");
    return `<div>
      <h2>${stage === "final" ? `<i class="ph-fill ph-trophy" style="color:var(--chrome)"></i>` : ""}${STAGE_LABEL[stage]} <span class="dim">${clockLabel(formatOf(stage))}</span></h2>
      <div class="bracket-col${stage === "final" ? " final-col" : ""}" style="height:${unit * 8 - GAP}px">${cards}${thirdCard}</div>
    </div>`;
  }).join("");

  return `<p class="swipe-hint"><i class="ph ph-hand-swipe-right" aria-hidden="true"></i> Swipe for later rounds</p><div class="bracket-scroll"><div class="bracket">${cols}</div></div>`;
}

// One tie: both players with their Selection Round rank and series score,
// and a line on where the series stands. It opens the game being played
// (or the next one, or the last one).
function card(tie) {
  const now = serverNow();
  const s = seriesState(tie);
  const started = s.games.some((g) => g.status === "completed" || effectiveStatus(g, now) === "live");
  const line = (id, score) => {
    const p = id ? store.profileById.get(id) : null;
    const cls = tie.winner_id ? (tie.winner_id === id ? " won" : id ? " lost" : "") : "";
    const rank = id ? rankOf(id) : null;
    return `<span class="line${cls}"><span class="pname truncate">${p ? `${rank ? `<span class="rk">${rank}</span>` : ""}${esc(p.full_name)}` : `<span class="dim">To be decided</span>`}</span>${p && started ? `<span class="sc num">${formatPoints(score)}</span>` : ""}</span>`;
  };

  const live = s.games.find((g) => g.status !== "completed" && effectiveStatus(g, now) === "live");
  const next = s.games.find((g) => g.status !== "completed");
  const target = live ?? next ?? s.games[s.games.length - 1];

  let foot;
  if (live) foot = `${liveTag()} <span>${live.game_kind === "game" ? `Game ${live.game_no}` : live.game_kind === "tiebreak" ? "Tiebreak" : "Decider"}</span>`;
  else if (tie.winner_id) {
    const how = s.decider?.status === "completed" ? "after the decider" : s.tiebreak?.status === "completed" ? "after the tiebreak" : "";
    foot = `${esc(store.profileById.get(tie.winner_id)?.full_name.split(" ")[0] ?? "")} goes through${how ? ` ${how}` : ""}`;
  } else if (s.decider) foot = `Decider ${s.decider.scheduled_at ? `· ${formatTime(s.decider.scheduled_at)}` : ""}`;
  else if (s.tiebreak) foot = `Level · tiebreak ${s.tiebreak.scheduled_at ? `at ${formatTime(s.tiebreak.scheduled_at)}` : "to come"}`;
  else if (next?.scheduled_at) foot = `Game ${next.game_no} · ${formatDate(next.scheduled_at)}, ${formatTime(next.scheduled_at)}`;
  else if (s.games.length) foot = `${s.main.length}-game series · not scheduled`;
  else foot = "Waiting for both players";

  const inner = `${line(tie.white_id, s.a)}${line(tie.black_id, s.b)}<span class="foot">${foot}</span>`;
  const cls = `panel bracket-card${live ? " live" : ""}`;
  return target ? `<a href="play.html?id=${target.id}" class="${cls}">${inner}</a>` : `<div class="${cls}">${inner}</div>`;
}
