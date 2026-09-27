// Shared motion: smooth scroll, reveals, counters, nav behaviour, cursor.
// GSAP, ScrollTrigger, SplitText and Lenis come from CDN <script> tags as
// globals. Everything degrades to static content under reduced motion or
// if a library didn't load.

const { gsap, ScrollTrigger, SplitText, Lenis } = window;

export const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
export const hasGsap = Boolean(gsap && ScrollTrigger);
if (hasGsap) gsap.registerPlugin(ScrollTrigger, ...(SplitText ? [SplitText] : []));

let lenis = null;

// Buttery scrolling for long pages. Anchor links glide instead of jumping.
export function initSmoothScroll() {
  if (!hasGsap || reduced || !Lenis) return null;
  // Dialogs and inner scrolling lists keep their own native scrolling.
  lenis = new Lenis({
    lerp: 0.09,
    smoothWheel: true,
    prevent: (node) => Boolean(node.closest?.("dialog, .moves, .comments, .pick-list, .modal-body, [data-lenis-prevent]")),
  });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    const id = a?.getAttribute("href");
    if (!id || id.length < 2) return;
    const target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    lenis.resize();
    lenis.scrollTo(target, { offset: -20, duration: 1.4 });
  });
  return lenis;
}
export const getLenis = () => lenis;

// Headings marked data-split rise line by line from behind a mask.
// data-split="load" plays straight away; otherwise it waits to be scrolled into view.
export function splitLines(root = document) {
  if (!hasGsap || reduced || !SplitText) return;
  document.fonts.ready.then(() => {
    root.querySelectorAll("[data-split]:not([data-split-done])").forEach((el) => {
      el.dataset.splitDone = "1";
      const split = SplitText.create(el, { type: "lines", mask: "lines", linesClass: "split-line" });
      const now = el.dataset.split === "load";
      gsap.from(split.lines, {
        yPercent: 115,
        duration: 1.2,
        ease: "expo.out",
        stagger: 0.09,
        delay: parseFloat(el.dataset.delay || 0),
        scrollTrigger: now ? undefined : { trigger: el, start: "top 88%", once: true },
      });
    });
  });
}

// data-reveal: rise and fade in. data-stagger: children in sequence.
export function reveals(root = document) {
  if (!hasGsap || reduced) return;
  root.querySelectorAll("[data-reveal]:not([data-reveal-done])").forEach((el) => {
    el.dataset.revealDone = "1";
    gsap.from(el, {
      y: 48,
      autoAlpha: 0,
      filter: "blur(8px)",
      duration: 1.2,
      ease: "power3.out",
      delay: parseFloat(el.dataset.delay || 0),
      clearProps: "filter",
      scrollTrigger: el.dataset.reveal === "load" ? undefined : { trigger: el, start: "top 88%", once: true },
    });
  });
  root.querySelectorAll("[data-stagger]:not([data-stagger-done])").forEach((group) => {
    group.dataset.staggerDone = "1";
    gsap.from(group.children, {
      y: 40,
      autoAlpha: 0,
      duration: 1,
      ease: "power3.out",
      stagger: 0.07,
      scrollTrigger: group.dataset.stagger === "load" ? undefined : { trigger: group, start: "top 85%", once: true },
    });
  });
}

// data-count="32": counts up from 0 when it scrolls into view.
export function counters(root = document) {
  root.querySelectorAll("[data-count]:not([data-count-done])").forEach((el) => {
    el.dataset.countDone = "1";
    const target = parseFloat(el.dataset.count);
    if (!hasGsap || reduced) {
      el.textContent = target;
      return;
    }
    const state = { v: 0 };
    el.textContent = "0";
    gsap.to(state, {
      v: target,
      duration: 2,
      ease: "power2.out",
      onUpdate: () => (el.textContent = Math.round(state.v)),
      scrollTrigger: { trigger: el, start: "top 90%", once: true },
    });
  });
}

// The floating nav slides away on scroll down and returns on scroll up.
export function navAutoHide(nav = document.querySelector(".topbar")) {
  if (!nav) return;
  let last = window.scrollY;
  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY;
      nav.classList.toggle("is-hidden", y > last && y > 240);
      last = y;
    },
    { passive: true },
  );
}

// Round widget in the corner: fills with page progress, click goes to top.
export function progressRing() {
  const el = document.createElement("button");
  el.className = "progress-ring";
  el.setAttribute("aria-label", "Back to top");
  const r = 24;
  const c = 2 * Math.PI * r;
  el.innerHTML = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle class="track" cx="26" cy="26" r="${r}"/><circle class="bar" cx="26" cy="26" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c}"/></svg><i class="ph ph-arrow-up"></i>`;
  document.body.append(el);
  const bar = el.querySelector(".bar");
  const update = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? scrollY / max : 0;
    bar.style.strokeDashoffset = String(c * (1 - p));
  };
  window.addEventListener("scroll", update, { passive: true });
  update();
  el.addEventListener("click", () => (lenis ? lenis.scrollTo(0, { duration: 1.6 }) : scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" })));
}

// A small dot that trails the pointer and grows over links (desktop only).
export function cursorDot() {
  if (!hasGsap || reduced || matchMedia("(hover: none), (pointer: coarse)").matches) return;
  const dot = document.createElement("div");
  dot.className = "cursor-dot";
  dot.setAttribute("aria-hidden", "true");
  document.body.append(dot);
  const x = gsap.quickTo(dot, "x", { duration: 0.35, ease: "power3" });
  const y = gsap.quickTo(dot, "y", { duration: 0.35, ease: "power3" });
  window.addEventListener("pointermove", (e) => {
    x(e.clientX);
    y(e.clientY);
  });
  document.addEventListener("pointerover", (e) => dot.classList.toggle("is-big", Boolean(e.target.closest("a, button, summary, [data-cursor]"))));
}

// Buttons drift slightly toward the pointer.
export function magnetic(root = document) {
  if (!hasGsap || reduced || matchMedia("(hover: none)").matches) return;
  root.querySelectorAll("[data-magnetic]").forEach((btn) => {
    btn.addEventListener("pointermove", (e) => {
      const r = btn.getBoundingClientRect();
      gsap.to(btn, { x: (e.clientX - r.left - r.width / 2) * 0.25, y: (e.clientY - r.top - r.height / 2) * 0.3, duration: 0.4, ease: "power3.out" });
    });
    btn.addEventListener("pointerleave", () => gsap.to(btn, { x: 0, y: 0, duration: 0.7, ease: "elastic.out(1, 0.4)" }));
  });
}

// Everything a page needs after its markup is in place.
export function animateIn(root = document) {
  splitLines(root);
  reveals(root);
  counters(root);
  magnetic(root);
}

// The portal's page band: the film still settles in, then drifts slower
// than the page as you scroll (the landing page's parallax).
let heroTriggers = [];
export function heroMotion(section, { entrance = true } = {}) {
  heroTriggers.forEach((t) => t.kill());
  heroTriggers = [];
  if (!hasGsap || reduced || !section) return;
  const img = section.querySelector(".p-hero__media img");
  const inner = section.querySelector(".p-hero__inner");
  if (entrance) gsap.fromTo(img, { scale: 1.2, autoAlpha: 0 }, { scale: 1.08, autoAlpha: 1, duration: 2.2, ease: "expo.out" });
  heroTriggers.push(
    gsap.to(img, { yPercent: 14, ease: "none", scrollTrigger: { trigger: section, start: "top top", end: "bottom top", scrub: true } }).scrollTrigger,
    gsap.to(inner, { y: -60, autoAlpha: 0.2, ease: "none", scrollTrigger: { trigger: section, start: "40% top", end: "bottom top", scrub: true } }).scrollTrigger,
  );
}

// The giant wordmark's letters rise in as the footer arrives.
export function footerMotion(footer) {
  if (!hasGsap || reduced || !footer) return;
  const letters = footer.querySelectorAll(".footer__word span");
  gsap.from(letters, { yPercent: 70, autoAlpha: 0, stagger: 0.06, duration: 1.2, ease: "expo.out", scrollTrigger: { trigger: footer, start: "top 85%", once: true } });
}

// Keeps a ticker band gliding; scrolling speeds it up for a moment.
export function tickerMotion(root = document) {
  if (!hasGsap || reduced) return;
  root.querySelectorAll(".ticker__track:not([data-ticking])").forEach((track) => {
    track.dataset.ticking = "1";
    const loop = gsap.to(track, { xPercent: -50, duration: 40, ease: "none", repeat: -1 });
    ScrollTrigger.create({
      onUpdate: (self) => {
        gsap.to(loop, { timeScale: 1 + Math.min(Math.abs(self.getVelocity()) / 600, 5), duration: 0.2, overwrite: true });
        gsap.to(loop, { timeScale: 1, duration: 1.2, delay: 0.25, overwrite: false });
      },
    });
  });
}
