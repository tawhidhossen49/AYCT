// Every change to a live game goes through here, so moves, clocks and
// results are decided by the server rather than trusted from the browser.
//
// POST { action, match_id, ...args }
//   move        { from, to, promotion? }   side to move only
//   resign                                  either player
//   offer_draw / accept_draw / decline_draw either player
//   flag                                    anyone watching; ends the game if
//                                           the side to move is out of time

import { createClient } from "npm:@supabase/supabase-js@2";
import { Chess } from "npm:chess.js@1.4.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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
    .select("time_control_minutes, increment_seconds")
    .eq("id", match.tournament_id)
    .single();
  const baseMs = (tournament?.time_control_minutes ?? 10) * 60_000;
  const incMs = (tournament?.increment_seconds ?? 0) * 1000;

  // A scheduled game goes live at its start time. White's clock runs from
  // then, so a player who doesn't show up loses on time.
  const patch = {};
  if (match.status === "scheduled") {
    match.status = "live";
    match.white_ms = baseMs;
    match.black_ms = baseMs;
    match.clock_started_at = match.scheduled_at;
    Object.assign(patch, {
      status: "live",
      started_at: match.scheduled_at,
      white_ms: baseMs,
      black_ms: baseMs,
      clock_started_at: match.scheduled_at,
    });
  }

  const chess = new Chess();
  if (match.pgn) chess.loadPgn(match.pgn);
  const turn = chess.turn(); // 'w' | 'b'
  const toMoveId = turn === "w" ? match.white_id : match.black_id;
  const elapsed = now - new Date(match.clock_started_at).getTime();
  const leftForMover = (turn === "w" ? match.white_ms : match.black_ms) - elapsed;
  const isPlayer = uid === match.white_id || uid === match.black_id;
  const opponentOf = (id) => (id === match.white_id ? match.black_id : match.white_id);

  const finish = (result, reason) =>
    Object.assign(patch, {
      status: "completed",
      result,
      end_reason: reason,
      ended_at: new Date(now).toISOString(),
      draw_offer_by: null,
    });

  const timeoutResult = () => {
    // Out of time loses, unless the opponent can't possibly mate: a bare
    // king, or king with a single bishop or knight, is a draw.
    const opp = turn === "w" ? "b" : "w";
    const oppPieces = chess
      .board()
      .flat()
      .filter((sq) => sq && sq.color === opp && sq.type !== "k");
    const cannotMate = oppPieces.length === 0 || (oppPieces.length === 1 && ["b", "n"].includes(oppPieces[0].type));
    if (cannotMate) return finish("1/2-1/2", "timeout vs insufficient material");
    finish(turn === "w" ? "0-1" : "1-0", "timeout");
  };

  switch (body.action) {
    case "move": {
      if (uid !== toMoveId) return json({ error: "It's not your move" }, 403);
      if (leftForMover <= 0) {
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

      const left = leftForMover + incMs;
      Object.assign(patch, {
        fen: chess.fen(),
        pgn: chess.pgn(),
        move_count: match.move_count + 1,
        [turn === "w" ? "white_ms" : "black_ms"]: Math.round(left),
        [turn === "w" ? "black_ms" : "white_ms"]: turn === "w" ? match.black_ms : match.white_ms,
        clock_started_at: new Date(now).toISOString(),
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
      break;
    }

    case "offer_draw": {
      if (!isPlayer) return json({ error: "Only the players can offer a draw" }, 403);
      patch.draw_offer_by = uid;
      break;
    }

    case "accept_draw": {
      if (!isPlayer) return json({ error: "Only the players can accept a draw" }, 403);
      if (match.draw_offer_by !== opponentOf(uid)) return json({ error: "There's no draw offer to accept" }, 409);
      finish("1/2-1/2", "agreement");
      break;
    }

    case "decline_draw": {
      if (!isPlayer) return json({ error: "Only the players can decline a draw" }, 403);
      patch.draw_offer_by = null;
      break;
    }

    case "flag": {
      if (!isPlayer && !isStaff) return json({ error: "Not allowed" }, 403);
      if (leftForMover > 0) return json({ error: "There's still time on the clock" }, 409);
      timeoutResult();
      break;
    }

    default:
      return json({ error: "Unknown action" }, 400);
  }

  // Only write if nobody else moved in the meantime.
  const { data: saved, error: saveError } = await admin
    .from("matches")
    .update(patch)
    .eq("id", match.id)
    .eq("move_count", match.move_count)
    .neq("status", "completed")
    .select("*")
    .maybeSingle();

  if (saveError) return json({ error: saveError.message }, 500);
  if (!saved) return json({ error: "The board changed, please try again" }, 409);
  return json({ match: saved, server_now: new Date().toISOString() });
});
