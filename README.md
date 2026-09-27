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

- 32 players in 8 groups of 4 (A to H), drawn World Cup style: four pots
  by rating, one player from each pot per group.
- Each group plays a round robin over 3 rounds (6 games per group, 48 in all).
- The top 2 of each group reach a single-game knockout:
  round of 16, quarterfinals, semifinals, final. Group winners play white
  against a runner-up from the neighbouring group (A1 v B2, B1 v A2, ...).
- Group tables: win 1, draw ½. Ties go to Sonneborn-Berger, then wins,
  then head-to-head, then rating.
- A drawn knockout game needs a tiebreak winner, which a moderator records.
- Every finished game updates both players' Elo ratings (K = 32). Resetting
  or correcting a result reverses the change.

## Roles

| Role        | Can do |
|-------------|--------|
| Admin       | Everything, including creating, editing and deleting accounts |
| Moderator   | Editions, group draw, fixtures, schedules, results, bracket |
| Commentator | Watch every board and post live commentary beside a game |
| Player      | See groups, fixtures, bracket and leaderboard, and play their own games |

There is no public sign-up. Admins create every account under Admin, People.

## Files

```
index.html          Public landing page (hero, format, road to the crown, groups, live board, roles, FAQ)
login.html          Sign in
home.html           Home: next game and countdown, setup checklist, live boards
fixtures.html       Every game, filterable by round
groups.html         The eight group tables
bracket.html        Round of 16 to the final
leaderboard.html    Players by rating
match.html          The board (match.html?id=...)
admin.html          Admin panel (#tournament, #people, #groups, #matches, #knockout)

assets/css/styles.css       Design system and portal styling
assets/css/landing.css      Landing page sections
assets/brand/               Logo and chess piece images from the poster
assets/js/config.js         Supabase project URL and public key
assets/js/supabase.js       Supabase connection
assets/js/auth.js           Sign in, sign out, page guard
assets/js/store.js          Loads the tournament and keeps it live
assets/js/ops.js            Staff actions: draw, fixtures, scheduling, bracket
assets/js/standings.js      Group tables and tiebreaks
assets/js/time.js           Server-synced clock, countdowns
assets/js/board.js          Chessboard (chessground) and rules (chess.js)
assets/js/ui.js             Header, match rows, group tables, dialogs
assets/js/page.js           What every page does first
assets/js/motion.js         Smooth scroll, reveals, counters, nav, cursor (GSAP + Lenis)
assets/js/sequence.js       Scroll-scrubbed video engine for the hero (used once a clip is added)
assets/js/pages/*.js        One script per page

supabase/migrations/        Database tables, security rules, rating and bracket logic
supabase/functions/game/        Checks every move, runs the clocks, ends games
supabase/functions/admin-users/ Creates and manages sign-ins (admins only)
```

Libraries (Supabase, chess.js, chessground, GSAP, Lenis, fonts, icons) load from CDNs,
so the site needs an internet connection, which it needs for Supabase anyway.

Moves never go straight to the database. The `game` function checks that
it's your turn, that the move is legal, and that your clock hasn't run out,
then saves the new position. A game starts at its scheduled time with
white's clock running, so a player who doesn't show up loses on time.

## Running a tournament

1. Admin, Tournament: create the edition (year, time control).
2. Admin, People: add the 32 players (with ratings), moderators and commentators.
3. Admin, Groups: run the seeded draw, or place players by hand.
4. Admin, Matches: generate the group fixtures, then set a start time per round.
5. Games are played on the site. Staff can also enter results for games
   played over the board, or correct them.
6. Admin, Knockout: when the group stage is done, generate the bracket.
   Winners move forward on their own; schedule each knockout round.

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

Design notes live in `BLUEPRINT.md` and `REDESIGN_PLAN.md`.

## Pending server updates (from the bug-fix pass)

Two database migrations and two function updates are written but not yet
applied, because the Supabase connection was unavailable:

1. SQL editor: run `supabase/migrations/0003_reverse_ratings_on_delete.sql`.
2. Redeploy `supabase/functions/game` and `supabase/functions/admin-users`
   (Dashboard, Edge Functions, open each function, paste the new `index.js`, Deploy;
   or `npx supabase functions deploy game` and `admin-users`).
3. Then SQL editor: run `supabase/migrations/0004_private_emails.sql`.
