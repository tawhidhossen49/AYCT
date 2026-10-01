// Public landing page: preloader, pinned hero, the road to the crown, the
// ring of groups, a live demo board, the roles deck, and the footer.

import { formLink } from "../registration.js";
import { supabase } from "../supabase.js";
import { currentProfile } from "../auth.js";
import { reduced, hasGsap, initSmoothScroll, getLenis, animateIn, navAutoHide, progressRing, cursorDot } from "../motion.js";
import { Chessground, Chess } from "../board.js";
import { loadManifest, createSequence } from "../sequence.js";

const { gsap, ScrollTrigger, SplitText } = window;

// Morphy vs Duke Karl of Brunswick & Count Isouard, Paris 1858.
const OPERA = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");
const motion = hasGsap && !reduced;

// ---------------------------------------------------------------- data

// The current edition's year and registration form link are public.
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
});

// "Register now" opens the organisers' Google Form. Until they add its link
// the buttons say "Registration coming soon" and go nowhere. Members who are
// already in get "Open portal" instead.
Promise.all([edition, currentProfile()]).then(([data, profile]) => {
  const arrow = `<i class="ph-bold ph-arrow-right"></i>`;
  if (profile) {
    document.querySelectorAll("[data-portal-link]").forEach((a) => {
      a.href = "home.html";
      if (a.classList.contains("nav-cta")) a.innerHTML = `Open portal <i class="ph-bold ph-arrow-up-right"></i>`;
    });
    document.querySelectorAll("[data-register-link]").forEach((a) => {
      a.href = "home.html";
      a.removeAttribute("aria-disabled");
      a.innerHTML = `Open the portal ${arrow}`;
    });
    return;
  }
  const link = formLink(data?.registration?.form_url);
  document.querySelectorAll("[data-register-link]").forEach((a) => {
    if (link) {
      a.href = link;
      a.target = "_blank";
      a.rel = "noopener";
      a.removeAttribute("aria-disabled");
      a.innerHTML = `Register now ${arrow}`;
    } else {
      a.removeAttribute("href");
      a.setAttribute("aria-disabled", "true");
      a.innerHTML = "Registration coming soon";
    }
  });
  const foot = document.querySelector("[data-register-foot]");
  if (foot && link) {
    foot.hidden = false;
    foot.querySelector("a").href = link;
  }
});

// ---------------------------------------------------------------- static pieces (built for every visitor)

buildDots();
buildRing();
setupDemoBoard();

// ---------------------------------------------------------------- motion

initSmoothScroll();
navAutoHide();
progressRing();
cursorDot();

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
  tl.to(".hv__intro", { autoAlpha: 0, y: -60, filter: "blur(10px)", duration: 0.1, ease: "power2.in" }, 0.1);

  // "Think." on the left, then "Play." on the right, each in the side of the
  // frame the pieces have just left.
  const chapter = (sel, dir, inAt, outAt) => {
    const away = mobile ? { y: 30 } : { x: 70 * dir };
    const leave = mobile ? { y: -24 } : { x: -30 * dir };
    tl.fromTo(sel, { autoAlpha: 0, filter: "blur(14px)", ...away }, { autoAlpha: 1, x: 0, y: 0, filter: "blur(0px)", duration: 0.07, ease: "power3.out" }, inAt);
    tl.to(sel, { autoAlpha: 0, filter: "blur(10px)", ...leave, duration: 0.06, ease: "power2.in" }, outAt - 0.06);
  };
  chapter(".hv__chapter--left .hv__chapter-inner", -1, 0.31, 0.5);
  chapter(".hv__chapter--right .hv__chapter-inner", 1, 0.55, 0.75);

  // Finale: "Become" and "Legendary." settle either side of the king.
  const flankFrom = (dir) => (mobile ? { y: 24 } : { x: 60 * dir });
  tl.fromTo(".hv__flank--left .hv__flank-inner", { autoAlpha: 0, filter: "blur(14px)", ...flankFrom(-1) }, { autoAlpha: 1, x: 0, y: 0, filter: "blur(0px)", duration: 0.09, ease: "power3.out" }, 0.8)
    .fromTo(".hv__flank--right .hv__flank-inner", { autoAlpha: 0, filter: "blur(14px)", ...flankFrom(1) }, { autoAlpha: 1, x: 0, y: 0, filter: "blur(0px)", duration: 0.09, ease: "power3.out" }, 0.85);

  tl.fromTo(".hv__progress-fill", { scaleX: 0 }, { scaleX: 1, ease: "none", duration: 1 }, 0);

  // Hold the final frame for the last stretch of scroll, so the finale
  // always settles before the page moves on.
  tl.to({}, { duration: 0.14 });

  // Two-way playback: the film follows the scroll, forward going down and
  // back to its first frame going up. It eases toward the scroll position,
  // so fast or jerky scrolling still plays smoothly in both directions.
  const playTo = (p) => gsap.to(tl, { progress: p, duration: 0.9, ease: "power3.out", overwrite: true });

  const st = ScrollTrigger.create({
    trigger: ".hv",
    start: "top top",
    end: `+=${mobile ? 240 : 320}%`,
    pin: stage,
    anticipatePin: 1,
    onUpdate: (self) => playTo(self.progress),
  });
  // Opening mid-page (e.g. from a link): show the film where the page is.
  if (st.progress > 0) tl.progress(st.progress);
}

// Once the preloader opens: the camera settles and the opening rises in.
function heroIntro() {
  gsap.timeline({ defaults: { ease: "expo.out" } })
    .fromTo([".hv__canvas", ".hv__poster"], { scale: 1.08 }, { scale: 1, duration: 2.4 }, 0)
    .from("[data-intro]", { y: 34, autoAlpha: 0, filter: "blur(12px)", duration: 1.3, stagger: 0.1, clearProps: "filter" }, 0.2)
    .from(".hv__progress", { autoAlpha: 0, duration: 1 }, 0.9);
}

// ---------------------------------------------------------------- ticker

function ticker() {
  const track = document.querySelector(".ticker__track");
  track.innerHTML += track.innerHTML; // two copies for a seamless loop
  const loop = gsap.to(track, { xPercent: -50, duration: 40, ease: "none", repeat: -1 });
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

// ---------------------------------------------------------------- road to the crown

function buildDots() {
  document.querySelectorAll("[data-dots]").forEach((el) => {
    const total = Number(el.dataset.dots);
    const keep = Number(el.dataset.keep);
    el.innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < keep ? "" : "out"}"></i>`).join("");
    el.setAttribute("aria-label", `${keep} of ${total} players left`);
  });
}

function road() {
  const counter = document.querySelector("[data-road-count]");
  const cards = gsap.utils.toArray(".stage-card");
  const setCount = (n) => {
    if (counter.textContent === String(n)) return;
    gsap.fromTo(counter, { yPercent: 30, autoAlpha: 0.2 }, { yPercent: 0, autoAlpha: 1, duration: 0.5, ease: "expo.out" });
    counter.textContent = n;
  };

  const mm = gsap.matchMedia();
  mm.add("(min-width: 900px)", () => {
    const track = document.querySelector(".road__track");
    const distance = () => track.scrollWidth - window.innerWidth + window.innerWidth * 0.08;
    gsap.to(track, {
      x: () => -distance(),
      ease: "none",
      scrollTrigger: {
        trigger: ".road__pin",
        start: "top top",
        end: () => `+=${distance()}`,
        pin: true,
        scrub: 0.8,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const i = Math.min(cards.length - 1, Math.floor(self.progress * cards.length * 0.999));
          setCount(cards[i].dataset.left);
        },
      },
    });
    gsap.from(cards, { y: 80, autoAlpha: 0, stagger: 0.08, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".road__pin", start: "top 70%", once: true } });
  });
  // Phones and tablets: the same pinned ride, with cards sized to the screen.
  mm.add("(max-width: 899px)", () => {
    const track = document.querySelector(".road__track");
    const distance = () => track.scrollWidth - window.innerWidth + window.innerWidth * 0.06;
    gsap.to(track, {
      x: () => -distance(),
      ease: "none",
      scrollTrigger: {
        trigger: ".road__pin",
        start: "top top",
        end: () => `+=${distance() * 1.15}`,
        pin: true,
        scrub: 0.6,
        anticipatePin: 1,
        invalidateOnRefresh: true,
        onUpdate: (self) => {
          const i = Math.min(cards.length - 1, Math.floor(self.progress * cards.length * 0.999));
          setCount(cards[i].dataset.left);
        },
      },
    });
    gsap.from(cards, { y: 60, autoAlpha: 0, stagger: 0.08, duration: 1, ease: "power3.out", scrollTrigger: { trigger: ".road__pin", start: "top 70%", once: true } });
  });
}

// ---------------------------------------------------------------- ring of groups

function buildRing() {
  const ring = document.querySelector("[data-ring]");
  ring.innerHTML = "ABCDEFGH"
    .split("")
    .map(
      (l) => `<article class="cyl__card">
        <div class="row between"><span class="eyebrow">Group</span><span class="num xs dim">4 players</span></div>
        <p class="letter chrome-text">${l}</p>
        <div>
          <p>Round robin over three rounds. The top two reach the round of 16.</p>
          <div class="pots mt-3"><span>P1</span><span>P2</span><span>P3</span><span>P4</span></div>
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
  gsap.fromTo("[data-cta-img]", { scale: 1.2, yPercent: 6 }, { scale: 1, yPercent: -4, ease: "none", scrollTrigger: { trigger: ".cta", start: "top bottom", end: "bottom top", scrub: true } });

  const word = document.querySelector("[data-footer-word]");
  word.innerHTML = [...word.textContent].map((ch) => `<span>${ch}</span>`).join("");
  gsap.from(word.children, { yPercent: 70, autoAlpha: 0, stagger: 0.06, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: word, start: "top 98%", once: true } });
}
