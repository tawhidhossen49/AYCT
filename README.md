# Amaze Youth Chess Tournament portal

The portal for the annual Amaze Youth Chess Tournament. Players, moderators,
commentators and admins sign in with an email and password. Staff run the
whole event from the admin panel, and players see their groups, fixtures,
countdowns and the bracket, and play their games on the site.

Plain HTML, CSS and JavaScript. No build step, nothing to install.
`index.html` is the public landing page; the portal starts at `login.html`.

## Opening it

Open the folder in VS Code, right-click `index.html` and choose
**Open with Live Server**. That's it.

Any static host works the same way (Vercel, Netlify, GitHub Pages): upload
the folder as it is.

## Format

- 32 players in 8 groups of 4 (A to H), dealt by a random draw (or placed
  by hand).
- Each group plays a round robin over 3 rounds (6 games per group, 48 in all).
- The top 2 of each group reach a single-game knockout:
  round of 16, quarterfinals, semifinals, final. Group winners play white
  against a runner-up from the neighbouring group (A1 v B2, B1 v A2, ...).
- The semifinal losers play a third-place match, so there are 64 games in
  all: 48 in the groups and 16 in the knockout.
- Group tables: win 1, draw ½. Ties go to Sonneborn-Berger, then wins,
  then head-to-head, then the order of the draw.
- A drawn knockout game needs a tiebreak winner, which a moderator records.

## Roles

| Role        | Can do |
|-------------|--------|
| Admin       | Everything, including creating, editing and deleting accounts |
| Moderator   | Editions, group draw, fixtures, schedules, results, bracket, the organising team room |
| Commentator | Watch every board and post live commentary beside a game |
| Player      | See groups, fixtures and the bracket, and play their own games |

There is no sign-up on the site. Players register in a Google Form, and admins create every account under Control Room, People.

## Files

```
index.html          Public landing page (hero, format, road to the crown, groups, live board, roles, FAQ)
login.html          Sign in
home.html           Dashboard. Players: next game, updates, record, form, group, results.
                    Staff: organiser overview, and any player's dashboard (home.html?player=...)
play.html           The Arena: play, watch, arbitrate and review games (play.html?id=...);
                    without an id, the Arena lobby (your board, live games, finished games)
fixtures.html       Every game, filterable by round
groups.html         The eight group tables
bracket.html        Round of 16 to the final, with the third-place match
match.html          Old game links; forwards to play.html
admin.html          Control Room (#live, #team, #tournament, #registrations, #people, #groups, #matches, #knockout, #activity)

assets/css/styles.css       Design system and portal styling
assets/css/landing.css      Landing page sections
assets/css/arena.css        The Arena
assets/css/icons.css        The icons the site uses (made by tools/build_icons.py)
assets/fonts/               Icon fonts, trimmed to those icons
assets/brand/               Logo and chess piece images from the poster
assets/js/config.js         Supabase project URL and public key
assets/js/supabase.js       Supabase connection
assets/js/auth.js           Sign in, sign out, page guard
assets/js/store.js          Loads the tournament and keeps it live
assets/js/ops.js            Staff actions: draw, fixtures, scheduling, bracket
assets/js/standings.js      Group tables and tiebreaks
assets/js/time.js           Server-synced clock, countdowns
assets/js/registration.js   The Google Forms behind "Register now"
assets/js/board.js          Chessboard (chessground) and rules (chess.js)
assets/js/ui.js             Header, match rows, group tables, dialogs
assets/js/page.js           What every page does first
assets/js/motion.js         Smooth scroll, reveals, counters, nav, cursor (GSAP + Lenis)
assets/js/sequence.js       Scroll-scrubbed video engine for the hero (used once a clip is added)
assets/js/notify.js         Updates feed: the bell, toasts, the dashboard feed
assets/js/arena/sounds.js   Move, capture, check and clock sounds (Web Audio, no files)
assets/js/arena/engine.js   Stockfish game review (after the game only)
assets/js/pages/*.js        One script per page

supabase/migrations/        Database tables, security rules, automation and bracket logic
supabase/functions/game/        Checks every move, runs the clocks, ends games
supabase/functions/admin-users/ Creates and manages sign-ins and test bots (admins only)
supabase/functions/register/    Retired: the old on-site registration endpoint, now switched off
```

Libraries (Supabase, chess.js, chessground, GSAP, Lenis, fonts, icons) load from CDNs,
so the site needs an internet connection, which it needs for Supabase anyway.

Moves never go straight to the database. The `game` function checks that
it's your turn, that the move is legal, and that your clock hasn't run out,
then saves the new position. It follows the FIDE Online Chess Regulations:

- Checkmate, stalemate, threefold repetition, the fifty-move rule and
  insufficient material end the game automatically.
- A flag fall loses, unless the opponent can't possibly mate (then a draw).
- A game starts at its scheduled time with White's clock running, and a
  disconnection doesn't stop the clock, so a no-show loses on time.
- A draw offer stands until it is accepted, declined, or the opponent moves.
- Premoves are allowed; up to 0.5 s of network lag per move is forgiven.
- Arbiters (admins and moderators) can pause, add time, take back a move,
  adjudicate and message players, from the Arena's Arbiter tab.

## What runs by itself

- Timeouts and no-shows are ended by the server every 20 seconds (pg_cron),
  even if nobody has the game open.
- Players get updates (bell, toast, dashboard) when a game is scheduled or
  moved, 10 minutes before it starts, when it ends, when they advance, and
  when the arbiter messages them.
- A drawn knockout game gets an Armageddon game, colours reversed: White 5
  minutes, Black 4, +2 seconds, Black goes through on a draw.
- When the last group game ends, the round of 16 is drawn from the tables.
- Winners move into the next round and the semifinal losers into the
  third-place match; the final's winner completes the event.

The two switches (Armageddon, bracket after groups), the Armageddon delay and
the earliest move for draw offers are in Control Room, Tournament, Autopilot.

Fair play: the two players can't see commentary until their game ends, the
engine review only opens after the game, and leaving the game tab during play
is logged for the arbiter (Control Room, Live and Activity).

## Registration

People register in Google Forms, not on the site. There are four forms:
player registration, Campus Ambassador (CA), club or organisation
partnership, and joining the organising team.

- "Register now" on the main page asks what the visitor wants to register
  for, then opens that form in a new tab.
- Control Room, Registrations (admins only): paste each form's link and
  save. A form with no link is shown as "Coming soon" in the chooser.
- With no links at all, the main page buttons say "Registration coming
  soon" and go nowhere.
- Answers stay in Google Forms. Once a player is confirmed, an admin
  creates their account in Control Room, People and sends them their
  sign-in.
- Members who are already signed in see "Open the portal" instead.

## Organising team

Control Room, Organising team is where admins and moderators run the event
together. Players and commentators can't see it.

- On duty: everyone on the team, with a green dot for those who have the
  Control Room open and which tab they are on.
- Task board: To do, In progress, Done. Each task has an owner and a due
  time; overdue tasks are marked. "Add the standard checklist" fills in
  the usual jobs for one edition. Whoever is given a task gets an update.
- Team chat: staff-only messages, live. Pin the ones everyone should see.
- Arbiters: put a team member on each game, or "Share out evenly". The
  arbiter gets an update and their name shows on the game's Live card.

Friendly matches (Control Room, Matches, Friendlies, New match) are extra
games between any two people, outside the groups and the bracket, with
their own clock.

## Security

- The database decides who may read or change what (row level security on
  every table). The key in `assets/js/config.js` is the public "anon" key and
  is safe to ship; the service key only lives inside the server functions.
- Every move, clock, draw offer and result goes through the `game` function,
  which checks the player, the turn, legality and the clock. It refuses
  requests in bursts (429), one draw offer per player per position, and two
  arbiter actions can't overwrite each other.
- Players can't read commentary on their own game until it ends, and can't
  write to the fair-play log faster than 20 entries a minute.
- Updates only ever link inside the portal; anything typed by people is
  escaped before it is shown.
- Every page carries a Content Security Policy: scripts only from this site
  and the pinned CDN files (with integrity hashes), data only to this
  Supabase project. `_headers` (Netlify, Cloudflare Pages) and `vercel.json`
  add the same policy as real headers, plus no framing and HSTS.
- In the Supabase dashboard keep "Allow new users to sign up" switched off
  (Authentication, Sign In / Providers): admins create every account.

## Running a tournament

1. Control Room, Tournament: create the edition (year, time control).
2. Control Room, People: add the 32 players, moderators and commentators.
3. Control Room, Groups: run the random draw, or place players by hand.
4. Control Room, Matches: generate the group fixtures, then set a start time per round.
5. Games are played on the site. Staff can also enter results for games
   played over the board, or correct them.
6. The bracket builds itself when the last group game ends (or Control
   Room, Knockout: generate it by hand). Schedule each knockout round.
7. During games, watch everything from Control Room, Live.

## Setting up a fresh Supabase project

Only needed if you move to a new project.

1. In the SQL editor, run the files in `supabase/migrations/` in order.
2. Deploy the two functions in `supabase/functions/` (Dashboard, Edge
   Functions, or `npx supabase functions deploy game` and `admin-users`).
3. Authentication, Sign In / Providers: switch off "Allow new users to sign up".
4. Create your admin: Authentication, Users, Add user (tick Auto Confirm),
   then in the SQL editor:
   ```sql
   insert into public.profiles (id, full_name, email, role)
   select id, 'Your Name', email, 'admin' from auth.users where email = 'you@example.com';
   ```
5. Put the new project URL and anon key in `assets/js/config.js`.

## The hero film

The landing page hero is a scroll-driven film: the video, split into 180
WebP frames in `assets/sequences/hero/`, plays forward as visitors scroll
down and rewinds smoothly to the first frame as they scroll back up. Text appears in the empty parts of the frame:
the title above the distant king, "Think." on the left, "Play." on the
right, and "Become / Legendary." either side of the king at the end.

To replace the film with a new clip:

1. Put the new video in `Raw-Video/`.
2. Run the 3d-site skill's script (it overwrites the old frames):
   `python <skill-folder>/scripts/extract_frames.py "Raw-Video/<file>.mp4" --name hero --out assets/sequences --frames 180`
3. Refresh the page. If the new clip's composition differs, the text timing
   lives in `hero()` in `assets/js/pages/landing.js`.

`Raw-Video/` is the source only; the website uses `assets/sequences/hero/`.

Upright phones use a third set of frames, `assets/sequences/hero/portrait/`:
the middle of every second frame, cut to 9:16 at the size it is shown. After
replacing the film, make that set again from the new `desktop/` frames (crop
the centre to 9:16, resize to 405x720), or remove the `portrait` entry from
`manifest.json` and phones fall back to the `mobile/` set.

## Icons

Icons are Phosphor 2.1.2. Only the icons the site uses are shipped, as three
small fonts in `assets/fonts/` and `assets/css/icons.css`. After using an icon
the site hasn't used before, rebuild them, or it shows as an empty space:

    pip install fonttools brotli
    python tools/build_icons.py

Design notes live in `BLUEPRINT.md` and `REDESIGN_PLAN.md`.
