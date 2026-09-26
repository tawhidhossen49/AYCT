# Redesign plan (/3d-site)

## Audit

- **Stack:** plain HTML + CSS + JavaScript modules, opened with Live Server. Supabase for sign-in, data and realtime; two edge functions (`game`, `admin-users`). Libraries from CDN.
- **Pages:** `index.html` (sign in), `home.html`, `fixtures.html`, `groups.html`, `bracket.html`, `leaderboard.html`, `match.html?id=`, `admin.html#tab`.
- **Logic to protect (not touched):** `assets/js/auth.js`, `supabase.js`, `store.js`, `ops.js`, `standings.js`, `time.js`, `board.js`, the edge functions and the database. Form field ids, the move/clock flow and every admin action keep working exactly as now.
- **Brand constraints:** the poster: black, chrome chess pieces, globe-and-knight logo, wide geometric caps, "Think. Play. Become legendary."
- **Assets:** logo (PNG), chrome rook and pawn crops from the poster (on black, so they read as cutouts on a dark page).

## Direction

- **Archetype:** Bold Performance (near-black, extended caps, glass panels, spotlights, counters), borrowing one Editorial Fashion piece: the giant footer wordmark with line-mask text reveals.
- **Palette:** void `#07070A`, graphite `#0E0F13`, glass `rgb(255 255 255 / .05)` with 1px `/.10` edges, chrome text `#E9EBEF`, muted `#8C909A`. Accent: **chrome silver gradient** (the poster's metal). One signal colour, live red `#FF4D4D`, only for LIVE and errors.
- **Type:** Archivo Expanded 800 (display, matches the poster), Manrope (body), JetBrains Mono (clocks, ratings, counters).
- **Radius:** 20px panels, 12px controls, pill buttons.
- **Motion:** Lenis smooth scroll + GSAP ScrollTrigger + SplitText. `expo.out` 0.9–1.2s, 0.06–0.08s staggers, headings reveal by line masks, images scale 1.12 → 1.
- **Hero mode:** B (no video) now, built so a scroll-scrubbed clip can drop in later without code changes (placeholder canvas, per the skill).

## Section mapping

| # | Existing (file) | New component | Motion | Content kept | Clip? |
|---|---|---|---|---|---|
| 1 | Sign in (`index.html`) | Moves to `login.html`: glass card over the full-bleed rook | preloader iris, line-mask title | same form, ids, messages | no |
| 2 | (none) | **New public landing page** `index.html` (see BLUEPRINT.md) | full scroll story | poster copy, real format | slot ready |
| 3 | Top bar + tab bar (`ui.js`) | Floating glass nav pill, hides on scroll down; phone tab bar restyled | blur-in, magnetic sign-out | same links and roles | no |
| 4 | Home (`home.js`) | Cinematic greeting with ghost word, glass hero card + big chrome countdown, spotlight live boards | line reveals, counter roll | all of it | no |
| 5 | Fixtures (`fixtures.js`) | Day timeline with glass rows, pill filters | stagger in | all | no |
| 6 | Groups (`groups.js`) | Glass group tables with giant ghost letter A–H behind each | stagger, rank badges | all | no |
| 7 | Bracket (`bracket.js`) | Bracket on a dark stage with glowing connectors, trophy spotlight on the final | connectors draw in | all | no |
| 8 | Leaderboard (`leaderboard.js`) | Podium with chrome #1, counters | ratings count up | all | no |
| 9 | Match (`match.js`) | Board under a radial spotlight, glass clocks, glass side panels | clock pulse when low | all | no |
| 10 | Admin (`admin.js`) | Same tools, restyled: glass panels, pill tabs | subtle only | all | no |

## Files

- **Change:** every `.html`, `assets/css/styles.css`, `assets/js/ui.js` (markup only), page scripts' markup, new `assets/js/motion.js`, new `assets/js/pages/landing.js`.
- **Don't touch:** auth/data/logic modules listed above, `supabase/`.
- **URL change:** sign-in moves from `index.html` to `login.html` so `index.html` can be the public landing page. Signed-out redirects point to `login.html`.

## Risks

- The landing page is public, and database rules only let visitors see the tournament's name and year. So the landing shows the format and story, not player names (they're minors; keeping them behind sign-in is deliberate).
- GSAP, Lenis and fonts load from CDNs; an internet connection is required (already true for Supabase).
