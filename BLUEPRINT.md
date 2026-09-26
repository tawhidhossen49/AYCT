# Site blueprint

**Concept.** A black-and-chrome stage where 32 young players enter and one leaves as champion. The page tells that story as you scroll: the field narrows 32 → 16 → 8 → 4 → 2 → 1 while the chrome pieces from the poster drift through the dark.

**Signature moment.** "The Road to the Crown": a pinned chapter where a giant number counts down 32 → 16 → 8 → 4 → 2 → 1 as the stage cards slide past, ending on a spotlit trophy.

## Public landing (`index.html`)

| # | Section | Purpose | Component | Motion | Clip? |
|---|---|---|---|---|---|
| 0 | Preloader | Brand moment while fonts load | Percentage ring around the logo | ring fills, iris opens into the hero | no |
| 1 | Nav | Always there | Floating glass pill: logo, Format, Road, Groups, Play, FAQ, **Sign in** | hides on scroll down, returns on scroll up | no |
| 2 | Hero | First impression | Oversized type + chrome cutouts (2d): "AMAZE YOUTH CHESS / TOURNAMENT 2026", rook right, pawn left, ghost word "CHECKMATE" | pinned 160vh: pieces parallax, captions change "Think." → "Play." → "Become legendary." | **slot ready** (video later) |
| 3 | Ticker | Rhythm break | Infinite band: 32 players · 8 groups · 63 games · one champion | speeds up with scroll | no |
| 4 | Manifesto | Why it matters | Word-by-word scroll highlight | words light up as you scroll | no |
| 5 | Numbers | Format at a glance | Glass stat cards: 32 / 8 / 63 / 10+5 | counters roll up | no |
| 6 | Road to the Crown | **Signature** | Pinned horizontal rail: Group stage, Round of 16, Quarterfinals, Semifinals, Final, with the giant 32 → 1 counter | scrubbed horizontal travel | no |
| 7 | Eight groups | Show the group stage | Curved cylinder carousel of glass cards A–H ("4 players, top 2 advance") | cylinder rotates with scroll | no |
| 8 | Play live | The portal's killer feature | Split: a real chessboard replaying a famous game (Morphy, Paris 1858) + feature list: server-checked moves, chess clocks, draw offers, live commentary | board autoplays when in view | no |
| 9 | Who it's for | Roles | Stacked perspective card deck: Players, Moderators, Commentators, Admins | cards fly off as you scroll | no |
| 10 | Ratings | Leaderboard idea | Chrome Elo line: "Every game moves your rating" with a sample +16 / -16 | counter + line draw | no |
| 11 | FAQ | Answers | Glass accordion (who can join, how sign-in works, what if I miss my game, how draws are decided) | smooth expand | no |
| 12 | Final CTA | Convert | Full-bleed rook with "Your move." + Sign in | image scales 1.12 → 1 | no |
| 13 | Footer | Close | Giant "AMAZE" wordmark clipped at the bottom, links, tagline | letters rise in | no |

Persistent: scroll-progress ring (bottom right), cursor dot that grows over links (desktop only), everything off under reduced motion.

## Portal pages (after sign-in)

Same tokens, nav and motion language: line-mask page titles over a ghost outline word, glass panels, chrome countdowns, a spotlight behind every board, staggered reveals. Layouts and features stay as they are.

- **login.html:** full-bleed rook, glass sign-in card, preloader iris.
- **home.html:** cinematic greeting, glass next-game card with a big chrome countdown, spotlit live boards.
- **fixtures / groups / bracket / leaderboard:** restyled as in REDESIGN_PLAN.md.
- **match.html:** board under a radial spotlight, glass clocks that pulse red under 30 seconds.
- **admin.html:** same tools, glass restyle.

## Stack

Plain HTML/CSS/JS (Live Server) + GSAP 3 (ScrollTrigger, SplitText) + Lenis from CDN. No build step.
