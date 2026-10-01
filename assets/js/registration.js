// Registration happens in a Google Form. Its link is saved on the edition
// (tournaments.registration.form_url) by an admin in the Control Room, and
// the main page's "Register now" buttons open it.

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
