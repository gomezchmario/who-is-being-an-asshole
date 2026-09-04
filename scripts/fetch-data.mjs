/* Fetches XHQ-7V structure market + Jita reference prices and writes data.json.
 * Runs in GitHub Actions on a schedule. Requires env vars:
 *   EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_REFRESH_TOKEN
 * (character needs docking access to the market structure and the
 *  esi-markets.structure_market_access.v1 scope)
 */
import { writeFileSync } from "node:fs";

const SYSTEM_ID = 30003731; // XHQ-7V
const REGION_ID = 10000047; // Providence
const JITA_STATION = 60003760; // Jita IV - Moon 4 - Caldari Navy Assembly Plant
const KNOWN_STRUCTURES = [1035949018593]; // Immortalis Fortizar
const ESI = "https://esi.evetech.net/latest";
const UA = "who-is-being-an-asshole (github.com self-hosted market tool)";

const { EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_REFRESH_TOKEN } = process.env;
if (!EVE_CLIENT_ID || !EVE_CLIENT_SECRET || !EVE_REFRESH_TOKEN) {
  console.error("Missing EVE_CLIENT_ID / EVE_CLIENT_SECRET / EVE_REFRESH_TOKEN env vars.");
  process.exit(1);
}

async function esiJson(url, opts = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (res.ok) return { json: await res.json(), headers: res.headers };
    if (res.status === 403 || res.status === 404) return { error: res.status };
    if (i < retries && (res.status === 420 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      continue;
    }
    throw new Error(`${url} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

async function getAccessToken() {
  const basic = Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString("base64");
  const res = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": UA,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: EVE_REFRESH_TOKEN }),
  });
  if (!res.ok) throw new Error(`SSO token refresh failed: HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function fetchPaginated(url, headers) {
  const first = await esiJson(`${url}?page=1`, { headers });
  if (first.error) return { error: first.error, items: [] };
  const pages = Number(first.headers.get("x-pages") || 1);
  const items = [...first.json];
  for (let p = 2; p <= pages; p++) {
    const next = await esiJson(`${url}?page=${p}`, { headers });
    if (!next.error) items.push(...next.json);
  }
  return { items };
}

async function main() {
  const token = await getAccessToken();
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Discover market structures in XHQ-7V from the public regional feed
  //    (structure buy orders are public and reveal structure IDs).
  const pub = await fetchPaginated(`${ESI}/markets/${REGION_ID}/orders/`);
  const structureIds = new Set(KNOWN_STRUCTURES);
  const publicSells = [];
  for (const o of pub.items) {
    if (o.system_id !== SYSTEM_ID) continue;
    if (o.location_id > 1e12) structureIds.add(o.location_id);
    else if (!o.is_buy_order) publicSells.push(o); // NPC station sells, if any
  }

  // 2. Pull each structure's full order book (authenticated) + its name.
  const structures = {};
  const sells = [...publicSells];
  for (const sid of structureIds) {
    const info = await esiJson(`${ESI}/universe/structures/${sid}/`, { headers: auth });
    structures[sid] = info.error ? `structure ${sid}` : info.json.name;

    const book = await fetchPaginated(`${ESI}/markets/structures/${sid}/`, auth);
    if (book.error) {
      console.warn(`No market access to structure ${sid} (HTTP ${book.error}), skipping.`);
      continue;
    }
    for (const o of book.items) {
      if (!o.is_buy_order) sells.push({ ...o, location_id: sid });
    }
  }
  console.log(`Structures: ${JSON.stringify(structures)}`);
  console.log(`Sell orders found: ${sells.length}`);

  // 3. Jita reference prices from Fuzzwork aggregates (min sell at Jita 4-4).
  const typeIds = [...new Set(sells.map((o) => o.type_id))];
  const jita = {};
  for (let i = 0; i < typeIds.length; i += 100) {
    const chunk = typeIds.slice(i, i + 100);
    const res = await fetch(
      `https://market.fuzzwork.co.uk/aggregates/?station=${JITA_STATION}&types=${chunk.join(",")}`,
      { headers: { "User-Agent": UA } }
    );
    if (!res.ok) throw new Error(`Fuzzwork HTTP ${res.status}`);
    const agg = await res.json();
    for (const [tid, v] of Object.entries(agg)) {
      const min = Number(v?.sell?.min);
      if (min > 0) jita[tid] = min;
    }
  }

  // 4. Type names.
  const names = {};
  for (let i = 0; i < typeIds.length; i += 900) {
    const chunk = typeIds.slice(i, i + 900);
    const res = await esiJson(`${ESI}/universe/names/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(chunk),
    });
    for (const n of res.json || []) names[n.id] = n.name;
  }

  // 5. Assemble output.
  const orders = sells.map((o) => {
    const j = jita[o.type_id] ?? null;
    return {
      type_id: o.type_id,
      name: names[o.type_id] || null,
      price: o.price,
      jita: j,
      markup: j ? o.price / j - 1 : null,
      volume: o.volume_remain,
      location_id: String(o.location_id),
    };
  });
  orders.sort((a, b) => (b.markup ?? -Infinity) - (a.markup ?? -Infinity));

  const out = {
    generated: new Date().toISOString(),
    system: "XHQ-7V",
    structures,
    orders,
  };
  writeFileSync(new URL("../data.json", import.meta.url), JSON.stringify(out));
  const offenders = orders.filter((o) => o.markup >= 0.2).length;
  console.log(`Wrote data.json: ${orders.length} sell orders, ${offenders} assholes (>=20% over Jita).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
