// What every portal page does first: check the sign-in, load the
// tournament, draw the header band, content and footer, and start the
// shared timers and motion (the same language as the landing page).

import { requireAuth } from "./auth.js";
import { loadAll, store, subscribe } from "./store.js";
import { startCountdowns, syncServerClock } from "./time.js";
import { mountShell, mountFooter, heroHtml, tickerHtml, notice, esc } from "./ui.js";
import { animateIn, cursorDot, footerMotion, heroMotion, initSmoothScroll, navAutoHide, progressRing, tickerMotion } from "./motion.js";

// hero(profile) returns the band's settings (see heroHtml in ui.js);
// ticker(profile) optionally returns the words for a band beneath it.
export async function startPage(active, { staff = false, render, hero, ticker } = {}) {
  const profile = await requireAuth({ staff });
  await Promise.all([loadAll(), syncServerClock()]);
  mountShell(profile, active);
  startCountdowns();
  initSmoothScroll();
  navAutoHide();
  progressRing();
  cursorDot();

  const app = document.getElementById("app");

  // Header band, drawn above the content. It only redraws when its
  // numbers change, so live updates don't restart its motion.
  let heroEl = null;
  let lastHero = "";
  const drawHero = (first) => {
    if (!hero) return;
    const config = hero(profile);
    const key = JSON.stringify(config);
    if (key === lastHero) return;
    lastHero = key;
    const html = heroHtml(config, { animate: first });
    const wrap = document.createElement("div");
    wrap.innerHTML = html.trim();
    const next = wrap.firstElementChild;
    if (heroEl) heroEl.replaceWith(next);
    else app.before(next);
    heroEl = next;
    if (first) animateIn(heroEl);
    heroMotion(heroEl, { entrance: first });
  };
  if (hero) {
    document.body.classList.add("has-hero");
    drawHero(true);
    if (ticker) {
      heroEl.insertAdjacentHTML("afterend", tickerHtml(ticker(profile)));
      tickerMotion();
    }
  }

  // Most live updates (a move in someone else's game) change nothing on
  // this page; the page is only rebuilt when what it shows has changed.
  let lastHtml = null;
  const draw = () => {
    const html = (store.error ? notice(`Couldn't load tournament data: ${esc(store.error)}`, "error") : "") + render(profile);
    if (html === lastHtml) return;
    lastHtml = html;
    app.innerHTML = html;
  };
  if (render) {
    draw();
    // Entrance motion plays once, on the first draw; live redraws stay still.
    animateIn(app);
  }
  if (render || hero) {
    // Live games change several times a second. Redraw at most every 0.6 s,
    // and not at all while the page is in the background.
    let timer = null;
    let last = 0;
    const redraw = () => {
      timer = null;
      if (document.hidden) return;
      last = Date.now();
      drawHero(false);
      if (render) draw();
    };
    subscribe(() => {
      if (!timer) timer = setTimeout(redraw, Math.max(0, 600 - (Date.now() - last)));
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && !timer) redraw();
    });
  }

  footerMotion(mountFooter());
  document.fonts?.ready.then(() => window.ScrollTrigger?.refresh());
  return { profile, app, draw, redrawHero: () => drawHero(false) };
}
