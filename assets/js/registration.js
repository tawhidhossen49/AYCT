// Registration happens in Google Forms. "Register now" on the main page asks
// what the visitor wants to register for, then opens that form. The links
// are saved on the edition (tournaments.registration.forms) by an admin in
// the Control Room.

// What people can register for, in the order they are shown.
export const FORM_KINDS = [
  { key: "player", label: "Player registration", blurb: "Play in the tournament: 32 players, 8 groups, one champion.", icon: "crown-simple" },
  { key: "ca", label: "Campus Ambassador (CA)", blurb: "Represent AYCT at your school, college or university.", icon: "megaphone" },
  { key: "partner", label: "Club or organisation partnership", blurb: "Partner your club or organisation with the tournament.", icon: "handshake" },
  { key: "organiser", label: "Join the organising team", blurb: "Help run AYCT as one of the organisers.", icon: "users-three" },
];

// The link if it really is a Google Form, otherwise null.
export function formLink(value) {
  try {
    const url = new URL(String(value ?? "").trim());
    const google = url.hostname === "forms.gle" || (url.hostname === "docs.google.com" && url.pathname.startsWith("/forms/"));
    return url.protocol === "https:" && google ? url.href : null;
  } catch {
    return null;
  }
}

// Each kind's link (or null) for an edition. An edition saved before there
// were four forms has one link, which was the players' form.
export function formLinks(registration) {
  const saved = registration?.forms ?? {};
  return Object.fromEntries(FORM_KINDS.map((k) => [k.key, formLink(saved[k.key] ?? (k.key === "player" ? registration?.form_url : null))]));
}
