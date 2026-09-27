// Sign in, sign out, and the guard every portal page runs first.
//
// Roles live in `profiles.role`: auth proves who someone is, the profile
// says what they may see and do.

import { supabase } from "./supabase.js";

export const ROLE_LABEL = { admin: "Admin", moderator: "Moderator", commentator: "Commentator", player: "Player" };

export const isStaff = (role) => role === "admin" || role === "moderator";

// Everything about a person that other members may see. Emails are
// private: only admins get them, through the admin-users function.
export const PROFILE_COLUMNS = "id, full_name, role, rating, school, created_at, is_bot";

async function loadProfile(userId) {
  const { data } = await supabase.from("profiles").select(PROFILE_COLUMNS).eq("id", userId).maybeSingle();
  return data ?? null;
}

export async function currentProfile() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) return null;
  return loadProfile(data.session.user.id);
}

// Returns the profile, or sends the visitor to the sign-in page.
// With { staff: true }, non-staff are sent home instead.
export async function requireAuth({ staff = false } = {}) {
  const profile = await currentProfile();
  if (!profile) {
    const back = location.pathname.split("/").pop() + location.search + location.hash;
    location.replace(`login.html?next=${encodeURIComponent(back)}`);
    return new Promise(() => {}); // the page is leaving; stop here quietly
  }
  if (staff && !isStaff(profile.role)) {
    location.replace("home.html");
    return new Promise(() => {});
  }
  return profile;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === "email_not_confirmed") throw new Error("This email hasn't been confirmed yet. Ask the tournament admin.");
    throw new Error("That email and password don't match. Check them and try again.");
  }
  const profile = await loadProfile(data.user.id);
  if (!profile) {
    await supabase.auth.signOut();
    throw new Error("Your sign-in works, but no tournament role is attached to it yet. Ask the tournament admin to add you.");
  }
  return profile;
}

export async function signOut() {
  await supabase.auth.signOut();
  location.href = "index.html";
}
