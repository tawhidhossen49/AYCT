// Countdowns and chess clocks must agree across devices, so everything is
// measured against the database clock, not the viewer's own.

import { supabase } from "./supabase.js";

let offsetMs = 0;

export async function syncServerClock() {
  const t0 = Date.now();
  const { data, error } = await supabase.rpc("server_now");
  const t1 = Date.now();
  if (!error && data) offsetMs = new Date(data).getTime() - (t0 + t1) / 2;
}

export const serverNow = () => Date.now() + offsetMs;

export function splitDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

const pad = (n) => String(n).padStart(2, "0");

// Chess clock format: m:ss, or h:mm:ss for long games. Tenths under 10s.
export function formatClock(ms) {
  const c = Math.max(0, ms);
  if (c < 10_000) return `0:${pad(Math.floor(c / 1000))}.${Math.floor((c % 1000) / 100)}`;
  const { hours, minutes, seconds } = splitDuration(c);
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export const formatDate = (iso) => dateFmt.format(new Date(iso));
export const formatTime = (iso) => timeFmt.format(new Date(iso));
export const formatDateTime = (iso) => `${formatDate(iso)}, ${formatTime(iso)}`;

// Short label for list rows: "in 2h 14m", "in 3d 4h".
export function relative(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - serverNow();
  if (ms <= 0) return null;
  const { days, hours, minutes } = splitDuration(ms);
  if (days) return `in ${days}d ${hours}h`;
  if (hours) return `in ${hours}h ${minutes}m`;
  return `in ${Math.max(1, minutes)}m`;
}

// <input type="datetime-local"> works in local time without a zone.
export function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const fromLocalInput = (value) => (value ? new Date(value).toISOString() : null);

// ---------------------------------------------------------------- countdowns
// Any element with data-countdown="<iso>" is kept up to date, once a second.

export function countdownHtml(iso, { big = false, doneLabel = "Starting now" } = {}) {
  return `<div class="countdown${big ? " big" : ""}" role="timer" data-countdown="${iso}" data-done="${doneLabel}">${countdownInner(iso, doneLabel)}</div>`;
}

function countdownInner(iso, doneLabel) {
  const ms = new Date(iso).getTime() - serverNow();
  if (ms <= 0) return `<p class="strong">${doneLabel}</p>`;
  const { days, hours, minutes, seconds } = splitDuration(ms);
  const unit = (v, l) => `<div class="unit"><span class="value chrome-text">${pad(v)}</span><span class="label">${l}</span></div>`;
  return (days ? unit(days, "Days") : "") + unit(hours, "Hrs") + unit(minutes, "Min") + unit(seconds, "Sec");
}

let ticking = false;
export function startCountdowns() {
  if (ticking) return;
  ticking = true;
  setInterval(() => {
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      el.innerHTML = countdownInner(el.dataset.countdown, el.dataset.done);
    });
  }, 1000);
}
