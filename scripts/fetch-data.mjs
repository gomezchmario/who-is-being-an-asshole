/* Fetches XHQ-7V structure market + Jita reference prices and writes data.json.
 * Runs in GitHub Actions on a schedule. Requires env vars:
 *   EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_REFRESH_TOKEN, JANICE_API_KEY
 * (character needs docking access to the market structure and the
 *  esi-markets.structure_markets.v1 scope; Janice keys are handed
 *  out on the E-351 Discord — see README)
 */
import { writeFileSync, readFileSync } from "node:fs";

const SYSTEM_ID = 30003731; // XHQ-7V
const REGION_ID = 10000047; // Providence
const JANICE_MARKET = 2; // Jita 4-4
const KNOWN_STRUCTURES = [1035949018593];
// Capital ship groups: Titan, Dread, Carrier, Super, FAX, Rorqual, Freighter,
// Jump Freighter, Lancer Dread.
const CAP_GROUPS = new Set([30, 485, 547, 659, 1538, 883, 513, 902, 4594]);
// Capital-only gear that lacks "Capital"/"XL" in its name.
const CAP_NAME_RE = /Capital |(^|\s)XL(\s|$)|^(Siege|Triage) Module|^Fighter Support Unit|^Networked Sensor Array/;
// Name lookup via /universe/structures/ needs an extra scope
// (esi-universe.read_structures.v1) the token may not have; fall back here.
const KNOWN_NAMES = { 1035949018593: "XHQ-7V - Immortalis Fortizar" };
const ESI = "https://esi.evetech.net/latest";
const UA = "who-is-being-an-asshole (github.com self-hosted market tool)";

const { EVE_CLIENT_ID, EVE_CLIENT_SECRET, EVE_REFRESH_TOKEN, JANICE_API_KEY } = process.env;
if (!EVE_CLIENT_ID || !EVE_CLIENT_SECRET || !EVE_REFRESH_TOKEN || !JANICE_API_KEY) {
  console.error("Missing EVE_CLIENT_ID / EVE_CLIENT_SECRET / EVE_REFRESH_TOKEN / JANICE_API_KEY env vars.");
  process.exit(1);
}

async function esiJson(url, opts = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    const res = await fetch(url, {
      ...opts,
      headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) },
    });
    if (res.ok) return { json: await res.json(), headers: res.headers };
    if (res.status === 401 || res.status === 403 || res.status === 404) return { error: res.status };
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

async function inBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
  }
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
    structures[sid] = info.error ? KNOWN_NAMES[sid] || `structure ${sid}` : info.json.name;

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

  // 3. Jita reference prices from Janice (min sell at Jita 4-4, falling
  //    back to the 5-day median sell when Jita is momentarily out of stock).
  const typeIds = [...new Set(sells.map((o) => o.type_id))];
  const jita = {};
  for (let i = 0; i < typeIds.length; i += 500) {
    const chunk = typeIds.slice(i, i + 500);
    const res = await fetch(`https://janice.e-351.com/api/rest/v2/pricer?market=${JANICE_MARKET}`, {
      method: "POST",
      headers: { "X-ApiKey": JANICE_API_KEY, "Content-Type": "text/plain", "User-Agent": UA },
      body: chunk.join("\n"),
    });
    if (!res.ok) throw new Error(`Janice HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for (const item of await res.json()) {
      const p = item?.immediatePrices;
      const price = Number(p?.sellPrice) || Number(p?.sellPrice5DayMedian);
      if (item?.itemType?.eid && price > 0) jita[item.itemType.eid] = price;
    }
  }

  // 3b. Item group + category (for the frontend filters), via ESI type ->
  //     group -> category. Cached in type-cats.json ({tid: [group, category]})
  //     so each run only looks up new types.
  const catCacheFile = new URL("../type-cats.json", import.meta.url);
  let catCache = {};
  try {
    const raw = JSON.parse(readFileSync(catCacheFile, "utf8"));
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) catCache[k] = v;
  } catch {}
  const unknownTypes = typeIds.filter((t) => catCache[t] == null);
  const typeGroups = {};
  await inBatches(unknownTypes, 20, async (tid) => {
    const res = await esiJson(`${ESI}/universe/types/${tid}/`);
    if (!res.error) typeGroups[tid] = res.json.group_id;
  });
  const groupCats = {};
  await inBatches([...new Set(Object.values(typeGroups))], 20, async (gid) => {
    const res = await esiJson(`${ESI}/universe/groups/${gid}/`);
    if (!res.error) groupCats[gid] = res.json.category_id;
  });
  for (const [tid, gid] of Object.entries(typeGroups)) {
    if (groupCats[gid] != null) catCache[tid] = [gid, groupCats[gid]];
  }
  writeFileSync(catCacheFile, JSON.stringify(catCache));
  console.log(`Categorized ${unknownTypes.length} new types (cache now ${Object.keys(catCache).length}).`);

  // 3c. Galaxy-wide average prices (CCP's in-game estimate) as reference for
  //     anything Jita has no sell orders for — capital hulls, mostly.
  const galaxy = {};
  {
    const res = await esiJson(`${ESI}/markets/prices/`);
    for (const p of res.json || []) {
      const v = Number(p.average_price) || Number(p.adjusted_price);
      if (v > 0) galaxy[p.type_id] = v;
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

  // 5. Assemble output. Reference price is Jita min sell; galaxy average
  //    fallback (marked gal:1) when Jita has none.
  const orders = sells.map((o) => {
    const [grp, cat] = catCache[o.type_id] ?? [null, null];
    const name = names[o.type_id] || null;
    const gal = jita[o.type_id] == null && galaxy[o.type_id] != null;
    const ref = jita[o.type_id] ?? galaxy[o.type_id] ?? null;
    const capital = CAP_GROUPS.has(grp) || (name != null && CAP_NAME_RE.test(name)) || cat === 87;
    return {
      type_id: o.type_id,
      name,
      price: o.price,
      jita: ref,
      markup: ref ? o.price / ref - 1 : null,
      volume: o.volume_remain,
      location_id: String(o.location_id),
      cat,
      ...(gal && { gal: 1 }),
      ...(capital && { capital: 1 }),
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
