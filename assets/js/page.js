// What every portal page does first: check the sign-in, load the
// tournament, draw the header, and start the shared timers.

import { requireAuth } from "./auth.js";
import { loadAll, store, subscribe } from "./store.js";
import { startCountdowns, syncServerClock } from "./time.js";
import { mountShell, notice, esc } from "./ui.js";
import { animateIn, cursorDot, navAutoHide, progressRing } from "./motion.js";

export async function startPage(active, { staff = false, render } = {}) {
  const profile = await requireAuth({ staff });
  await Promise.all([loadAll(), syncServerClock()]);
  mountShell(profile, active);
  startCountdowns();
  navAutoHide();
  progressRing();
  cursorDot();

  const app = document.getElementById("app");
  const draw = () => {
    app.innerHTML = (store.error ? notice(`Couldn't load tournament data: ${esc(store.error)}`, "error") : "") + render(profile);
  };
  if (render) {
    draw();
    // Entrance motion plays once, on the first draw; live redraws stay still.
    animateIn(app);
    subscribe(draw);
  }
  return { profile, app, draw };
}
