// Every change to a live game goes through here, so moves, clocks and
// results are decided by the server rather than trusted from the browser.
// Rules follow the FIDE Online Chess Regulations.
//
// POST { action, match_id, ...args }
//   move        { from, to, promotion?, think_ms? }  side to move only
//   resign                                  either player
//   offer_draw / accept_draw / decline_draw either player
//   flag                                    anyone watching; ends the game if
//                                           the side to move is out of time
//   Arbiter (admins and moderators):
//   pause / resume
//   add_time    { color: "white"|"black", seconds }
//   takeback                                undoes the last move
//   adjudicate  { result, reason? }
//   bot_move                                a test bot plays its move (anyone watching)

import { createClient } from "npm:@supabase/supabase-js@2";
import { Chess } from "npm:chess.js@1.4.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Network lag the server forgives on each move: the player is charged the
// time they report thinking, but never less than the server saw minus this.
const MAX_LAG_MS = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Requests per person in a 10-second window. Plenty for fast play with
// premoves; a script hammering the server gets 429. Test bots are driven
// from the Control Room for many games at once, so bot moves have their
// own, larger allowance. The count lives in the database (migration 0015),
// because every request may run on a different server instance.
const WINDOW_SECONDS = 10;
const LIMITS = { bot_move: 150, other: 30 };

// A test bot's move: mate if it can, otherwise usually the most valuable
// safe-looking capture, with some randomness so games differ. Weak on
// purpose; it exists to exercise the tournament, not to beat anyone.
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
function botMove(chess) {
  const moves = chess.moves({ verbose: true });
  for (const m of moves) {
    chess.move(m);
    const mate = chess.isCheckmate();
    chess.undo();
    if (mate) return m;
  }
  const score = (m) => {
    let s = Math.random() * 2;
    if (m.captured) s += VALUE[m.captured] * 2 - VALUE[m.piece] * 0.5;
    if (m.promotion) s += 8;
    if (m.san.includes("+")) s += 0.5;
    return s;
  };
  return moves.map((m) => [score(m), m]).sort((a, b) => b[0] - a[0])[0][1];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData.user) return json({ error: "Not signed in" }, 401);
  const uid = userData.user.id;

  const { data: profile } = await admin.from("profiles").select("role").eq("id", uid).single();
  if (!profile) return json({ error: "No portal profile" }, 403);
  const isStaff = profile.role === "admin" || profile.role === "moderator";

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (!body || typeof body !== "object") return json({ error: "Invalid request" }, 400);
  const bucket = body.action === "bot_move" ? "bot_move" : "other";
  const { data: over } = await admin.rpc("rate_hit", { p_key: `game:${uid}:${bucket}`, p_window_seconds: WINDOW_SECONDS, p_max: LIMITS[bucket] });
  // If the counter itself fails, games carry on.
  if (over === true) return json({ error: "Too many requests, slow down" }, 429);
  if (typeof body.match_id !== "string" || !UUID.test(body.match_id)) return json({ error: "Match not found" }, 404);

  const { data: match, error: matchError } = await admin
    .from("matches")
    .select("*")
    .eq("id", body.match_id)
    .single();
  if (matchError || !match) return json({ error: "Match not found" }, 404);
  if (match.status === "completed") return json({ error: "This game is already over" }, 409);
  if (!match.white_id || !match.black_id) return json({ error: "Both players are not set yet" }, 409);

  const now = Date.now();
  if (!match.scheduled_at || new Date(match.scheduled_at).getTime() > now) {
    return json({ error: "This game hasn't started yet" }, 409);
  }

  const { data: tournament } = await admin
    .from("tournaments")
    .select("time_control_minutes, increment_seconds, draw_offer_min_moves")
    .eq("id", match.tournament_id)
    .single();
  const tcMs = (tournament?.time_control_minutes ?? 10) * 60_000;
  const whiteBase = match.white_base_ms ?? tcMs;
  const blackBase = match.black_base_ms ?? tcMs;
  const incMs = match.increment_ms ?? (tournament?.increment_seconds ?? 0) * 1000;

  // A scheduled game goes live at its start time. White's clock runs from
  // then, so a player who doesn't show up loses on time.
  const patch = {};
  if (match.status === "scheduled") {
    match.status = "live";
    match.white_ms = whiteBase;
    match.black_ms = blackBase;
    match.clock_started_at = match.scheduled_at;
    Object.assign(patch, {
      status: "live",
      started_at: match.scheduled_at,
      white_ms: whiteBase,
      black_ms: blackBase,
      clock_started_at: match.scheduled_at,
    });
  }

  const chess = new Chess();
  if (match.pgn) chess.loadPgn(match.pgn);
  const turn = chess.turn(); // 'w' | 'b'
  const moverKey = turn === "w" ? "white_ms" : "black_ms";
  const toMoveId = turn === "w" ? match.white_id : match.black_id;
  const paused = !!match.paused_at;
  const elapsed = paused ? 0 : now - new Date(match.clock_started_at).getTime();
  const leftForMover = match[moverKey] - elapsed;
  const isPlayer = uid === match.white_id || uid === match.black_id;
  const opponentOf = (id) => (id === match.white_id ? match.black_id : match.white_id);
  const events = [];
  const log = (kind, detail = null) => events.push({ match_id: match.id, user_id: uid, kind, detail });

  const finish = (result, reason) =>
    Object.assign(patch, {
      status: "completed",
      result,
      end_reason: reason,
      ended_at: new Date(now).toISOString(),
      draw_offer_by: null,
      paused_at: null,
    });

  // Stops the running clock at its current reading, so later changes start
  // from an exact figure.
  const settleClock = () => {
    patch[moverKey] = Math.max(0, Math.round(leftForMover));
    patch.clock_started_at = new Date(now).toISOString();
  };

  const timeoutResult = () => {
    // Out of time loses, unless the opponent can't possibly mate: a bare
    // king, or king with a single bishop or knight, is a draw.
    const opp = turn === "w" ? "b" : "w";
    const oppPieces = chess
      .board()
      .flat()
      .filter((sq) => sq && sq.color === opp && sq.type !== "k");
    const cannotMate = oppPieces.length === 0 || (oppPieces.length === 1 && ["b", "n"].includes(oppPieces[0].type));
    patch[moverKey] = 0;
    if (cannotMate) return finish("1/2-1/2", "timeout vs insufficient material");
    finish(turn === "w" ? "0-1" : "1-0", "timeout");
  };

  const staffOnly = () => (isStaff ? null : json({ error: "Only the arbiter can do that" }, 403));

  switch (body.action) {
    case "move": {
      if (uid !== toMoveId) return json({ error: "It's not your move" }, 403);
      if (paused) return json({ error: "The arbiter has paused this game" }, 409);

      // Lag compensation: charge the reported thinking time, within limits.
      let charged = elapsed;
      const think = Number(body.think_ms);
      if (Number.isFinite(think) && think >= 0) charged = Math.min(elapsed, Math.max(think, elapsed - MAX_LAG_MS));
      const left = match[moverKey] - charged;
      if (left <= 0) {
        timeoutResult();
        break;
      }

      let moved;
      try {
        moved = chess.move({ from: body.from, to: body.to, promotion: body.promotion || "q" });
      } catch {
        return json({ error: "Illegal move" }, 422);
      }
      if (!moved) return json({ error: "Illegal move" }, 422);

      const after = Math.round(left + incMs);
      Object.assign(patch, {
        fen: chess.fen(),
        pgn: chess.pgn(),
        move_count: match.move_count + 1,
        [moverKey]: after,
        [turn === "w" ? "black_ms" : "white_ms"]: turn === "w" ? match.black_ms : match.white_ms,
        clock_started_at: new Date(now).toISOString(),
        clocks: [...(match.clocks ?? []), after],
        // An offer stands until the opponent answers it; moving is a "no".
        draw_offer_by: match.draw_offer_by === uid ? uid : null,
      });

      if (chess.isCheckmate()) finish(turn === "w" ? "1-0" : "0-1", "checkmate");
      else if (chess.isStalemate()) finish("1/2-1/2", "stalemate");
      else if (chess.isInsufficientMaterial()) finish("1/2-1/2", "insufficient material");
      else if (chess.isThreefoldRepetition()) finish("1/2-1/2", "threefold repetition");
      else if (chess.isDrawByFiftyMoves()) finish("1/2-1/2", "fifty-move rule");
      break;
    }

    // A test bot's turn. Anyone watching the game may ask for it; the server
    // picks the move, so nobody can steer it.
    case "bot_move": {
      if (paused) return json({ error: "The arbiter has paused this game" }, 409);
      const { data: mover } = await admin.from("profiles").select("is_bot").eq("id", toMoveId).single();
      if (!mover?.is_bot) return json({ error: "It's not a bot's move" }, 409);
      if (leftForMover <= 0) {
        timeoutResult();
        break;
      }
      // Bots accept a draw offered to them.
      if (match.draw_offer_by && match.draw_offer_by !== toMoveId) {
        finish("1/2-1/2", "agreement");
        break;
      }
      if (!chess.moves().length) return json({ error: "No legal move" }, 409);
      chess.move(botMove(chess));
      const after = Math.round(leftForMover + incMs);
      Object.assign(patch, {
        fen: chess.fen(),
        pgn: chess.pgn(),
        move_count: match.move_count + 1,
        [moverKey]: after,
        [turn === "w" ? "black_ms" : "white_ms"]: turn === "w" ? match.black_ms : match.white_ms,
        clock_started_at: new Date(now).toISOString(),
        clocks: [...(match.clocks ?? []), after],
        draw_offer_by: null,
      });
      if (chess.isCheckmate()) finish(turn === "w" ? "1-0" : "0-1", "checkmate");
      else if (chess.isStalemate()) finish("1/2-1/2", "stalemate");
      else if (chess.isInsufficientMaterial()) finish("1/2-1/2", "insufficient material");
      else if (chess.isThreefoldRepetition()) finish("1/2-1/2", "threefold repetition");
      else if (chess.isDrawByFiftyMoves()) finish("1/2-1/2", "fifty-move rule");
      break;
    }

    case "resign": {
      if (!isPlayer) return json({ error: "Only the players can resign" }, 403);
      finish(uid === match.white_id ? "0-1" : "1-0", "resignation");
      log("resign");
      break;
    }

    case "offer_draw": {
      if (!isPlayer) return json({ error: "Only the players can offer a draw" }, 403);
      const minMoves = tournament?.draw_offer_min_moves ?? 0;
      if (Math.floor(match.move_count / 2) < minMoves) {
        return json({ error: `Draw offers are allowed after move ${minMoves}` }, 409);
      }
      if (match.draw_offer_by === opponentOf(uid)) {
        // Both want a draw: that's an agreement.
        finish("1/2-1/2", "agreement");
        log("draw_agreed");
      } else {
        if (match.draw_offer_by === uid) return json({ error: "Your draw offer is already on the table" }, 409);
        // One offer per player per position, so a declined offer can't be
        // repeated to pester the opponent until the game moves on.
        const { count } = await admin
          .from("game_events")
          .select("id", { count: "exact", head: true })
          .eq("match_id", match.id)
          .eq("user_id", uid)
          .eq("kind", "draw_offered")
          .eq("detail->>ply", String(match.move_count));
        if (count) return json({ error: "You've already offered a draw in this position" }, 409);
        patch.draw_offer_by = uid;
        log("draw_offered", { ply: match.move_count });
      }
      break;
    }

    case "accept_draw": {
      if (!isPlayer) return json({ error: "Only the players can accept a draw" }, 403);
      if (match.draw_offer_by !== opponentOf(uid)) return json({ error: "There's no draw offer to accept" }, 409);
      finish("1/2-1/2", "agreement");
      log("draw_agreed");
      break;
    }

    case "decline_draw": {
      if (!isPlayer) return json({ error: "Only the players can decline a draw" }, 403);
      patch.draw_offer_by = null;
      log("draw_declined");
      break;
    }

    case "flag": {
      if (!isPlayer && !isStaff) return json({ error: "Not allowed" }, 403);
      if (paused || leftForMover > 0) return json({ error: "There's still time on the clock" }, 409);
      timeoutResult();
      break;
    }

    case "pause": {
      const denied = staffOnly();
      if (denied) return denied;
      if (paused) return json({ error: "Already paused" }, 409);
      if (leftForMover <= 0) {
        timeoutResult();
        break;
      }
      settleClock();
      patch.paused_at = new Date(now).toISOString();
      log("paused");
      break;
    }

    case "resume": {
      const denied = staffOnly();
      if (denied) return denied;
      if (!paused) return json({ error: "The game isn't paused" }, 409);
      patch.paused_at = null;
      patch.clock_started_at = new Date(now).toISOString();
      log("resumed");
      break;
    }

    case "add_time": {
      const denied = staffOnly();
      if (denied) return denied;
      const seconds = Math.round(Number(body.seconds));
      if (!["white", "black"].includes(body.color) || !Number.isFinite(seconds) || seconds === 0 || Math.abs(seconds) > 3600) {
        return json({ error: "Give a colour and a number of seconds" }, 400);
      }
      if (!paused) settleClock();
      const key = body.color === "white" ? "white_ms" : "black_ms";
      const current = patch[key] ?? match[key];
      patch[key] = Math.max(1000, current + seconds * 1000);
      log("time_added", { color: body.color, seconds });
      break;
    }

    case "takeback": {
      const denied = staffOnly();
      if (denied) return denied;
      if (match.move_count === 0) return json({ error: "No moves to take back" }, 409);
      const undone = chess.undo();
      Object.assign(patch, {
        fen: chess.fen(),
        pgn: chess.pgn(),
        move_count: match.move_count - 1,
        clocks: (match.clocks ?? []).slice(0, -1),
        draw_offer_by: null,
        clock_started_at: new Date(now).toISOString(),
        // The waiting side's clock stops where it is.
        [moverKey]: Math.max(1000, Math.round(leftForMover)),
      });
      log("takeback", { san: undone?.san });
      break;
    }

    case "adjudicate": {
      const denied = staffOnly();
      if (denied) return denied;
      if (!["1-0", "0-1", "1/2-1/2"].includes(body.result)) return json({ error: "Pick a result" }, 400);
      if (!paused) settleClock();
      finish(body.result, String(body.reason || "arbiter decision").slice(0, 80));
      log("adjudicated", { result: body.result });
      break;
    }

    default:
      return json({ error: "Unknown action" }, 400);
  }

  // Only write if nobody else moved in the meantime. Actions that don't
  // move a piece (draw offers, pauses, time, results) also need the game to
  // be exactly as read, so two of them can't overwrite each other.
  let save = admin
    .from("matches")
    .update(patch)
    .eq("id", match.id)
    .eq("move_count", match.move_count)
    .neq("status", "completed");
  if (body.action !== "move" && body.action !== "bot_move") save = save.eq("updated_at", match.updated_at);
  const { data: saved, error: saveError } = await save.select("*").maybeSingle();

  if (saveError) {
    console.error("game save failed", saveError);
    return json({ error: "Couldn't save that, please try again" }, 500);
  }
  if (!saved) return json({ error: "The board changed, please try again" }, 409);

  if (saved.status === "completed") log("game_over", { result: saved.result, reason: saved.end_reason });
  if (events.length) await admin.from("game_events").insert(events);

  return json({ match: saved, server_now: new Date().toISOString() });
});
