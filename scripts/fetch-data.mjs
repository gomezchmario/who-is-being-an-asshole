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
  const buys = []; // buy orders across the system's structures
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
      else buys.push(o);
    }
  }
  // Best (highest) buy per type: price, that order's remaining qty, and the
  // type's total buy-side demand.
  const bestBuy = {};
  for (const o of buys) {
    const b = bestBuy[o.type_id];
    if (!b || o.price > b.p) bestBuy[o.type_id] = { p: o.price, q: o.volume_remain, tq: (b?.tq || 0) + o.volume_remain };
    else b.tq += o.volume_remain;
  }
  console.log(`Structures: ${JSON.stringify(structures)}`);
  console.log(`Sell orders found: ${sells.length}; buy orders: ${buys.length} (${Object.keys(bestBuy).length} types)`);

  // 2a2. Regional buy orders (public feeds, Providence + Catch) for the
  //      trade room's expanded bounty scope. Best order per type, kept when
  //      the order is worth at least 1M, capped to the 500 richest.
  const CATCH_ID = 10000014;
  const bestRBuy = {};
  for (const rid of [REGION_ID, CATCH_ID]) {
    const feed = await fetchPaginated(`${ESI}/markets/${rid}/orders/`);
    for (const o of feed.items) {
      if (!o.is_buy_order) continue;
      const b = bestRBuy[o.type_id];
      if (!b || o.price > b.p) bestRBuy[o.type_id] = { p: o.price, q: o.volume_remain, tq: (b?.tq || 0) + o.volume_remain, sys: o.system_id };
      else b.tq += o.volume_remain;
    }
  }
  const rbuyEntries = Object.entries(bestRBuy)
    .map(([tid, b]) => [Number(tid), b])
    .filter(([, b]) => b.p * b.q >= 1_000_000)
    .sort((a, z) => z[1].p * z[1].q - a[1].p * a[1].q)
    .slice(0, 500);
  const rbuyTypeIds = rbuyEntries.map(([tid]) => tid);
  const rbuySystemIds = [...new Set(rbuyEntries.map(([, b]) => b.sys))];
  console.log(`Regional buys (Prov+Catch): ${rbuyEntries.length} types kept.`);

  // 2b. Outstanding public contracts starting at our structures. Contract
  //     contents are immutable, so they're cached in contract-items.json and
  //     only new contract ids are fetched each run.
  const contractsRaw = [];
  {
    const all = await fetchPaginated(`${ESI}/contracts/public/${REGION_ID}/`);
    for (const c of all.items) {
      if (structureIds.has(c.start_location_id) && c.type === "item_exchange") contractsRaw.push(c);
    }
  }
  const itemsCacheFile = new URL("../contract-items.json", import.meta.url);
  let itemsCache = {};
  try {
    const raw = JSON.parse(readFileSync(itemsCacheFile, "utf8"));
    if (raw._v === 2) { delete raw._v; itemsCache = raw; }
  } catch {}
  const newContracts = contractsRaw.filter((c) => itemsCache[c.contract_id] == null);
  await inBatches(newContracts, 15, async (c) => {
    const res = await esiJson(`${ESI}/contracts/public/items/${c.contract_id}/`);
    if (res.error) { itemsCache[c.contract_id] = []; return; }
    // [type_id, quantity, included(1/0), bpc(1/0), item_id(0 if none)]
    itemsCache[c.contract_id] = (res.json || []).map((i) => [
      i.type_id, i.quantity, i.is_included ? 1 : 0, i.is_blueprint_copy ? 1 : 0, i.item_id || 0,
    ]);
  });
  // Prune expired/completed contracts from the cache.
  const liveIds = new Set(contractsRaw.map((c) => String(c.contract_id)));
  for (const k of Object.keys(itemsCache)) if (!liveIds.has(k)) delete itemsCache[k];
  writeFileSync(itemsCacheFile, JSON.stringify({ _v: 2, ...itemsCache }));
  console.log(`Contracts at structures: ${contractsRaw.length} (${newContracts.length} newly fetched).`);

  // 2c. Structured doctrine data (scraped snapshot) for the readiness page.
  let doctrineData = null;
  try { doctrineData = JSON.parse(readFileSync(new URL("../doctrines.json", import.meta.url), "utf8")); } catch {}
  const doctrineTypeIds = doctrineData
    ? [...new Set(Object.values(doctrineData.fits).flatMap((f) => f.i.map((x) => x[0])))]
    : [];

  // 2d. Industry inputs for the trade room: minerals, fuel, capital
  //     components, common PI goods. Resolved by name so no ids go stale.
  const INDUSTRY_NAMES = [
    "Tritanium", "Pyerite", "Mexallon", "Isogen", "Nocxium", "Zydrine", "Megacyte", "Morphite",
    "Helium Isotopes", "Hydrogen Isotopes", "Oxygen Isotopes", "Nitrogen Isotopes",
    "Liquid Ozone", "Heavy Water", "Strontium Clathrates",
    "Amarr Fuel Block", "Caldari Fuel Block", "Gallente Fuel Block", "Minmatar Fuel Block",
    "Capital Armor Plates", "Capital Capacitor Battery", "Capital Cargo Bay", "Capital Computer System",
    "Capital Construction Parts", "Capital Corporate Hangar Bay", "Capital Doomsday Weapon Mount",
    "Capital Drone Bay", "Capital Jump Drive", "Capital Launcher Hardpoint", "Capital Power Generator",
    "Capital Propulsion Engine", "Capital Sensor Cluster", "Capital Shield Emitter",
    "Capital Ship Maintenance Bay", "Capital Turret Hardpoint",
    "Coolant", "Robotics", "Construction Blocks", "Mechanical Parts", "Consumer Electronics",
    "Oxygen", "Water", "Enriched Uranium", "Guidance Systems", "Transmitter",
    "Reactive Metals", "Precious Metals", "Toxic Metals", "Silicate Glass",
    "Superconductors", "Rocket Fuel", "Synthetic Oil", "Electrolytes", "Nanites",
  ];
  const industryIds = [];
  {
    const res = await esiJson(`${ESI}/universe/ids/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(INDUSTRY_NAMES),
    });
    for (const t of res.json?.inventory_types || []) industryIds.push(t.id);
  }

  // 3. Jita reference prices from Janice (min sell at Jita 4-4, falling
  //    back to the 5-day median sell when Jita is momentarily out of stock).
  const contractTypeIds = Object.values(itemsCache).flatMap((items) => items.map((i) => i[0]));
  const buyTypeIds = Object.keys(bestBuy).map(Number);
  const typeIds = [...new Set([...sells.map((o) => o.type_id), ...contractTypeIds, ...doctrineTypeIds, ...industryIds, ...buyTypeIds, ...rbuyTypeIds])];
  const jita = {};
  const vols = {}; // packaged m³ per type, from Janice
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
      const v = Number(item?.itemType?.packagedVolume) || Number(item?.itemType?.volume);
      if (item?.itemType?.eid && v > 0) vols[item.itemType.eid] = v;
    }
  }

  // 3a. Amarr prices (Janice market 115) — doctrine + industry items.
  const amarr = {};
  const amarrIds = typeIds; // trade room can price against Amarr for anything
  for (let i = 0; i < amarrIds.length; i += 500) {
    const chunk = amarrIds.slice(i, i + 500);
    const res = await fetch(`https://janice.e-351.com/api/rest/v2/pricer?market=115`, {
      method: "POST",
      headers: { "X-ApiKey": JANICE_API_KEY, "Content-Type": "text/plain", "User-Agent": UA },
      body: chunk.join("\n"),
    });
    if (!res.ok) { console.warn(`Janice Amarr HTTP ${res.status}, skipping Amarr prices.`); break; }
    for (const item of await res.json()) {
      const p = item?.immediatePrices;
      const price = Number(p?.sellPrice) || Number(p?.sellPrice5DayMedian);
      if (item?.itemType?.eid && price > 0) amarr[item.itemType.eid] = price;
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

  // 4. Type and issuer names (one endpoint handles both).
  const names = {};
  const issuerIds = [...new Set(contractsRaw.map((c) => c.issuer_id))];
  const allIds = [...typeIds, ...issuerIds, ...rbuySystemIds];
  for (let i = 0; i < allIds.length; i += 900) {
    const chunk = allIds.slice(i, i + 900);
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
  const offenders = orders.filter((o) => o.markup >= 0.3).length;
  console.log(`Wrote data.json: ${orders.length} sell orders, ${offenders} assholes (>=30% over Jita).`);

  // 6. Contract valuation: price vs summed Jita value of the contents.
  let doctrineShips = new Set();
  try {
    const d = JSON.parse(readFileSync(new URL("../doctrine-items.json", import.meta.url), "utf8"));
    doctrineShips = new Set(d.types.filter((t) => catCache[t]?.[1] === 6));
  } catch {}
  const refPrice = (tid) => jita[tid] ?? galaxy[tid] ?? null;

  // Scalper detection. Assembled items keep their unique item_id across
  // trades, so if a contract vanished before its expiry (presumed sold) and
  // one of its physical items reappears in a newer, pricier contract from a
  // different character, that's a relist — a scalp. History is built by this
  // job over time (contracts-history.json); detection starts working as
  // contracts churn.
  const histFile = new URL("../contracts-history.json", import.meta.url);
  let hist = {};
  try { hist = JSON.parse(readFileSync(histFile, "utf8")).contracts || {}; } catch {}
  const nowIso = new Date().toISOString();
  const goneIndex = new Map(); // item_id -> [historical cid, ...]
  for (const [cid, h] of Object.entries(hist)) {
    if (liveIds.has(cid)) continue;
    // Vanished well before expiry -> sold (or withdrawn), not lapsed.
    if (new Date(h.e) - new Date(h.t) < 2 * 3600e3) continue;
    for (const iid of h.ids || []) {
      if (!goneIndex.has(iid)) goneIndex.set(iid, []);
      goneIndex.get(iid).push(cid);
    }
  }
  function findScalp(c, included, issuerName) {
    let best = null;
    for (const [, , , , iid] of included) {
      if (!iid) continue;
      for (const cid of goneIndex.get(iid) || []) {
        const h = hist[cid];
        if (h.i === issuerName || c.price <= h.p) continue;
        if (!best || h.t > best.t) best = h;
      }
    }
    return best ? { from: best.i, paid: best.p } : null;
  }

  const contracts = contractsRaw.map((c) => {
    const items = itemsCache[c.contract_id] || [];
    const included = items.filter((i) => i[2]);
    let value = 0, unpriced = 0, hull = null, hullValue = -1, doctrine = 0;
    for (const [tid, qty, , bpc] of included) {
      const p = bpc ? null : refPrice(tid);
      if (p == null) { unpriced++; continue; }
      value += p * qty;
      if (catCache[tid]?.[1] === 6 && p * qty > hullValue) { hullValue = p * qty; hull = tid; }
      if (doctrineShips.has(tid)) doctrine = 1;
    }
    const swap = items.some((i) => !i[2]);
    // Abyssal (mutated) modules are unique items with no market price; they
    // count 0 toward value, so flag the contract — its markup is overstated.
    const aby = included.some(([tid]) => (names[tid] || "").startsWith("Abyssal"));
    const markup = !swap && value > 0 ? c.price / value - 1 : null;
    const issuerName = names[c.issuer_id] || String(c.issuer_id);
    const scalp = findScalp(c, included, issuerName);
    return {
      id: c.contract_id,
      title: c.title || "",
      issuer: issuerName,
      price: c.price,
      value: value || null,
      markup,
      items: included.reduce((s, i) => s + i[1], 0),
      hull: hull ? names[hull] : null,
      hull_id: hull,
      expires: c.date_expired,
      ...(doctrine && { doctrine: 1 }),
      ...(unpriced && { est: 1 }),
      ...(swap && { swap: 1 }),
      ...(aby && { aby: 1 }),
      ...(scalp && { scalp }),
    };
  });
  contracts.sort((a, b) => (b.markup ?? -Infinity) - (a.markup ?? -Infinity));

  // Permanent scalp log: every detected scalp is recorded forever, so the
  // hall of shame survives the contract selling or being pulled.
  const logFile = new URL("../scalp-log.json", import.meta.url);
  let scalpLog = {};
  try { scalpLog = JSON.parse(readFileSync(logFile, "utf8")).entries || {}; } catch {}
  for (const c of contracts) {
    if (!c.scalp) continue;
    const prev = scalpLog[c.id];
    scalpLog[c.id] = {
      id: c.id, title: c.title, issuer: c.issuer, price: c.price, value: c.value,
      markup: c.markup, hull: c.hull, scalp: c.scalp, expires: c.expires,
      ...(c.doctrine && { doctrine: 1 }),
      detected: prev?.detected || nowIso,
    };
  }
  for (const e of Object.values(scalpLog)) {
    if (!e.gone && !liveIds.has(String(e.id))) e.gone = nowIso;
  }
  writeFileSync(logFile, JSON.stringify({ entries: scalpLog }));

  // Update history with what's live now; drop entries stale for 60+ days.
  for (const c of contractsRaw) {
    const items = itemsCache[c.contract_id] || [];
    hist[c.contract_id] = {
      p: c.price,
      i: names[c.issuer_id] || String(c.issuer_id),
      e: c.date_expired,
      t: nowIso,
      ids: items.filter((i) => i[2] && i[4]).map((i) => i[4]),
    };
  }
  for (const [cid, h] of Object.entries(hist)) {
    if (Date.now() - new Date(h.t) > 60 * 86400e3) delete hist[cid];
  }
  writeFileSync(histFile, JSON.stringify({ contracts: hist }));
  writeFileSync(new URL("../contracts.json", import.meta.url), JSON.stringify({
    generated: new Date().toISOString(),
    system: "XHQ-7V",
    contracts,
  }));
  const cOff = contracts.filter((x) => x.markup >= 0.3).length;
  console.log(`Wrote contracts.json: ${contracts.length} contracts, ${cOff} assholes, ` +
    `${contracts.filter((x) => x.doctrine).length} doctrine-ship, ${contracts.filter((x) => x.scalp).length} scalps.`);

  // 7. Doctrine readiness (for the unlinked war-room page): per fit, can it be
  //    bought in XHQ, at what cost, vs Jita and Amarr; what's missing locally.
  if (doctrineData) {
    const xhqMkt = {};
    for (const o of sells) {
      const m = (xhqMkt[o.type_id] ??= { q: 0, min: Infinity });
      m.q += o.volume_remain;
      if (o.price < m.min) m.min = o.price;
    }
    const hullCon = {}; // hull type_id -> {n, min contract price}
    for (const c of contractsRaw) {
      const items = itemsCache[c.contract_id] || [];
      const hulls = new Set(items.filter((i) => i[2] && catCache[i[0]]?.[1] === 6).map((i) => i[0]));
      for (const h of hulls) {
        const e = (hullCon[h] ??= { n: 0, min: Infinity });
        e.n++;
        if (c.price < e.min) e.min = c.price;
      }
    }
    const doctrines = doctrineData.doctrines.map((d) => ({
      name: d.name,
      fits: d.fits.filter((fid) => doctrineData.fits[fid]).map((fid) => {
        const f = doctrineData.fits[fid];
        const items = f.i.map(([tid, qty]) => {
          const m = xhqMkt[tid];
          return {
            id: tid, name: names[tid] || `type ${tid}`, qty,
            cat: catCache[tid]?.[1] ?? null,
            mkt: m ? { q: m.q, min: m.min } : null,
            jita: jita[tid] ?? galaxy[tid] ?? null,
            amarr: amarr[tid] ?? null,
          };
        });
        const missing = items.filter((it) => !it.mkt);
        let costXhq = 0, xhqPartial = false, costJita = 0, jitaPartial = false, costAmarr = 0, amarrPartial = false;
        for (const it of items) {
          if (it.mkt) costXhq += it.mkt.min * it.qty; else xhqPartial = true;
          if (it.jita != null) costJita += it.jita * it.qty; else jitaPartial = true;
          if (it.amarr != null) costAmarr += it.amarr * it.qty; else amarrPartial = true;
        }
        return {
          t: f.t, hull: f.h, hullName: names[f.h] || null,
          hullMkt: xhqMkt[f.h] ? { q: xhqMkt[f.h].q, min: xhqMkt[f.h].min } : null,
          hullCon: hullCon[f.h] || null,
          items, missing: missing.map((it) => ({ id: it.id, name: it.name, qty: it.qty, cat: it.cat })),
          costXhq, xhqPartial, costJita, jitaPartial, costAmarr, amarrPartial,
        };
      }),
    }));
    // Doctrine consumables/implants absent from the XHQ market entirely.
    const usedTypes = new Map();
    for (const f of Object.values(doctrineData.fits)) {
      for (const [tid] of f.i) usedTypes.set(tid, (usedTypes.get(tid) || 0) + 1);
    }
    // Items banned from every list (fit joke items etc.).
    const EXCLUDE_NAMES = new Set(["Crimson Scythes Firework", "Sodium Firework"]);
    const excluded = (tid) => EXCLUDE_NAMES.has(names[tid]);
    const missingBy = (cats) => [...usedTypes.keys()]
      .filter((tid) => cats.includes(catCache[tid]?.[1]) && !xhqMkt[tid] && !excluded(tid))
      .map((tid) => ({ id: tid, name: names[tid] || `type ${tid}`, fits: usedTypes.get(tid) }))
      .sort((a, b) => b.fits - a.fits);
    writeFileSync(new URL("../readiness.json", import.meta.url), JSON.stringify({
      generated: new Date().toISOString(),
      system: "XHQ-7V",
      doctrines,
      missingAmmo: missingBy([8, 18, 87]),
      missingImplants: missingBy([20]),
    }));
    console.log(`Wrote readiness.json: ${doctrines.length} doctrines.`);

    // 8. Trade room: alliance losses from zKillboard (30 days, cached) +
    //    consolidated per-type supply data.
    const ALLIANCES = { 1988009451: "CVA", 99010240: "CVAA" };
    const zkFile = new URL("../zkill-cache.json", import.meta.url);
    let zk = {};
    try { zk = JSON.parse(readFileSync(zkFile, "utf8")).kills || {}; } catch {}
    const cutoff = Date.now() - 30 * 86400e3;
    const hardCutoff = Date.now() - 35 * 86400e3;
    for (const aid of Object.keys(ALLIANCES)) {
      pages: for (let p = 1; p <= 8; p++) {
        let page;
        try {
          const res = await fetch(`https://zkillboard.com/api/losses/allianceID/${aid}/page/${p}/`, {
            headers: { "User-Agent": UA + " (killboard: doctrine loss tracking)" },
          });
          if (!res.ok) break;
          page = await res.json();
        } catch { break; }
        if (!Array.isArray(page) || !page.length) break;
        let sawKnown = false;
        for (const km of page) {
          if (zk[km.killmail_id]) { sawKnown = true; continue; }
          const t = new Date(km.killmail_time).getTime();
          if (t < hardCutoff) break pages;
          if (km.victim?.ship_type_id) zk[km.killmail_id] = [km.victim.ship_type_id, km.killmail_time.slice(0, 10)];
        }
        if (sawKnown) break;
        await new Promise((r) => setTimeout(r, 1100)); // be polite to zkill
      }
    }
    for (const [id, [, d]] of Object.entries(zk)) {
      if (new Date(d).getTime() < hardCutoff) delete zk[id];
    }
    writeFileSync(zkFile, JSON.stringify({ kills: zk }));
    const lossCount = {};
    for (const [ship, d] of Object.values(zk)) {
      if (new Date(d).getTime() >= cutoff) lossCount[ship] = (lossCount[ship] || 0) + 1;
    }
    const unknownShipIds = Object.keys(lossCount).map(Number).filter((id) => !names[id]);
    if (unknownShipIds.length) {
      const res = await esiJson(`${ESI}/universe/names/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unknownShipIds),
      });
      for (const n of res.json || []) names[n.id] = n.name;
    }
    const losses = Object.entries(lossCount)
      .map(([id, n]) => ({ id: +id, name: names[id] || `type ${id}`, n, cat: catCache[id]?.[1] ?? null, doctrine: doctrineShips.has(+id) ? 1 : 0 }))
      .sort((a, b) => b.n - a.n);

    // Whole-market coverage: everything on the XHQ market joins the trade set.
    const marketTypeIds = [...new Set(sells.map((o) => o.type_id))];
    const tradeIds = [...new Set([...doctrineTypeIds, ...industryIds, ...marketTypeIds, ...buyTypeIds, ...rbuyTypeIds])];

    // Regional market velocity: average daily traded volume over the last 30
    // days from ESI market history (includes structure trades). ~1 request
    // per type, so refreshed once per UTC day and cached in between.
    const histFile = new URL("../history-cache.json", import.meta.url);
    let hist2 = { date: null, vols: {} };
    try { hist2 = JSON.parse(readFileSync(histFile, "utf8")); } catch {}
    const today = new Date().toISOString().slice(0, 10);
    const fetchHistory = async (ids, into) => {
      await inBatches(ids, 5, async (tid) => {
        const res = await esiJson(`${ESI}/markets/${REGION_ID}/history/?type_id=${tid}`, {}, 1);
        if (res?.error || !Array.isArray(res?.json)) { into[tid] = 0; return; }
        const cutoff30 = Date.now() - 30 * 86400e3;
        const vol = res.json.filter((d) => new Date(d.date).getTime() >= cutoff30)
          .reduce((s, d) => s + d.volume, 0);
        into[tid] = Math.round((vol / 30) * 100) / 100;
      });
    };
    if (hist2.date !== today) {
      const vols30 = {};
      await fetchHistory(tradeIds, vols30);
      hist2 = { date: today, vols: vols30 };
      writeFileSync(histFile, JSON.stringify(hist2));
      console.log(`Refreshed market history for ${tradeIds.length} types.`);
    } else {
      // Same day, but new types may have joined the set — top up just those.
      const missing = tradeIds.filter((t) => hist2.vols[t] == null);
      if (missing.length) {
        await fetchHistory(missing, hist2.vols);
        writeFileSync(histFile, JSON.stringify(hist2));
        console.log(`Topped up market history for ${missing.length} new types.`);
      }
    }
    const tradeItems = tradeIds.filter((tid) => !excluded(tid)).map((tid) => {
      const m = xhqMkt[tid];
      return {
        id: tid,
        name: names[tid] || `type ${tid}`,
        cat: catCache[tid]?.[1] ?? null,
        vol: vols[tid] ?? null,
        jita: jita[tid] ?? null,
        amarr: amarr[tid] ?? null,
        xhq: m ? { q: m.q, min: m.min } : null,
        fits: usedTypes.get(tid) || 0,
        mov: hist2.vols[tid] ?? 0,
        ...(industryIds.includes(tid) && { ind: 1 }),
        ...(lossCount[tid] && { lost: lossCount[tid] }),
      };
    });
    const buyList = Object.entries(bestBuy)
      .filter(([tid]) => !excluded(+tid))
      .map(([tid, b]) => ({ id: +tid, p: b.p, q: b.q, tq: b.tq }));
    const rbuyList = rbuyEntries
      .filter(([tid]) => !excluded(tid))
      .map(([tid, b]) => ({ id: tid, p: b.p, q: b.q, tq: b.tq, sys: names[b.sys] || String(b.sys) }));
    writeFileSync(new URL("../trade.json", import.meta.url), JSON.stringify({
      generated: new Date().toISOString(),
      system: "XHQ-7V",
      items: tradeItems,
      losses,
      buys: buyList,
      rbuys: rbuyList,
    }));
    console.log(`Wrote trade.json: ${tradeItems.length} types, ${losses.length} ship loss types (${Object.values(lossCount).reduce((a, b) => a + b, 0)} losses/30d), ${buyList.length} buy-order types.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
