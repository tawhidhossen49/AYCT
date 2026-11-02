// Public landing page: preloader, pinned hero, the format console, the road
// to the crown, the ring of groups, a live demo board, the roles deck, and
// the footer.

import { FORM_KINDS, formLinks, countdownOf } from "../registration.js";
import { supabase } from "../supabase.js";
import { currentProfile } from "../auth.js";
import { reduced, hasGsap, lite, initSmoothScroll, getLenis, animateIn, navAutoHide, progressRing, cursorDot, glide } from "../motion.js";
import { Chessground, Chess } from "../board.js";
import { loadManifest, createSequence } from "../sequence.js";

const { gsap, ScrollTrigger, SplitText } = window;

// Morphy vs Duke Karl of Brunswick & Count Isouard, Paris 1858.
const OPERA = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");
const motion = hasGsap && !reduced;
// Animated blur is the costliest effect on a phone; there the text only
// fades and slides.
const blur = (px) => (lite ? {} : { filter: `blur(${px}px)` });

// ---------------------------------------------------------------- data

// The current edition's year and registration form links are public.
const edition = supabase
  .from("tournaments")
  .select("year, registration")
  .order("is_active", { ascending: false })
  .order("year", { ascending: false })
  .limit(1)
  .maybeSingle()
  .then(({ data }) => data);
edition.then((data) => {
  if (data?.year) document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = data.year));
  startCountdown(countdownOf(data?.registration));
});

// The countdown on the first screen and above the last Register button.
// The organisers set its time and wording; it disappears once the time
// has passed.
function startCountdown(cd) {
  const slots = [...document.querySelectorAll("[data-countdown-slot]")];
  if (!cd || cd.at <= Date.now() || !slots.length) return;
  const two = (n) => String(n).padStart(2, "0");
  const units = [["Days", 86_400_000], ["Hrs", 3_600_000], ["Min", 60_000], ["Sec", 1000]];
  for (const slot of slots) {
    slot.querySelector("[data-countdown-label]").textContent = cd.label;
    slot.querySelector("[data-countdown-units]").innerHTML = units.map(([name]) => `<span class="lc__unit"><b>00</b><i>${name}</i></span>`).join("");
    slot.hidden = false;
  }
  // Short phones make room for it on the first screen (see landing.css).
  const intro = document.querySelector(".hv__intro");
  intro?.classList.add("has-countdown");
  const paint = () => {
    let left = cd.at - Date.now();
    if (left <= 0) {
      slots.forEach((slot) => (slot.hidden = true));
      intro?.classList.remove("has-countdown");
      clearInterval(timer);
      return;
    }
    const values = units.map(([, ms]) => {
      const v = Math.floor(left / ms);
      left -= v * ms;
      return two(v);
    });
    for (const slot of slots) {
      slot.querySelectorAll(".lc__unit b").forEach((el, i) => {
        if (el.textContent !== values[i]) el.textContent = values[i];
      });
    }
  };
  const timer = setInterval(paint, 1000);
  paint();
}

// "Register now" asks what the visitor wants to register for (player,
// campus ambassador, partnership, organising team) and opens that Google
// Form. Until the organisers add a link the buttons say "Registration coming
// soon" and go nowhere. Members who are already in get "Open portal" instead.
Promise.all([edition, currentProfile()]).then(([data, profile]) => {
  const arrow = `<i class="ph-bold ph-arrow-right"></i>`;
  if (profile) {
    document.querySelectorAll("[data-register-link]").forEach((a) => {
      a.href = "home.html";
      a.removeAttribute("aria-disabled");
      a.innerHTML = `Open the portal ${arrow}`;
    });
    return;
  }
  const links = formLinks(data?.registration);
  const open = Object.values(links).some(Boolean);
  const ask = (e) => {
    e.preventDefault();
    registerChooser(links);
  };
  document.querySelectorAll("[data-register-link]").forEach((a) => {
    if (open) {
      a.href = "#register";
      a.setAttribute("aria-haspopup", "dialog");
      a.removeAttribute("aria-disabled");
      a.innerHTML = `Register now ${arrow}`;
      a.addEventListener("click", ask);
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.innerHTML = "Registration coming soon";
    }
  });
  const foot = document.querySelector("[data-register-foot]");
  if (foot && open) {
    foot.hidden = false;
    foot.querySelector("a").href = "#register";
    foot.querySelector("a").addEventListener("click", ask);
  }
});

// The four things people can register for. Each opens its form in a new
// tab; one without a link yet is shown as coming soon.
function registerChooser(links) {
  const d = document.createElement("dialog");
  d.className = "modal wide reg-chooser";
  d.setAttribute("aria-labelledby", "reg-chooser-title");
  const options = FORM_KINDS.map((k) => {
    const inner = `<span class="reg-option-icon"><i class="ph-bold ph-${k.icon}" aria-hidden="true"></i></span>
      <span class="reg-option-text"><strong>${k.label}</strong><span>${k.blurb}</span></span>`;
    return links[k.key]
      ? `<a class="reg-option" href="${links[k.key]}" target="_blank" rel="noopener" data-kind="${k.key}">${inner}<i class="ph-bold ph-arrow-up-right reg-option-go" aria-hidden="true"></i></a>`
      : `<div class="reg-option soon" data-kind="${k.key}" aria-disabled="true">${inner}<span class="reg-option-go">Coming soon</span></div>`;
  }).join("");
  d.innerHTML = `<div class="modal-head"><h2 id="reg-chooser-title">Register now</h2><button class="icon-btn" data-close aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div>
    <div class="modal-body">
      <p class="muted">What would you like to register for?</p>
      <div class="reg-options">${options}</div>
      <p class="xs dim reg-chooser-note">Each choice opens a Google Form in a new tab.</p>
    </div>`;
  document.body.append(d);
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close], a.reg-option")) d.close();
  });
  d.addEventListener("close", () => d.remove());
  d.showModal();
}

// ---------------------------------------------------------------- static pieces (built for every visitor)

buildDots();
buildRing();
setupDemoBoard();

// ---------------------------------------------------------------- motion

initSmoothScroll();
navAutoHide();
progressRing();
cursorDot();
formatConsole();

// The hero film starts downloading right away, while the preloader shows.
const heroCanvas = document.querySelector(".hv__canvas");
const heroBase = heroCanvas?.dataset.sequence;
const heroManifest = motion && heroBase ? await loadManifest(`${heroBase}manifest.json`) : null;
let reportFilm = () => {};
const heroSeq = heroManifest
  ? createSequence({ canvas: heroCanvas, manifest: heroManifest, baseUrl: heroBase, onProgress: (p) => reportFilm(p) })
  : null;

if (!motion) {
  // Without motion: the opening over the first frame, nothing pinned.
  document.querySelector(".preloader")?.remove();
  animateIn();
} else {
  // A cinematic page always opens at the start of the film.
  if (!location.hash) {
    history.scrollRestoration = "manual";
    window.scrollTo(0, 0);
  }
  await preloader(heroSeq);
  heroCanvas.classList.toggle("is-ready", Boolean(heroSeq));
  // Once the film has faded in over the still picture, the still is no
  // longer drawn underneath it on every frame.
  if (heroSeq) setTimeout(() => document.querySelector(".hv__poster")?.style.setProperty("visibility", "hidden"), 900);
  hero(heroSeq);
  heroIntro();
  ticker();
  manifesto();
  road();
  ring();
  deck();
  ctaAndFooter();
  animateIn();
  document.fonts.ready.then(() => {
    ScrollTrigger.refresh();
    goToHash();
  });
}

// Links like index.html#faq: the browser jumps before the pinned sections
// have stretched the page, so go to the section again once they have.
function goToHash() {
  const target = location.hash.length > 1 && document.querySelector(location.hash);
  if (!target) return;
  const y = target.getBoundingClientRect().top + window.scrollY;
  const lenis = getLenis();
  // The smooth scroller measured the page before the pins made it taller.
  lenis?.resize();
  if (lenis) lenis.scrollTo(y, { immediate: true, force: true });
  else window.scrollTo(0, y);
}

// ---------------------------------------------------------------- preloader

// The ring fills with real progress: fonts and the first pass of film
// frames (every 16th). The rest of the film keeps loading afterwards.
function preloader(seq) {
  return new Promise((resolve) => {
    const el = document.querySelector(".preloader");
    const bar = el.querySelector(".bar");
    const count = el.querySelector(".preloader__count");
    const length = 389.6;
    const shown = { p: 0 };
    const parts = { base: 0, film: seq ? 0 : 1 };
    let released = false;

    const paint = () => {
      const target = parts.base * 0.25 + parts.film * 0.75;
      gsap.to(shown, {
        p: target,
        duration: 0.5,
        ease: "power2.out",
        overwrite: true,
        onUpdate: () => {
          bar.style.strokeDashoffset = String(length * (1 - shown.p));
          count.textContent = Math.round(shown.p * 100);
        },
      });
    };

    reportFilm = (p) => {
      parts.film = p;
      paint();
    };

    const basics = [document.fonts.ready, new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = "assets/sequences/hero/poster.webp"; })];
    Promise.all(basics).then(() => {
      parts.base = 1;
      paint();
    });

    const release = () => {
      if (released) return;
      released = true;
      parts.base = parts.film = 1;
      gsap.to(shown, {
        p: 1,
        duration: 0.4,
        ease: "power2.out",
        overwrite: true,
        onUpdate: () => {
          bar.style.strokeDashoffset = String(length * (1 - shown.p));
          count.textContent = Math.round(shown.p * 100);
        },
        onComplete: () =>
          gsap.to(el, {
            clipPath: "circle(0% at 50% 50%)",
            duration: 1.1,
            ease: "expo.inOut",
            onComplete: () => {
              el.remove();
              resolve();
            },
          }),
      });
    };

    // At least 0.9s of brand, never more than 4s of waiting.
    Promise.all([...basics, seq ? seq.firstPass : null, new Promise((r) => setTimeout(r, 900))]).then(release);
    setTimeout(release, 4000);
  });
}

// ---------------------------------------------------------------- hero film

function hero(seq) {
  const stage = document.querySelector(".hv__stage");
  const mobile = window.matchMedia("(max-width: 899px)").matches;
  const tl = gsap.timeline({ paused: true });

  // The film itself spans the whole timeline (0 -> 1).
  if (seq) seq.addTo(tl);
  else tl.to({}, { duration: 1 }, 0);

  // Opening title lifts away as the camera starts to move.
  tl.to(".hv__intro", { autoAlpha: 0, y: -60, ...blur(10), duration: 0.1, ease: "power2.in" }, 0.1);

  // "Think." on the left, then "Play." on the right, each in the side of the
  // frame the pieces have just left.
  const chapter = (sel, dir, inAt, outAt) => {
    const away = mobile ? { y: 30 } : { x: 70 * dir };
    const leave = mobile ? { y: -24 } : { x: -30 * dir };
    tl.fromTo(sel, { autoAlpha: 0, ...blur(14), ...away }, { autoAlpha: 1, x: 0, y: 0, ...blur(0), duration: 0.07, ease: "power3.out" }, inAt);
    tl.to(sel, { autoAlpha: 0, ...blur(10), ...leave, duration: 0.06, ease: "power2.in" }, outAt - 0.06);
  };
  chapter(".hv__chapter--left .hv__chapter-inner", -1, 0.31, 0.5);
  chapter(".hv__chapter--right .hv__chapter-inner", 1, 0.55, 0.75);

  // Finale: "Become" and "Legendary." settle either side of the king.
  const flankFrom = (dir) => (mobile ? { y: 24 } : { x: 60 * dir });
  tl.fromTo(".hv__flank--left .hv__flank-inner", { autoAlpha: 0, ...blur(14), ...flankFrom(-1) }, { autoAlpha: 1, x: 0, y: 0, ...blur(0), duration: 0.09, ease: "power3.out" }, 0.8)
    .fromTo(".hv__flank--right .hv__flank-inner", { autoAlpha: 0, ...blur(14), ...flankFrom(1) }, { autoAlpha: 1, x: 0, y: 0, ...blur(0), duration: 0.09, ease: "power3.out" }, 0.85);

  tl.fromTo(".hv__progress-fill", { scaleX: 0 }, { scaleX: 1, ease: "none", duration: 1 }, 0);

  // Hold the final frame for the last stretch of scroll, so the finale
  // always settles before the page moves on.
  tl.to({}, { duration: 0.14 });

  // Two-way playback: the film follows the scroll, forward going down and
  // back to its first frame going up. It eases toward the scroll position,
  // so fast or jerky scrolling still plays smoothly in both directions.
  const playTo = (p) => gsap.to(tl, { progress: p, duration: 0.9, ease: "power3.out", overwrite: true });

  // A phone that can't keep up with the film gets a lighter version of it:
  // while the film is being scrolled, 90 frames are timed, and if half of
  // them took longer than 30 ms (under about 33 a second) the film drops to
  // every other frame on a smaller canvas. Fast phones never notice.
  let pace = lite && seq ? { times: [], last: 0, until: 0, on: false } : null;
  function watchPace() {
    if (!pace) return;
    pace.until = performance.now() + 250;
    if (pace.on) return;
    pace.on = true;
    pace.last = 0;
    const tick = (now) => {
      if (!pace) return;
      if (now > pace.until) {
        pace.on = false;
        return;
      }
      if (pace.last) pace.times.push(now - pace.last);
      pace.last = now;
      if (pace.times.length >= 90) {
        const median = pace.times.sort((a, b) => a - b)[45];
        if (median > 30) seq.eco();
        pace = null;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const st = ScrollTrigger.create({
    trigger: ".hv",
    start: "top top",
    end: `+=${mobile ? 240 : 320}%`,
    pin: stage,
    anticipatePin: 1,
    onUpdate: (self) => {
      playTo(self.progress);
      watchPace();
    },
  });
  // Opening mid-page (e.g. from a link): show the film where the page is.
  if (st.progress > 0) tl.progress(st.progress);
}

// Once the preloader opens: the camera settles and the opening rises in.
function heroIntro() {
  gsap.timeline({ defaults: { ease: "expo.out" } })
    .fromTo([".hv__canvas", ".hv__poster"], { scale: 1.08 }, { scale: 1, duration: 2.4 }, 0)
    .from("[data-intro]", { y: 34, autoAlpha: 0, ...blur(12), duration: 1.3, stagger: 0.1, clearProps: "filter" }, 0.2)
    .from(".hv__progress", { autoAlpha: 0, duration: 1 }, 0.9);
}

// ---------------------------------------------------------------- ticker

function ticker() {
  const track = document.querySelector(".ticker__track");
  track.innerHTML += track.innerHTML; // two copies for a seamless loop
  const loop = glide(track);
  if (!loop) return;
  // Scrolling faster spins it faster, then it settles.
  ScrollTrigger.create({
    onUpdate: (self) => {
      const speed = 1 + Math.min(Math.abs(self.getVelocity()) / 600, 5);
      gsap.to(loop, { timeScale: speed, duration: 0.2, overwrite: true });
      gsap.to(loop, { timeScale: 1, duration: 1.2, delay: 0.25, overwrite: false });
    },
  });
}

// ---------------------------------------------------------------- manifesto

function manifesto() {
  const el = document.querySelector("[data-words]");
  if (!SplitText) return;
  document.fonts.ready.then(() => {
    const split = SplitText.create(el, { type: "words", wordsClass: "word" });
    gsap.fromTo(split.words, { opacity: 0.12 }, {
      opacity: 1,
      stagger: 0.05,
      ease: "none",
      scrollTrigger: { trigger: el, start: "top 78%", end: "bottom 45%", scrub: true },
    });
  });
}

// ---------------------------------------------------------------- format console

// A chess board holds 32 pieces and the tournament 32 players, so each piece
// is a player. Selection: the starting position. Groups: eight clusters of
// four, dealt by rank. Knockout: pairs facing each other, half leaving each
// round, until two kings are left for the final. The roster is in rank
// order, so the pieces that stay are always the first in it.
function formatConsole() {
  const root = document.querySelector("[data-format]");
  const svg = root.querySelector("[data-format-board]");
  const stages = [...root.querySelectorAll(".fc__panel")];
  const STEP = 5; // seconds on each stage during the tour
  const [A, B, LEFT, TOP] = [38, 19, 320, 86];
  const spot = ([f, r]) => ({ x: LEFT + (f - r) * A, y: TOP + (f + r) * B + B });

  const roster = [["k", [4]], ["q", [3]], ["r", [0, 7]], ["b", [2, 5]], ["n", [1, 6]], ["p", [0, 1, 2, 3, 4, 5, 6, 7]]].flatMap(([type, files]) =>
    files.flatMap((f) => {
      const back = type === "p" ? 1 : 0;
      return [{ type, white: true, home: [f, 7 - back] }, { type, white: false, home: [f, back] }];
    }),
  );
  const blocks = [[0, 0], [2, 0], [1, 1], [3, 1], [0, 2], [2, 2], [1, 3], [3, 3]];
  const facing = (files) => files.flatMap((f) => [[f, 4], [f, 3]]);
  const layouts = [
    roster.map((p) => p.home),
    roster.map((_, i) => [blocks[i % 8][0] * 2 + ((i >> 3) & 1), blocks[i % 8][1] * 2 + (i >> 4)]),
    facing([0, 1, 2, 3, 4, 5, 6, 7]),
    facing([0, 2, 5, 7]),
    facing([1, 6]),
    [null, null, [3, 5], [5, 3]],
    [[3, 5], [5, 3]],
  ];

  // Silhouettes of turned pieces, on a 40 by 64 grid with the foot at the bottom.
  const foot = "M7 63c0-5 3-7 6-8h14c3 1 6 3 6 8z";
  const shapes = {
    p: `${foot}M13 55c3-8 4-14 3-19h8c-1 5 0 11 3 19zM12 37v-3h16v3zM20 13a10.5 10.5 0 1 1 0 21 10.5 10.5 0 0 1 0-21z`,
    r: `${foot}M12 55l3-27h10l3 27zM10 28v-4l2-2V10h5v5h6v-5h5v12l2 2v4z`,
    b: `${foot}M13 55c3-8 4-13 3-19h8c-1 6 0 11 3 19zM12 36v-3h16v3zM20 9c7 6 10 11 9 16-1 4-4 7-9 8-5-1-8-4-9-8-1-5 2-10 9-16zM20 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z`,
    n: `${foot}M12 55c0-11 6-16 10-22l-8 4-5-1-2-5 13-14 1-7 5 5c9 3 13 13 12 40z`,
    q: `${foot}M13 55c3-8 4-16 3-23h8c-1 7 0 15 3 23zM11 33v-3h18v3zM11 29L6 12l8 7 2-13 4 12 4-12 2 13 8-7-5 17zM20 0a2.6 2.6 0 1 1 0 5.2A2.6 2.6 0 0 1 20 0z`,
    k: `${foot}M13 55c3-8 4-15 3-22h8c-1 7 0 14 3 22zM11 33v-3h18v3zM11 29c-5-7-3-13 4-13 2 0 4 1 5 3 1-2 3-3 5-3 7 0 9 6 4 13zM18 15V9h-4V5h4V0h4v5h4v4h-4v6z`,
  };
  const SIZE = { p: 38, r: 42, n: 45, b: 49, q: 54, k: 60 };

  let squares = "";
  for (let f = 0; f < 8; f++) {
    for (let r = 0; r < 8; r++) {
      const { x, y } = spot([f, r]);
      squares += `<polygon class="fc-tile${(f + r) % 2 ? " alt" : ""}" data-sq="${f},${r}" points="${x},${y - B} ${x + A},${y} ${x},${y + B} ${x - A},${y}"/>`;
    }
  }
  const edge = `${LEFT},${TOP} ${LEFT + 8 * A},${TOP + 8 * B} ${LEFT},${TOP + 16 * B} ${LEFT - 8 * A},${TOP + 8 * B}`;
  // File letters and rank numbers along the two near edges.
  const notation = [..."abcdefgh"]
    .map((file, n) => {
      const a = spot([n, 7]);
      const b = spot([7, 7 - n]);
      return `<text x="${a.x - 20}" y="${a.y + 27}">${file}</text><text x="${b.x + 20}" y="${b.y + 27}">${n + 1}</text>`;
    })
    .join("");
  svg.innerHTML = `<defs>
      <linearGradient id="fcW"><stop offset="0" stop-color="#8d929c"/><stop offset=".3" stop-color="#fff"/><stop offset=".55" stop-color="#b9bdc6"/><stop offset=".8" stop-color="#f4f5f7"/><stop offset="1" stop-color="#7d818b"/></linearGradient>
      <linearGradient id="fcB"><stop offset="0" stop-color="#23252c"/><stop offset=".32" stop-color="#6d717c"/><stop offset=".55" stop-color="#1b1c22"/><stop offset=".82" stop-color="#3d4049"/><stop offset="1" stop-color="#101116"/></linearGradient>
      <linearGradient id="fcScan"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".28"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <clipPath id="fcClip"><polygon points="${edge}"/></clipPath>
      ${Object.entries(shapes).map(([k, d]) => `<symbol id="fc-${k}" viewBox="0 0 40 64" preserveAspectRatio="xMidYMax meet" overflow="visible"><path d="${d}"/></symbol>`).join("")}
    </defs>
    ${squares}
    <polygon points="${edge}" fill="none" stroke="rgb(255 255 255 / .3)"/>
    <g class="fc-notation">${notation}</g>
    <g clip-path="url(#fcClip)"><rect data-scan x="-160" y="0" width="160" height="400" fill="url(#fcScan)"/></g>
    <g data-pieces></g>`;

  const tiles = [...svg.querySelectorAll(".fc-tile")];
  const layer = svg.querySelector("[data-pieces]");
  const scan = svg.querySelector("[data-scan]");
  const pieces = roster.map((p) => {
    const h = SIZE[p.type];
    const w = (h * 40) / 64;
    const el = document.createElementNS("http://www.w3.org/2000/svg", "g");
    el.setAttribute("fill", `url(#${p.white ? "fcW" : "fcB"})`);
    if (!p.white) el.setAttribute("stroke", "rgb(255 255 255 / .4)");
    el.setAttribute("stroke-width", ".7");
    el.innerHTML = `<ellipse class="fc-glow" rx="${w * 0.42}" ry="${w * 0.2}" stroke="none"/><use href="#fc-${p.type}" x="${-w / 2}" y="${2 - h}" width="${w}" height="${h}"/>`;
    layer.append(el);
    return { el, on: false, y: 0 };
  });

  // Puts the board in a stage. Pieces that leave rise and fade out.
  const setBoard = (i, animate) => {
    const lit = new Set(layouts[i].filter(Boolean).map(String));
    root.querySelector("[data-format-count]").textContent = lit.size;
    tiles.forEach((tile) => tile.classList.toggle("on", lit.has(tile.dataset.sq)));
    pieces.forEach((p, k) => {
      const sq = layouts[i][k];
      const to = sq ? spot(sq) : null;
      if (!animate) {
        p.el.style.visibility = to ? "" : "hidden";
        if (to) p.el.setAttribute("transform", `translate(${to.x} ${to.y})`);
      } else if (to) {
        if (!p.on) gsap.set(p.el, { x: to.x, y: to.y - 46, autoAlpha: 0 });
        gsap.to(p.el, { x: to.x, y: to.y, autoAlpha: 1, duration: p.on ? 1 : 0.8, delay: k * 0.008, ease: p.on ? "expo.inOut" : "power3.out", overwrite: true });
      } else if (p.on) {
        gsap.to(p.el, { y: p.y - 46, autoAlpha: 0, duration: 0.55, delay: k * 0.006, ease: "power2.in", overwrite: true });
      }
      p.on = Boolean(to);
      if (to) p.y = to.y;
    });
    // Back to front, so nearer pieces stand in front of further ones.
    pieces.filter((p) => p.on).sort((a, b) => a.y - b.y).forEach((p) => layer.append(p.el));
    if (animate) gsap.fromTo(scan, { attr: { x: -160 } }, { attr: { x: 640 }, duration: 1.1, ease: "power2.inOut" });
  };

  // The clock's digits run through numbers, then settle left to right.
  const decoding = new Map();
  const decode = (el) => {
    el.dataset.text ??= el.textContent;
    const text = el.dataset.text;
    const state = { p: 0 };
    decoding.get(el)?.kill();
    decoding.set(el, gsap.to(state, {
      p: 1,
      duration: 0.65,
      ease: "none",
      onUpdate: () => {
        const fixed = Math.floor(state.p * text.length);
        el.textContent = [...text].map((c, n) => (n < fixed || c === "+" ? c : Math.floor(Math.random() * 10))).join("");
      },
      onComplete: () => (el.textContent = text),
    }));
  };

  // The rail is built here, so without scripts the stages stay a plain list.
  const rail = document.createElement("div");
  rail.className = "fc__rail";
  rail.setAttribute("role", "tablist");
  rail.setAttribute("aria-label", "Tournament stages");
  stages.forEach((stage, i) => {
    stage.id = `fc-stage-${i}`;
    stage.setAttribute("role", "tabpanel");
    stage.setAttribute("aria-labelledby", `fc-tab-${i}`);
    rail.insertAdjacentHTML("beforeend", `<button class="fc__tab" type="button" role="tab" id="fc-tab-${i}" aria-controls="fc-stage-${i}" aria-label="${stage.dataset.label}"><span class="fc__track"><i></i></span><span class="fc__code">${stage.dataset.code}</span><span class="fc__label">${stage.dataset.label}</span></button>`);
  });
  const tabs = [...rail.querySelectorAll(".fc__tab")];
  root.querySelector("[data-format-panels]").before(rail);
  root.classList.add("is-ready");

  let current = 0;
  let touring = motion;
  let hovering = false;
  let inView = false;
  let begun = false;
  let timer = null;

  const pauseBtn = document.createElement("button");
  pauseBtn.className = "fc__pause";
  pauseBtn.type = "button";
  const paintPause = () => {
    pauseBtn.innerHTML = `<i class="ph-bold ph-${touring ? "pause" : "play"}" aria-hidden="true"></i>`;
    pauseBtn.setAttribute("aria-label", touring ? "Pause the stage tour" : "Play the stage tour");
  };
  if (motion) {
    paintPause();
    rail.append(pauseBtn);
  } else {
    rail.style.gridTemplateColumns = "repeat(7, minmax(0, 1fr))";
  }

  const hold = () => timer?.paused(hovering || !inView);
  const wait = () => {
    timer?.kill();
    timer = null;
    gsap.set(rail.querySelectorAll(".fc__track i"), { clearProps: "transform" });
    if (!touring) return;
    timer = gsap.fromTo(tabs[current].querySelector(".fc__track i"), { scaleX: 0 }, { scaleX: 1, duration: STEP, ease: "none", onComplete: () => go((current + 1) % stages.length) });
    hold();
  };

  const mark = (i) => {
    current = i;
    stages.forEach((s, k) => s.classList.toggle("is-on", k === i));
    tabs.forEach((t, k) => {
      t.setAttribute("aria-selected", String(k === i));
      t.tabIndex = k === i ? 0 : -1;
      t.classList.toggle("is-past", k < i);
    });
  };
  const go = (i) => {
    mark(i);
    setBoard(i, motion);
    if (!motion) return;
    const parts = stages[i].children;
    gsap.killTweensOf(parts);
    gsap.fromTo(parts, { y: 14, autoAlpha: 0 }, { y: 0, autoAlpha: 1, duration: 0.7, ease: "power3.out", stagger: 0.05 });
    decode(stages[i].querySelector(".fc__clock"));
    wait();
  };

  // Choosing a stage ends the tour, so it stays on what they picked.
  const pick = (i) => {
    touring = false;
    if (motion) paintPause();
    go(i);
  };
  tabs.forEach((tab, i) => tab.addEventListener("click", () => pick(i)));
  rail.addEventListener("keydown", (e) => {
    const to = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: tabs.length - 1 }[e.key];
    if (to === undefined || !e.target.closest(".fc__tab")) return;
    e.preventDefault();
    const i = (to + tabs.length) % tabs.length;
    pick(i);
    tabs[i].focus();
  });
  pauseBtn.addEventListener("click", () => {
    touring = !touring;
    paintPause();
    wait();
  });

  // The tour waits while the pointer is on it, and while it's off screen.
  root.addEventListener("pointerenter", (e) => {
    hovering = e.pointerType === "mouse";
    hold();
  });
  root.addEventListener("pointerleave", () => {
    hovering = false;
    hold();
  });

  // The first stage's text shows at once; the pieces drop in when it's seen.
  mark(0);
  if (!motion) return setBoard(0, false);
  new IntersectionObserver(([entry]) => {
    inView = entry.isIntersecting;
    if (inView && !begun) {
      begun = true;
      go(0);
    }
    hold();
  }, { threshold: 0.3 }).observe(root);
}

// ---------------------------------------------------------------- road to the crown

// The field of 32 dots beside the stages. Each dot has a rank: the dots with
// a rank below the players-left count stay lit, so 32 -> 16 -> 8 ... knocks
// out a scattered half each time, and rank 0 is the champion. The order is
// fixed (a seeded shuffle), so the field looks the same on every visit.
function buildDots() {
  const field = document.querySelector("[data-field]");
  if (!field) return;
  const ranks = Array.from({ length: 32 }, (_, i) => i);
  let seed = 7;
  for (let i = ranks.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280;
    const j = Math.floor((seed / 233280) * (i + 1));
    [ranks[i], ranks[j]] = [ranks[j], ranks[i]];
  }
  field.innerHTML = ranks
    .map((r) => `<i data-rank="${r}" class="${r === 0 ? "champ" : ""}" style="--d:${((r % 16) * 0.025).toFixed(3)}s"></i>`)
    .join("");
}

// Scrolling down, each stage that reaches the middle of the screen becomes
// the current one: the count drops, its knocked-out dots switch off and the
// spine fills to it. Scrolling up undoes it step by step. On a computer the
// cards are scrubbed in with a slight tilt and dim as they pass; on phones
// they simply rise in (and sink back out going up), which costs next to
// nothing while scrolling.
function road() {
  const section = document.querySelector(".road");
  const counter = document.querySelector("[data-road-count]");
  const nowEl = document.querySelector("[data-road-now]");
  const dots = [...document.querySelectorAll("[data-field] i")];
  const stages = gsap.utils.toArray(".road .stage");
  let current = null;

  const show = (i) => {
    if (i === current) return;
    const goingDown = current === null || i > current;
    current = i;
    const stage = stages[Math.max(0, i)];
    const left = i < 0 ? 32 : Number(stage.dataset.left);
    if (counter.textContent !== String(left)) {
      counter.textContent = left;
      gsap.fromTo(counter, { yPercent: goingDown ? 35 : -35, autoAlpha: 0.15 }, { yPercent: 0, autoAlpha: 1, duration: 0.55, ease: "expo.out", overwrite: true });
    }
    nowEl.textContent = stage.dataset.name;
    dots.forEach((d) => d.classList.toggle("out", Number(d.dataset.rank) >= left));
    section.classList.toggle("is-crowned", left === 1);
    stages.forEach((s, k) => {
      s.classList.toggle("is-active", k === i);
      s.classList.toggle("is-past", k < i);
    });
  };
  show(-1);

  stages.forEach((stage, i) => {
    ScrollTrigger.create({
      trigger: stage,
      start: "top 60%",
      end: "bottom 60%",
      onEnter: () => show(i),
      onEnterBack: () => show(i),
      onLeaveBack: () => show(i - 1),
    });
  });

  // The spine fills from the first stage to the last.
  gsap.fromTo(
    ".road__fill span",
    { scaleY: 0 },
    { scaleY: 1, ease: "none", scrollTrigger: { trigger: ".road__list", start: "top 60%", end: "bottom 60%", scrub: lite ? true : 0.5 } },
  );

  stages.forEach((stage) => {
    const card = stage.querySelector(".stage-card, .road__crown");
    if (lite) {
      gsap.fromTo(card, { y: 48, autoAlpha: 0 }, {
        y: 0, autoAlpha: 1, duration: 0.7, ease: "power3.out",
        scrollTrigger: { trigger: stage, start: "top 88%", toggleActions: "play none none reverse" },
      });
      return;
    }
    gsap
      .timeline({ scrollTrigger: { trigger: stage, start: "top bottom", end: "bottom top", scrub: 0.6 } })
      .fromTo(card, { y: 140, rotateX: 16, scale: 0.92, autoAlpha: 0 }, { y: 0, rotateX: 0, scale: 1, autoAlpha: 1, ease: "power2.out", duration: 0.42 })
      .to(card, { y: -50, scale: 0.97, autoAlpha: 0.32, ease: "power1.in", duration: 0.3 }, 0.7);
  });
}

// ---------------------------------------------------------------- ring of groups

function buildRing() {
  const ring = document.querySelector("[data-ring]");
  ring.innerHTML = "ABCDEFGH"
    .split("")
    .map(
      // The Selection Round ranks each group holds: A 1, 9, 17, 25 and so on.
      (l, i) => `<article class="cyl__card">
        <div class="row between"><span class="eyebrow">Group</span><span class="num xs dim">4 players</span></div>
        <p class="letter chrome-text">${l}</p>
        <div>
          <p>Double round robin over six rounds. The top two reach the round of 16.</p>
          <div class="pots mt-3" title="Selection Round ranks">${[0, 1, 2, 3].map((s) => `<span>#${s * 8 + i + 1}</span>`).join("")}</div>
        </div>
      </article>`,
    )
    .join("");
}

function ring() {
  const mm = gsap.matchMedia();
  mm.add("(min-width: 900px)", () => {
    const ringEl = document.querySelector("[data-ring]");
    const items = [...ringEl.children];
    const n = items.length;
    const step = 360 / n;
    const radius = Math.round((n * 350) / (2 * Math.PI)); // ~350px of arc per 300px card
    // Rotate first, then push out, so the cards spread around the ring.
    items.forEach((it, i) => (it.style.transform = `rotateY(${i * step}deg) translateZ(${radius}px)`));
    gsap.set(ringEl, { z: -radius, rotateX: -6 });
    gsap.to(ringEl, {
      rotateY: -step * (n - 1),
      ease: "none",
      scrollTrigger: { trigger: ".cyl", start: "top top", end: "+=220%", pin: true, scrub: 1, anticipatePin: 1 },
    });
    return () => {
      gsap.set([ringEl, ...items], { clearProps: "all" });
    };
  });
  // Phones and tablets: the same ring, with its size taken from the card width.
  mm.add("(max-width: 899px)", () => {
    const ringEl = document.querySelector("[data-ring]");
    const items = [...ringEl.children];
    const n = items.length;
    const step = 360 / n;
    const radius = Math.round((n * ringEl.offsetWidth * (350 / 300)) / (2 * Math.PI));
    items.forEach((it, i) => (it.style.transform = `rotateY(${i * step}deg) translateZ(${radius}px)`));
    gsap.set(ringEl, { z: -radius, rotateX: -6 });
    gsap.to(ringEl, {
      rotateY: -step * (n - 1),
      ease: "none",
      scrollTrigger: { trigger: ".cyl", start: "top top", end: "+=220%", pin: true, scrub: 0.8, anticipatePin: 1, invalidateOnRefresh: true },
    });
    return () => {
      gsap.set([ringEl, ...items], { clearProps: "all" });
    };
  });
}

// ---------------------------------------------------------------- demo board


function setupDemoBoard() {
  const el = document.querySelector("[data-demo-board]");
  const cg = Chessground(el, { viewOnly: true, coordinates: false, animation: { duration: 400 } });
  const clockEls = { white: document.querySelector('[data-demo-clock="white"]'), black: document.querySelector('[data-demo-clock="black"]') };
  let chess = new Chess();
  let ply = 0;
  let timer = null;
  const clocks = { white: 600, black: 600 };
  const fmt = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  function paintClocks(turn) {
    for (const side of ["white", "black"]) {
      clockEls[side].textContent = fmt(clocks[side]);
      clockEls[side].classList.toggle("active", side === turn);
    }
  }

  function step() {
    if (ply >= OPERA.length) {
      timer = setTimeout(restart, 4000);
      return;
    }
    const mover = chess.turn() === "w" ? "white" : "black";
    const m = chess.move(OPERA[ply++]);
    clocks[mover] = Math.max(0, clocks[mover] - 4 - Math.floor(Math.random() * 18) + 5);
    cg.set({ fen: chess.fen(), lastMove: [m.from, m.to], check: chess.isCheck() ? (chess.turn() === "w" ? "white" : "black") : false });
    paintClocks(chess.turn() === "w" ? "white" : "black");
    timer = setTimeout(step, reduced ? 2200 : 1100);
  }

  function restart() {
    chess = new Chess();
    ply = 0;
    clocks.white = clocks.black = 600;
    cg.set({ fen: chess.fen(), lastMove: undefined, check: false });
    paintClocks("white");
    timer = setTimeout(step, 1200);
  }

  paintClocks("white");
  // Only play while it's on screen.
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !timer) timer = setTimeout(step, 600);
    if (!entry.isIntersecting && timer) {
      clearTimeout(timer);
      timer = null;
    }
  }, { threshold: 0.35 }).observe(el);
  window.addEventListener("resize", () => cg.redrawAll());
  return cg;
}

// ---------------------------------------------------------------- roles deck

function deck() {
  const mm = gsap.matchMedia();
  mm.add("(min-width: 1024px)", () => stackDeck(22));
  // Phones and tablets: the same stack, a little tighter.
  mm.add("(max-width: 1023px)", () => stackDeck(14));
}

// Cards stacked like a deck; scrolling flips them away one by one.
// `gap` is how far each card below peeks out.
function stackDeck(gap) {
  const cards = gsap.utils.toArray(".deck__card");
  const items = gsap.utils.toArray(".deck__list li");
  cards.forEach((c, i) => gsap.set(c, { zIndex: cards.length - i, y: i * gap, scale: 1 - i * 0.05, rotateX: 6, transformPerspective: 1000, transformOrigin: "50% 0%" }));
  const tl = gsap.timeline({
    scrollTrigger: {
      trigger: ".deck",
      start: "top top",
      end: `+=${cards.length * 55}%`,
      pin: true,
      scrub: 0.6,
      anticipatePin: 1,
      onUpdate: (self) => {
        const active = Math.min(cards.length - 1, Math.floor(self.progress * cards.length));
        items.forEach((li, i) => li.classList.toggle("is-active", i === active));
      },
    },
  });
  cards.slice(0, -1).forEach((c, i) => {
    tl.to(c, { yPercent: -125, rotateX: 22, autoAlpha: 0, duration: 1, ease: "power2.in" }, i).to(
      cards.slice(i + 1),
      { y: (j) => j * gap, scale: (j) => 1 - j * 0.05, duration: 1, ease: "power2.out" },
      i,
    );
  });
  tl.to({}, { duration: 0.6 });
  return () => gsap.set(cards, { clearProps: "all" });
}

// ---------------------------------------------------------------- cta, footer

function ctaAndFooter() {
  if (!lite) gsap.fromTo("[data-cta-img]", { scale: 1.2, yPercent: 6 }, { scale: 1, yPercent: -4, ease: "none", scrollTrigger: { trigger: ".cta", start: "top bottom", end: "bottom top", scrub: true } });

  const word = document.querySelector("[data-footer-word]");
  word.innerHTML = [...word.textContent].map((ch) => `<span>${ch}</span>`).join("");
  gsap.from(word.children, { yPercent: 70, autoAlpha: 0, stagger: 0.06, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: word, start: "top 98%", once: true } });
}
