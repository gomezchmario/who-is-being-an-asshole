/* One-time local helper: gets an EVE SSO refresh token for the GitHub Action.
 *
 * 1. Create an app at https://developers.eveonline.com/applications
 *    - Connection type: Authentication & API Access
 *    - Scope: esi-markets.structure_markets.v1
 *    - Callback URL: http://localhost:8787/callback
 * 2. Run:  node scripts/get-token.mjs <CLIENT_ID> <CLIENT_SECRET>
 * 3. Log in with the character that has docking access to the structure.
 * 4. Copy the printed refresh token into your GitHub repo secrets.
 */
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const PORT = 8787;
const state = randomBytes(16).toString("hex");
const authUrl =
  "https://login.eveonline.com/v2/oauth/authorize/?" +
  new URLSearchParams({
    response_type: "code",
    redirect_uri: `http://localhost:${PORT}/callback`,
    client_id: clientId,
    scope: "esi-markets.structure_markets.v1",
    state,
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("state mismatch"); return;
  }
  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const tokenRes = await fetch("https://login.eveonline.com/v2/oauth/token", {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: url.searchParams.get("code") }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(JSON.stringify(tok));
    res.writeHead(200, { "Content-Type": "text/html" })
      .end("<h1 style='font-family:monospace'>Token acquired. Return to the terminal. o7</h1>");
    const who = JSON.parse(Buffer.from(tok.access_token.split(".")[1], "base64url").toString());
    console.log("\nAuthenticated as:", who.name);
    console.log("\n=== Add these as GitHub repository secrets ===");
    console.log("EVE_CLIENT_ID     =", clientId);
    console.log("EVE_CLIENT_SECRET =", clientSecret);
    console.log("EVE_REFRESH_TOKEN =", tok.refresh_token);
    console.log("==============================================\n");
  } catch (e) {
    res.writeHead(500).end("Token exchange failed, see terminal.");
    console.error("Token exchange failed:", e.message);
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("Open this URL in your browser and log in:\n\n" + authUrl + "\n");
});
