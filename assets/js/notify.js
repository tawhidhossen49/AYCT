// The updates feed: game times, results, advancement, Armageddon tiebreaks
// and arbiter messages. The database writes these (see migration 0005);
// the bell in the top bar shows them live, with a toast for new ones.

import { supabase } from "./supabase.js";
import { esc, icon } from "./ui.js";
import { play } from "./arena/sounds.js";

export const feed = { items: [], unread: 0, userId: null };
const listeners = new Set();
const emit = () => listeners.forEach((fn) => fn(feed));

export const KIND_ICON = {
  scheduled: "calendar-blank",
  reminder: "alarm",
  result: "flag-checkered",
  advanced: "arrow-fat-lines-up",
  tiebreak: "lightning",
  draw: "shuffle",
  message: "megaphone",
  registration: "user-plus",
};

export function onFeed(fn) {
  listeners.add(fn);
  fn(feed);
  return () => listeners.delete(fn);
}

// Loads someone's updates. Staff may load anyone's (to see a player's
// dashboard as they see it); only your own feed stays live.
export async function loadFeed(userId, { limit = 40 } = {}) {
  const { data } = await supabase
    .from("notifications")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

let started = false;
export async function startFeed(userId) {
  if (started) return;
  started = true;
  feed.userId = userId;
  feed.items = await loadFeed(userId);
  feed.unread = feed.items.filter((n) => !n.read_at).length;
  emit();
  supabase
    .channel(`feed-${userId}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (p) => {
      if (feed.items.some((n) => n.id === p.new.id)) return;
      feed.items.unshift(p.new);
      feed.unread += 1;
      emit();
      toast(p.new);
      play("notify");
    })
    .subscribe();
}

export async function markAllRead() {
  const ids = feed.items.filter((n) => !n.read_at).map((n) => n.id);
  if (!ids.length) return;
  const now = new Date().toISOString();
  feed.items.forEach((n) => (n.read_at ??= now));
  feed.unread = 0;
  emit();
  await supabase.from("notifications").update({ read_at: now }).in("id", ids);
}

export function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Updates only ever link inside the portal ("play.html?id=..."), never to
// another site or a javascript: address.
export function safeLink(link) {
  return typeof link === "string" && /^[a-z]+\.html([?#][A-Za-z0-9=&#._~%-]*)?$/.test(link) ? link : null;
}

export function feedItemHtml(n) {
  const inner = `<span class="feed-icon">${icon(KIND_ICON[n.kind] ?? "bell", "bold")}</span>
    <span class="grow"><span class="feed-title">${esc(n.title)}</span>${n.body ? `<span class="feed-body">${esc(n.body)}</span>` : ""}<span class="feed-time">${timeAgo(n.created_at)}</span></span>
    ${n.read_at ? "" : `<span class="feed-dot" aria-label="Unread"></span>`}`;
  const link = safeLink(n.link);
  return link ? `<a class="feed-item" href="${esc(link)}">${inner}</a>` : `<div class="feed-item">${inner}</div>`;
}

// ---------------------------------------------------------------- toasts

function stack() {
  let el = document.querySelector(".toast-stack");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast-stack";
    el.setAttribute("aria-live", "polite");
    document.body.append(el);
  }
  return el;
}

export function toast(n, { timeout = 7000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = feedItemHtml({ ...n, read_at: n.read_at ?? "x" });
  stack().append(el);
  requestAnimationFrame(() => el.classList.add("in"));
  setTimeout(() => {
    el.classList.remove("in");
    setTimeout(() => el.remove(), 400);
  }, timeout);
}

// ---------------------------------------------------------------- bell

export function mountBell(container) {
  const wrap = document.createElement("div");
  wrap.className = "bell";
  wrap.innerHTML = `<button class="icon-btn bell-btn" aria-label="Updates" aria-expanded="false">${icon("bell", "bold")}<span class="bell-count" hidden></span></button>
    <div class="bell-panel" hidden>
      <div class="bell-head"><span class="eyebrow">Updates</span><button class="btn btn-ghost btn-sm" data-read>Mark all read</button></div>
      <div class="bell-list" data-lenis-prevent></div>
    </div>`;
  container.append(wrap);
  const btn = wrap.querySelector(".bell-btn");
  const panel = wrap.querySelector(".bell-panel");
  const count = wrap.querySelector(".bell-count");
  const list = wrap.querySelector(".bell-list");

  onFeed((f) => {
    count.hidden = !f.unread;
    count.textContent = f.unread > 9 ? "9+" : f.unread;
    list.innerHTML = f.items.length
      ? f.items.slice(0, 25).map(feedItemHtml).join("")
      : `<p class="small dim" style="padding:1rem">Nothing yet. Game times, results and messages from the arbiter appear here.</p>`;
  });

  const close = () => {
    panel.hidden = true;
    btn.setAttribute("aria-expanded", "false");
  };
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    btn.setAttribute("aria-expanded", String(!panel.hidden));
  });
  wrap.querySelector("[data-read]").addEventListener("click", markAllRead);
  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
}
