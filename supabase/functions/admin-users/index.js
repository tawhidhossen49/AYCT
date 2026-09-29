// Account management for tournament admins. Creating a sign-in needs the
// service role key, which must never reach the browser, so it lives here.
//
// POST { action: "create", email, password, full_name, role, rating?, school? }
// POST { action: "update", id, email?, password?, full_name?, role?, rating?, school? }
// POST { action: "delete", id }
// POST { action: "fill_bots", tournament_id }   test bots in every empty group slot
// POST { action: "remove_bots" }                 every bot and every game they played
// POST { action: "accept_registration", id, role, rating? }   applicant becomes a portal member
// POST { action: "reject_registration", id }
// POST { action: "delete_registration", id }

import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["admin", "moderator", "commentator", "player"];

// Test bots are named after world champions, so they're easy to spot.
const BOT_NAMES = [
  "Steinitz", "Lasker", "Capablanca", "Alekhine", "Euwe", "Botvinnik", "Smyslov", "Tal",
  "Petrosian", "Spassky", "Fischer", "Karpov", "Kasparov", "Kramnik", "Anand", "Carlsen",
  "Topalov", "Ponomariov", "Khalifman", "Kasimdzhanov", "Ding", "Gukesh", "Menchik", "Polgar",
  "Hou", "Chiburdanidze", "Gaprindashvili", "Xie", "Ju", "Yifan", "Morphy", "Philidor",
];

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

  // Test bots fill every empty group slot of an edition. Each slot's pot
  // decides the bot's rating, so the seeding still makes sense.
  if (body.action === "fill_bots") {
    const tournamentId = str(body.tournament_id);
    const { data: groups } = await admin.from("groups").select("id, label").eq("tournament_id", tournamentId).order("label");
    if (!groups?.length) return json({ error: "This edition has no groups" }, 400);
    const { data: placed } = await admin.from("group_players").select("group_id, seed").eq("tournament_id", tournamentId);
    const taken = new Set((placed ?? []).map((p) => `${p.group_id}:${p.seed}`));
    const slots = [];
    for (const g of groups) for (const seed of [1, 2, 3, 4]) if (!taken.has(`${g.id}:${seed}`)) slots.push({ group: g, seed });
    if (!slots.length) return json({ error: "Every group slot is already filled" }, 400);

    const base = { 1: 1750, 2: 1450, 3: 1150, 4: 850 };
    const tag = crypto.randomUUID().slice(0, 6);
    const made = [];
    const makeBot = async ({ group, seed }, i) => {
      const email = `bot-${tag}-${i + 1}@bots.ayct.test`;
      const full_name = `Bot ${BOT_NAMES[i % BOT_NAMES.length]}`;
      const { data: created, error } = await admin.auth.admin.createUser({
        email,
        password: crypto.randomUUID(),
        email_confirm: true,
        user_metadata: { full_name, bot: true },
      });
      if (error) throw new Error(error.message);
      const rating = base[seed] + Math.floor(Math.random() * 200);
      const { error: pErr } = await admin.from("profiles").insert({ id: created.user.id, email, full_name, role: "player", rating, school: "Test bot", is_bot: true });
      if (pErr) throw new Error(pErr.message);
      made.push({ tournament_id: tournamentId, group_id: group.id, player_id: created.user.id, seed });
    };
    try {
      for (let i = 0; i < slots.length; i += 8) await Promise.all(slots.slice(i, i + 8).map((s, j) => makeBot(s, i + j)));
      const { error } = await admin.from("group_players").insert(made);
      if (error) throw new Error(error.message);
    } catch (err) {
      return json({ error: `Bots partly created: ${err.message}. Use "Remove test bots" and try again.` }, 500);
    }
    return json({ added: made.length });
  }

  // Removes every bot and every game a bot played in, plus any knockout
  // bracket built while bots were in it. Deleting a game undoes its rating
  // change (migration 0003), so real players' ratings return to normal.
  if (body.action === "remove_bots") {
    const { data: bots } = await admin.from("profiles").select("id").eq("is_bot", true);
    const ids = (bots ?? []).map((b) => b.id);
    if (!ids.length) return json({ removed: 0, games: 0 });
    const list = `(${ids.join(",")})`;

    const { data: games } = await admin.from("matches").select("id, tournament_id").or(`white_id.in.${list},black_id.in.${list}`);
    const { data: seats } = await admin.from("group_players").select("tournament_id").in("player_id", ids);
    const editions = [...new Set([...(games ?? []), ...(seats ?? [])].map((r) => r.tournament_id))];
    const { data: bracket } = editions.length
      ? await admin.from("matches").select("id").in("tournament_id", editions).in("stage", ["r16", "qf", "sf", "final"])
      : { data: [] };
    const gameIds = [...new Set([...(games ?? []), ...(bracket ?? [])].map((g) => g.id))];

    for (let i = 0; i < gameIds.length; i += 100) {
      const chunk = gameIds.slice(i, i + 100);
      // Updates about those games would point at nothing.
      await admin.from("notifications").delete().in("link", chunk.map((id) => `play.html?id=${id}`));
      const { error } = await admin.from("matches").delete().in("id", chunk);
      if (error) return json({ error: error.message }, 500);
    }
    for (let i = 0; i < ids.length; i += 8) await Promise.all(ids.slice(i, i + 8).map((id) => admin.auth.admin.deleteUser(id)));

    // Each edition goes back to the stage its remaining group games allow
    // (friendly matches don't count towards the tournament's stage).
    for (const t of editions) {
      const { count } = await admin.from("matches").select("id", { count: "exact", head: true }).eq("tournament_id", t).eq("stage", "group");
      await admin.from("tournaments").update({ status: count ? "groups" : "setup" }).eq("id", t);
    }
    return json({ removed: ids.length, games: gameIds.length });
  }

  // Registrations (register.html). The applicant's sign-in already exists
  // with the password they chose; accepting gives it a portal profile, so
  // the admin only picks a role.
  if (["accept_registration", "reject_registration", "delete_registration"].includes(body.action)) {
    const { data: reg } = await admin.from("registrations").select("*").eq("id", str(body.id)).maybeSingle();
    if (!reg) return json({ error: "Registration not found" }, 404);
    const reviewed = { reviewed_at: new Date().toISOString(), reviewed_by: userData.user.id };

    if (body.action === "accept_registration") {
      if (reg.status === "accepted") return json({ error: `${reg.full_name} is already in the portal` }, 409);
      if (!reg.user_id) return json({ error: "This registration was rejected, so its sign-in was removed. Ask them to register again." }, 409);
      const answered = Number(reg.answers?.rating);
      const playerRating = rating ?? (Number.isInteger(answered) && answered > 0 && answered <= 3500 ? answered : 1000);
      const { data: profile, error } = await admin
        .from("profiles")
        .insert({
          id: reg.user_id,
          email: reg.email,
          full_name: reg.full_name,
          role: role || "player",
          rating: (role || "player") === "player" ? playerRating : 1000,
          school: reg.school,
        })
        .select("*")
        .single();
      if (error) return json({ error: /duplicate/i.test(error.message) ? `${reg.full_name} already has a portal account` : error.message }, 400);
      await admin.from("registrations").update({ status: "accepted", role: role || "player", ...reviewed }).eq("id", reg.id);
      await admin.from("notifications").insert({
        user_id: reg.user_id,
        kind: "message",
        title: "Welcome to the tournament",
        body: "Your registration has been accepted. Your group and games will appear here.",
        link: "home.html",
      });
      return json({ profile });
    }

    // Rejecting or deleting an entry that was never accepted also removes its
    // sign-in, so the same email can register again later.
    const { data: hasProfile } = reg.user_id
      ? await admin.from("profiles").select("id").eq("id", reg.user_id).maybeSingle()
      : { data: null };
    if (reg.user_id && !hasProfile) await admin.auth.admin.deleteUser(reg.user_id);

    if (body.action === "reject_registration") {
      if (reg.status === "accepted") return json({ error: "Accepted players are removed from People, not here" }, 409);
      await admin.from("registrations").update({ status: "rejected", user_id: null, ...reviewed }).eq("id", reg.id);
      return json({ ok: true });
    }
    await admin.from("registrations").delete().eq("id", reg.id);
    return json({ ok: true });
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
