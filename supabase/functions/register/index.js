// Retired. Registration now happens in a Google Form linked from the main
// page, so this endpoint no longer creates anything.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  return new Response(JSON.stringify({ error: "Registration on the site has closed. Use the Register now button on the main page." }), {
    status: 410,
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
