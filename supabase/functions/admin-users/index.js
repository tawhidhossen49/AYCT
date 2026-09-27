// Account management for tournament admins. Creating a sign-in needs the
// service role key, which must never reach the browser, so it lives here.
//
// POST { action: "create", email, password, full_name, role, rating?, school? }
// POST { action: "update", id, email?, password?, full_name?, role?, rating?, school? }
// POST { action: "delete", id }

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["admin", "moderator", "commentator", "player"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Not signed in" }, 401);

  const { data: caller } = await admin.from("profiles").select("role").eq("id", userData.user.id).single();
  if (caller?.role !== "admin") return json({ error: "Only tournament admins can manage accounts" }, 403);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const role = str(body.role);
  if (role && !ROLES.includes(role)) return json({ error: "Unknown role" }, 400);
  const rating = body.rating === undefined || body.rating === "" ? undefined : Number(body.rating);
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 0 || rating > 3500)) {
    return json({ error: "Rating must be a whole number between 0 and 3500" }, 400);
  }

  // Everyone's sign-in email, for the admin's People tab. Emails are not
  // readable by other members.
  if (body.action === "list") {
    const { data, error } = await admin.from("profiles").select("id, email");
    if (error) return json({ error: error.message }, 400);
    return json({ people: data });
  }

  if (body.action === "create") {
    const email = str(body.email).toLowerCase();
    const password = str(body.password);
    const full_name = str(body.full_name);
    if (!email || !full_name) return json({ error: "Name and email are required" }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);

    const { data: created, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name },
    });
    if (error) return json({ error: error.message }, 400);

    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .insert({
        id: created.user.id,
        email,
        full_name,
        role: role || "player",
        rating: rating ?? 1000,
        school: str(body.school) || null,
      })
      .select("*")
      .single();
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id);
      return json({ error: profileError.message }, 400);
    }
    return json({ profile });
  }

  if (body.action === "update") {
    const id = str(body.id);
    if (!id) return json({ error: "Missing id" }, 400);
    if (id === userData.user.id && role && role !== "admin") {
      return json({ error: "You can't remove your own admin role" }, 400);
    }

    const authPatch = {};
    const email = str(body.email).toLowerCase();
    const password = str(body.password);
    if (email) authPatch.email = email;
    if (password) {
      if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
      authPatch.password = password;
    }
    if (Object.keys(authPatch).length) {
      const { error } = await admin.auth.admin.updateUserById(id, { ...authPatch, email_confirm: true });
      if (error) return json({ error: error.message }, 400);
    }

    const patch = {};
    if (email) patch.email = email;
    if (str(body.full_name)) patch.full_name = str(body.full_name);
    if (role) patch.role = role;
    if (rating !== undefined) patch.rating = rating;
    if (body.school !== undefined) patch.school = str(body.school) || null;

    const { data: profile, error } = await admin.from("profiles").update(patch).eq("id", id).select("*").single();
    if (error) return json({ error: error.message }, 400);
    return json({ profile });
  }

  if (body.action === "delete") {
    const id = str(body.id);
    if (!id) return json({ error: "Missing id" }, 400);
    if (id === userData.user.id) return json({ error: "You can't delete your own account" }, 400);
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) return json({ error: error.message }, 400);
    return json({ ok: true });
  }

  return json({ error: "Unknown action" }, 400);
});
