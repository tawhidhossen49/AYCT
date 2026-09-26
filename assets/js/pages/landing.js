// Public landing page: preloader, pinned hero, the road to the crown, the
// ring of groups, a live demo board, the roles deck, and the footer.

import { supabase } from "../supabase.js";
import { currentProfile } from "../auth.js";
import { reduced, hasGsap, initSmoothScroll, animateIn, navAutoHide, progressRing, cursorDot } from "../motion.js";
import { Chessground, Chess } from "../board.js";
import { loadManifest, createSequence } from "../sequence.js";

const { gsap, ScrollTrigger, SplitText } = window;
const motion = hasGsap && !reduced;
const desktop = () => window.matchMedia("(min-width: 900px)").matches;

// ---------------------------------------------------------------- data

// The current edition's year is public.
supabase
  .from("tournaments")
  .select("year")
  .order("is_active", { ascending: false })
  .order("year", { ascending: false })
  .limit(1)
  .maybeSingle()
  .then(({ data }) => {
    if (data?.year) document.querySelectorAll("[data-year]").forEach((el) => (el.textContent = data.year));
  });

// Signed-in visitors go straight to their portal.
currentProfile().then((p) => {
  if (!p) return;
  document.querySelectorAll("[data-portal-link]").forEach((a) => {
    a.href = "home.html";
    if (a.classList.contains("nav-cta")) a.innerHTML = `Open portal <i class="ph-bold ph-arrow-up-right"></i>`;
  });
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

if (!motion) {
  document.querySelector(".preloader")?.remove();
  // Without motion the three captions become one line.
  const caps = document.querySelectorAll(".hl__cap");
  caps[0].textContent = "Think. Play. Become legendary.";
  caps[1].remove();
  caps[2].remove();
  animateIn();
} else {
  await preloader();
  heroIntro();
  heroScroll();
  ticker();
  manifesto();
  road();
  ring();
  deck();
  ratingLine();
  ctaAndFooter();
  animateIn();
  document.fonts.ready.then(() => ScrollTrigger.refresh());
}

// ---------------------------------------------------------------- preloader

function preloader() {
  return new Promise((resolve) => {
    const el = document.querySelector(".preloader");
    const bar = el.querySelector(".bar");
    const count = el.querySelector(".preloader__count");
    const length = 389.6;
    const images = ["assets/brand/rook.webp", "assets/brand/pawn.webp", "assets/brand/logo.png"];
    const jobs = [document.fonts.ready, ...images.map((src) => new Promise((r) => { const i = new Image(); i.onload = i.onerror = r; i.src = src; }))];
    const shown = { p: 0 };
    let done = 0;
    let released = false;

    const setTo = (p) =>
      gsap.to(shown, {
        p,
        duration: 0.5,
        ease: "power2.out",
        overwrite: true,
        onUpdate: () => {
          bar.style.strokeDashoffset = String(length * (1 - shown.p));
          count.textContent = Math.round(shown.p * 100);
        },
      });

    const release = () => {
      if (released) return;
      released = true;
      setTo(1).then(() =>
        gsap.to(el, {
          clipPath: "circle(0% at 50% 50%)",
          duration: 1.1,
          ease: "expo.inOut",
          onComplete: () => {
            el.remove();
            resolve();
          },
        }),
      );
    };

    jobs.forEach((j) => j.then(() => setTo(++done / (jobs.length + 1))));
    // Never hold visitors longer than 3 seconds; always show the brand for at least 0.9.
    Promise.all([Promise.all(jobs), new Promise((r) => setTimeout(r, 900))]).then(release);
    setTimeout(release, 3000);
  });
}

// ---------------------------------------------------------------- hero

function heroIntro() {
  const tl = gsap.timeline({ defaults: { ease: "expo.out" } });
  tl.from(".hl__rook", { xPercent: 18, autoAlpha: 0, filter: "blur(20px)", duration: 1.8, clearProps: "filter" }, 0)
    .from(".hl__pawn", { xPercent: -18, autoAlpha: 0, filter: "blur(20px)", duration: 1.8, clearProps: "filter" }, 0.1)
    .from(".hl__ghost", { autoAlpha: 0, duration: 2 }, 0.2)
    .from("[data-hero-line]", { yPercent: 60, autoAlpha: 0, filter: "blur(12px)", duration: 1.3, stagger: 0.12, clearProps: "filter" }, 0.25)
    .from(".hl__cap:first-child", { y: 20, autoAlpha: 0, duration: 1 }, 0.55)
    .from("[data-hero-in]", { y: 24, autoAlpha: 0, duration: 1.1, stagger: 0.1 }, 0.45)
    .from(".hl__meta", { autoAlpha: 0, duration: 1 }, 0.9);
}

async function heroScroll() {
  const stage = document.querySelector(".hl__stage");
  const caps = gsap.utils.toArray(".hl__cap");
  const tl = gsap.timeline({
    scrollTrigger: { trigger: ".hl", start: "top top", end: "+=130%", pin: stage, scrub: 0.6, anticipatePin: 1 },
  });
  tl.to(".hl__rook", { yPercent: -14, scale: 1.08, ease: "none", duration: 1 }, 0)
    .to(".hl__pawn", { yPercent: 12, rotate: -5, ease: "none", duration: 1 }, 0)
    .to(".hl__ghost", { xPercent: -22, ease: "none", duration: 1 }, 0)
    .to(".hl__glow", { scale: 1.3, autoAlpha: 0.6, ease: "none", duration: 1 }, 0)
    .to(".hl__title", { scale: 0.94, ease: "none", duration: 1 }, 0);

  // "Think." then "Play." then "Become legendary."
  const windows = [[0, 0.3], [0.36, 0.64], [0.7, 1]];
  caps.forEach((cap, i) => {
    const [a, b] = windows[i];
    if (i > 0) tl.fromTo(cap, { autoAlpha: 0, y: 24, filter: "blur(8px)" }, { autoAlpha: 1, y: 0, filter: "blur(0px)", duration: 0.08 }, a);
    if (b < 1) tl.to(cap, { autoAlpha: 0, y: -20, filter: "blur(6px)", duration: 0.08 }, b - 0.08);
  });

  // Video slot: once a clip has been extracted, it scrubs with the hero.
  const canvas = document.querySelector(".hl__seq");
  const base = canvas?.dataset.sequence;
  if (base) {
    const manifest = await loadManifest(`${base}manifest.json`);
    if (manifest) {
      const seq = createSequence({ canvas, manifest, baseUrl: base });
      seq.addTo(tl);
      canvas.classList.add("is-ready");
      gsap.set([".hl__rook", ".hl__pawn"], { autoAlpha: 0 });
    }
  }
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
  mm.add("(max-width: 899px)", () => {
    cards.forEach((card) =>
      ScrollTrigger.create({ trigger: card, start: "top 60%", end: "bottom 60%", onToggle: (s) => s.isActive && setCount(card.dataset.left) }),
    );
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
}

// ---------------------------------------------------------------- demo board

// Morphy vs Duke Karl of Brunswick & Count Isouard, Paris 1858.
const OPERA = "e4 e5 Nf3 d6 d4 Bg4 dxe5 Bxf3 Qxf3 dxe5 Bc4 Nf6 Qb3 Qe7 Nc3 c6 Bg5 b5 Nxb5 cxb5 Bxb5+ Nbd7 O-O-O Rd8 Rxd7 Rxd7 Rd1 Qe6 Bxd7+ Nxd7 Qb8+ Nxb8 Rd8#".split(" ");

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
  mm.add("(min-width: 1024px)", () => {
    const cards = gsap.utils.toArray(".deck__card");
    const items = gsap.utils.toArray(".deck__list li");
    cards.forEach((c, i) => gsap.set(c, { zIndex: cards.length - i, y: i * 22, scale: 1 - i * 0.05, rotateX: 6, transformPerspective: 1000, transformOrigin: "50% 0%" }));
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
        { y: (j) => j * 22, scale: (j) => 1 - j * 0.05, duration: 1, ease: "power2.out" },
        i,
      );
    });
    tl.to({}, { duration: 0.6 });
    return () => gsap.set(cards, { clearProps: "all" });
  });
}

// ---------------------------------------------------------------- ratings, cta, footer

function ratingLine() {
  const path = document.querySelector("[data-draw]");
  const len = path.getTotalLength();
  gsap.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, {
    strokeDashoffset: 0,
    duration: 2.2,
    ease: "power2.inOut",
    scrollTrigger: { trigger: path, start: "top 85%", once: true },
  });
  gsap.from(".rchart .area", { autoAlpha: 0, duration: 1.4, delay: 0.8, scrollTrigger: { trigger: path, start: "top 85%", once: true } });
}

function ctaAndFooter() {
  gsap.fromTo("[data-cta-img]", { scale: 1.2, yPercent: 6 }, { scale: 1, yPercent: -4, ease: "none", scrollTrigger: { trigger: ".cta", start: "top bottom", end: "bottom top", scrub: true } });

  const word = document.querySelector("[data-footer-word]");
  word.innerHTML = [...word.textContent].map((ch) => `<span>${ch}</span>`).join("");
  gsap.from(word.children, { yPercent: 70, autoAlpha: 0, stagger: 0.06, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: word, start: "top 98%", once: true } });
}
