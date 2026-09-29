// Registration for the active edition. The questions come from the edition's
// form (tournaments.registration), which admins edit in the Control Room.
// The `register` edge function checks every answer and creates the
// applicant's sign-in; they can enter the portal once an admin accepts them.

import { supabase } from "../supabase.js";
import { currentProfile } from "../auth.js";
import { esc, icon } from "../ui.js";
import { animateIn, cursorDot, hasGsap, reduced } from "../motion.js";

const body = document.getElementById("body");
let startedAt = Date.now();

animateIn();
cursorDot();
if (hasGsap && !reduced) {
  window.gsap.from("[data-login-art]", { xPercent: 12, autoAlpha: 0, filter: "blur(16px)", duration: 1.8, ease: "expo.out", clearProps: "filter" });
}

const [{ data: t }, profile] = await Promise.all([
  supabase.from("tournaments").select("name, year, registration").eq("is_active", true).maybeSingle(),
  currentProfile(),
]);
if (t?.year) document.getElementById("year").textContent = t.year;

if (profile) {
  body.innerHTML = message("check-circle", "You're already in", `You're signed in as ${esc(profile.full_name)}.`, `<a class="btn btn-primary" href="home.html">Open the portal ${icon("arrow-right", "bold")}</a>`);
} else {
  const form = t?.registration;
  const state = !form ? "soon" : form.status === "open" && form.closes_at && Date.now() > Date.parse(form.closes_at) ? "closed" : form.status;
  if (state === "open") drawForm(form);
  else if (state === "closed") body.innerHTML = message("lock-simple", "Registration has closed", "Thanks for your interest. Follow the tournament on the main page.", `<a class="btn" href="index.html">Back to the tournament</a>`);
  else body.innerHTML = message("hourglass", "Registration opens soon", "The organisers haven't opened registration yet. Please check back later.", `<a class="btn" href="index.html">Back to the tournament</a>`);
}

function message(glyph, title, text, action) {
  return `<div class="register-msg">
    <i class="ph-bold ph-${glyph}" aria-hidden="true"></i>
    <h2>${esc(title)}</h2>
    <p class="muted">${text}</p>
    <div class="mt-6">${action}</div>
  </div>`;
}

// ---------------------------------------------------------------- the form

function fieldHtml(f) {
  const id = `f-${f.key}`;
  const req = f.required ? " required" : "";
  const star = f.required ? "" : ` <span class="optional">(optional)</span>`;
  const help = f.help ? `<p class="hint">${esc(f.help)}</p>` : "";
  const err = `<p class="field-error" data-err="${f.key}"></p>`;
  if (f.type === "checkbox") {
    return `<label class="check-field" for="${id}"><input type="checkbox" id="${id}" name="${f.key}"${req}><span>${esc(f.label)}${star}${help}</span></label>${err}`;
  }
  let input;
  switch (f.type) {
    case "textarea":
      input = `<textarea class="input" id="${id}" name="${f.key}" rows="3" maxlength="2000"${req}></textarea>`;
      break;
    case "choice":
      input = `<select class="input" id="${id}" name="${f.key}"${req}><option value="">Choose</option>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
      break;
    case "password":
      input = `<input class="input" type="password" id="${id}" name="${f.key}" minlength="8" autocomplete="new-password"${req}>`;
      break;
    default: {
      const type = { email: "email", tel: "tel", number: "number", date: "date" }[f.type] ?? "text";
      const auto = { full_name: "name", email: "email", phone: "tel", school: "organization" }[f.key] ?? "off";
      input = `<input class="input" type="${type}" id="${id}" name="${f.key}" autocomplete="${auto}" maxlength="200"${req}${type === "number" ? ' min="0" max="4000"' : ""}>`;
    }
  }
  const main = `<div class="field"><label for="${id}">${esc(f.label)}${star}</label>${input}${help}${err}</div>`;
  if (f.type !== "password") return main;
  // Passwords are typed twice, so a typo can't lock anyone out.
  return `${main}<div class="field"><label for="f-password-again">Password again</label><input class="input" type="password" id="f-password-again" autocomplete="new-password" required><p class="hint">At least 8 characters. You'll sign in with this email and password once you're accepted.</p><p class="field-error" data-err="password_again"></p></div>`;
}

function drawForm(form) {
  body.innerHTML = `
    <p class="muted">${esc(form.intro ?? "")}</p>
    ${form.closes_at ? `<p class="small dim mt-2">${icon("calendar-blank")} Closes ${new Date(form.closes_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>` : ""}
    <form id="regForm" class="login-form" novalidate>
      ${(form.fields ?? []).map(fieldHtml).join("")}
      <div class="trap" aria-hidden="true"><label for="website">Website</label><input id="website" name="website" tabindex="-1" autocomplete="off"></div>
      <p class="field-error" id="formError" role="alert"></p>
      <button class="btn btn-primary btn-lg btn-block" type="submit" id="submit">Register ${icon("arrow-right", "bold")}</button>
    </form>`;
  startedAt = Date.now();
  document.getElementById("regForm").addEventListener("submit", (e) => submit(e, form));
}

function showErrors(fields) {
  document.querySelectorAll("[data-err]").forEach((el) => (el.textContent = fields?.[el.dataset.err] ?? ""));
  const first = Object.keys(fields ?? {})[0];
  if (first) document.getElementById(first === "password_again" ? "f-password-again" : `f-${first}`)?.focus();
}

async function submit(e, form) {
  e.preventDefault();
  const el = e.currentTarget;
  const errorEl = document.getElementById("formError");
  const button = document.getElementById("submit");
  errorEl.textContent = "";

  const values = {};
  const problems = {};
  for (const f of form.fields ?? []) {
    const input = el.elements[f.key];
    values[f.key] = f.type === "checkbox" ? input.checked : input.value;
    const v = typeof values[f.key] === "string" ? values[f.key].trim() : values[f.key];
    if (f.required && !v) problems[f.key] = f.type === "checkbox" ? "Please tick this box." : `${f.label} is required.`;
    else if (v && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) problems[f.key] = "Enter a valid email address.";
    else if (v && f.type === "password" && values[f.key].length < 8) problems[f.key] = "Use at least 8 characters.";
  }
  const again = document.getElementById("f-password-again");
  if (again && values.password && again.value !== values.password) problems.password_again = "The passwords don't match.";
  if (Object.keys(problems).length) {
    showErrors(problems);
    errorEl.textContent = "Please check the highlighted answers.";
    return;
  }
  showErrors({});

  button.classList.add("loading");
  button.disabled = true;
  const { error } = await supabase.functions.invoke("register", {
    body: { values, elapsed_ms: Date.now() - startedAt, website: el.elements.website.value },
  });
  if (error) {
    let reply = null;
    try {
      reply = await error.context.json();
    } catch {
      /* no details */
    }
    showErrors(reply?.fields);
    errorEl.textContent = reply?.error ?? "We couldn't send your registration. Check your connection and try again.";
    button.classList.remove("loading");
    button.disabled = false;
    return;
  }

  body.innerHTML = message(
    "check-circle",
    "Registration received",
    `Thank you, ${esc(values.full_name.trim().split(" ")[0])}. The organisers will review your entry. Once you're accepted you can sign in with <strong>${esc(values.email.trim())}</strong> and the password you chose.`,
    `<a class="btn" href="index.html">Back to the tournament</a>`,
  );
  window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
}
