import { supabase } from "../supabase.js";
import { currentProfile, signIn } from "../auth.js";
import { animateIn, cursorDot, hasGsap, reduced } from "../motion.js";

// Where to go after signing in: back to the page that sent us here, if any.
const next = new URLSearchParams(location.search).get("next");
// Only a page of this site, never another address.
const destination = next && /^[a-z]+\.html([?#][A-Za-z0-9=&#._~%-]*)?$/.test(next) ? next : "home.html";

// Already signed in? Skip straight in.
if (await currentProfile()) location.replace(destination);

// The edition's year is public, so it can show before sign-in.
supabase
  .from("tournaments")
  .select("year")
  .order("is_active", { ascending: false })
  .order("year", { ascending: false })
  .limit(1)
  .maybeSingle()
  .then(({ data }) => {
    if (data) document.getElementById("year").textContent = data.year;
  });

// Entrance: the card rises in, the rook drifts in from the right.
animateIn();
cursorDot();
if (hasGsap && !reduced) {
  window.gsap.from("[data-login-art]", { xPercent: 12, autoAlpha: 0, filter: "blur(16px)", duration: 1.8, ease: "expo.out", clearProps: "filter" });
}

const form = document.getElementById("loginForm");
const errorEl = document.getElementById("formError");
const button = document.getElementById("submit");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) {
    errorEl.textContent = "Enter your email and password.";
    return;
  }
  button.classList.add("loading");
  button.disabled = true;
  try {
    await signIn(email, password);
    location.href = destination;
  } catch (err) {
    errorEl.textContent = err.message;
    if (hasGsap && !reduced) window.gsap.fromTo(".login-card", { x: -8 }, { x: 0, duration: 0.6, ease: "elastic.out(1, 0.3)" });
    button.classList.remove("loading");
    button.disabled = false;
  }
});
