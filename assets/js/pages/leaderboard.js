import { store, STAGE_LABEL } from "../store.js";
import { emptyState, esc, pageHeader } from "../ui.js";
import { startPage } from "../page.js";

const STAGE_ORDER = ["group", "r16", "qf", "sf", "final"];

await startPage("leaderboard", { render });

function render(profile) {
  const header = pageHeader("Leaderboard", "Players ranked by rating. Every finished game moves ratings up or down using the Elo system.");
  const entrants = new Set(store.groupPlayers.map((gp) => gp.player_id));
  const final = store.matches.find((m) => m.stage === "final");

  const rows = store.profiles
    .filter((p) => p.role === "player" && (entrants.size === 0 || entrants.has(p.id)))
    .map((p) => {
      const games = store.matches.filter((m) => m.white_id === p.id || m.black_id === p.id);
      let wins = 0, draws = 0, losses = 0, change = 0, deepest = 0;
      for (const m of games) {
        deepest = Math.max(deepest, STAGE_ORDER.indexOf(m.stage));
        if (m.status !== "completed" || !m.result) continue;
        const white = m.white_id === p.id;
        change += (white ? m.white_rating_delta : m.black_rating_delta) ?? 0;
        if (m.result === "1/2-1/2") draws++;
        else if ((m.result === "1-0") === white) wins++;
        else losses++;
      }
      const reached = final?.winner_id === p.id ? "Champion" : games.length ? STAGE_LABEL[STAGE_ORDER[deepest]] : "-";
      return { ...p, wins, draws, losses, change, reached };
    })
    .sort((a, b) => b.rating - a.rating || a.full_name.localeCompare(b.full_name));

  if (!rows.length) return header + emptyState("No players yet", "Once the admin adds players, their ratings and results will be ranked here.");

  const change = (v) => `<span class="num small ${v < 0 ? "signal" : v > 0 ? "" : "dim"}">${v > 0 ? `+${v}` : v}</span>`;
  const podiumClass = ["first-card", "second-card", "third-card"];
  const podium = rows
    .slice(0, 3)
    .map(
      (r, i) => `<div class="panel pad ${podiumClass[i]}">
        <span class="place${i === 0 ? " first" : ""}">#${i + 1}</span>
        <p class="truncate mt-3" style="font-size:var(--text-lg);font-weight:600">${esc(r.full_name)}</p>
        ${r.school ? `<p class="truncate small dim">${esc(r.school)}</p>` : ""}
        <p class="score${i === 0 ? " first chrome-text" : ""}">${r.rating}</p>
        <p class="mt-1">${change(r.change)} <span class="small dim">this tournament</span></p>
      </div>`,
    )
    .join("");

  const body = rows
    .map(
      (r, i) => `<tr class="${r.id === profile.id ? "me" : ""}">
        <td class="num dim">${i + 1}</td>
        <td><span class="${r.id === profile.id ? "strong" : ""}">${esc(r.full_name)}</span>${r.school ? ` <span class="dim">${esc(r.school)}</span>` : ""}</td>
        <td class="r num strong">${r.rating}</td>
        <td class="r">${change(r.change)}</td>
        <td class="c num muted">${r.wins} / ${r.draws} / ${r.losses}</td>
        <td class="r ${r.reached === "Champion" ? "strong" : "muted"}">${r.reached}</td>
      </tr>`,
    )
    .join("");

  return `${header}
    <div class="grid sm-3 podium mb-6">${podium}</div>
    <div class="panel table-wrap">
      <table class="table" style="min-width:640px">
        <thead><tr><th style="width:4rem">Rank</th><th>Player</th><th class="r">Rating</th><th class="r">+/-</th><th class="c">W / D / L</th><th class="r">Reached</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}
