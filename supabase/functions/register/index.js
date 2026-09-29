// Public registration for the active edition (register.html).
//
// POST { values: { full_name, email, password, school, phone, ... }, elapsed_ms, website }
//
// The applicant's sign-in is created straight away with the password they
// chose, but with no portal profile, so they can't enter the portal until
// an admin accepts them (admin-users, "accept_registration"). Passwords are
// never stored anywhere else. Open to anyone, so every field is checked
// here, and two light traps turn away bots: a hidden field people never
// fill in ("website"), and forms sent back faster than a person could type.

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^[+\d][\d\s()-]{5,19}$/;
// Answers that go into their own columns, or nowhere (the password).
const OWN_COLUMNS = ["full_name", "email", "password", "school", "phone"];

// One answer, cleaned and checked against its question.
function check(field, raw) {
  if (field.type === "checkbox") {
    const v = raw === true || raw === "true" || raw === "on";
    return field.required && !v ? [v, "Please tick this box."] : [v, null];
  }
  const v = raw == null ? "" : String(raw).trim();
  if (!v) return [v, field.required ? `${field.label} is required.` : null];
  const max = field.type === "textarea" ? 2000 : 200;
  if (v.length > max) return [v, `Please keep this under ${max} characters.`];
  switch (field.type) {
    case "email":
      return [v.toLowerCase(), EMAIL.test(v) ? null : "Enter a valid email address."];
    case "password":
      return [String(raw), String(raw).length >= 8 ? null : "Use at least 8 characters."];
    case "tel":
      return [v, PHONE.test(v) ? null : "Enter a valid phone number."];
    case "number":
      return [v, Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 4000 ? null : "Enter a number."];
    case "date":
      return [v, /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? null : "Enter a valid date."];
    case "choice":
      return [v, (field.options ?? []).includes(v) ? null : "Pick one of the options."];
    default:
      return [v, null];
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request" }, 400);
  }

  // Bots fill every field and submit instantly; people do neither. Bots get
  // a normal-looking answer, so they learn nothing.
  if (body.website) return json({ ok: true });
  // How long the form was open, measured by the page itself (the visitor's
  // clock and ours may disagree, so a start time wouldn't do).
  if (!Number.isFinite(Number(body.elapsed_ms)) || Number(body.elapsed_ms) < 3000) {
    return json({ error: "That was quick! Please check your answers and send the form again." }, 400);
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: t } = await admin.from("tournaments").select("id, name, registration").eq("is_active", true).maybeSingle();
  const form = t?.registration;
  if (!t || !form) return json({ error: "Registration isn't open yet." }, 409);
  if (form.status === "soon") return json({ error: "Registration opens soon. Please check back later." }, 409);
  if (form.status !== "open" || (form.closes_at && Date.now() > Date.parse(form.closes_at))) {
    return json({ error: "Registration has closed." }, 409);
  }

  const values = body.values ?? {};
  const clean = {};
  const errors = {};
  for (const field of form.fields ?? []) {
    const [v, problem] = check(field, values[field.key]);
    clean[field.key] = v;
    if (problem) errors[field.key] = problem;
  }
  if (!clean.full_name) errors.full_name ??= "Full name is required.";
  if (!clean.email) errors.email ??= "Email is required.";
  if (!clean.password) errors.password ??= "Choose a password.";
  if (Object.keys(errors).length) return json({ error: "Please check the highlighted answers.", fields: errors }, 400);

  const email = clean.email.toLowerCase();
  const { data: already } = await admin.from("registrations").select("id, status").eq("tournament_id", t.id).eq("email", email).maybeSingle();
  if (already && already.status !== "rejected") {
    return json({ error: "This email has already registered for this tournament.", fields: { email: "Already registered." } }, 409);
  }
  // A rejected applicant may try again; their old entry makes way.
  if (already) await admin.from("registrations").delete().eq("id", already.id);

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: clean.password,
    email_confirm: true,
    user_metadata: { full_name: clean.full_name, registered: true },
  });
  if (createError) {
    const taken = /already|registered|exists/i.test(createError.message);
    return json(
      taken
        ? { error: "This email already has a portal account. Sign in instead, or ask the organisers.", fields: { email: "Already has an account." } }
        : { error: "We couldn't save your registration. Please try again." },
      taken ? 409 : 500,
    );
  }

  const answers = Object.fromEntries(Object.entries(clean).filter(([k]) => !OWN_COLUMNS.includes(k)));
  const { error: saveError } = await admin.from("registrations").insert({
    tournament_id: t.id,
    user_id: created.user.id,
    full_name: clean.full_name,
    email,
    school: clean.school || null,
    phone: clean.phone || null,
    answers,
  });
  if (saveError) {
    await admin.auth.admin.deleteUser(created.user.id);
    return json({ error: "We couldn't save your registration. Please try again." }, 500);
  }

  // Admins hear about every new entry.
  const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin");
  if (admins?.length) {
    await admin.from("notifications").insert(
      admins.map((a) => ({
        user_id: a.id,
        kind: "registration",
        title: "New registration",
        body: `${clean.full_name}${clean.school ? ` (${clean.school})` : ""} registered for ${t.name}.`,
        link: "admin.html#registrations",
      })),
    );
  }

  return json({ ok: true });
});
