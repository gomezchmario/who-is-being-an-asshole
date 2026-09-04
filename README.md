# WHO IS BEING AN ASSHOLE?

A retro-CRT web app that scans the **XHQ-7V** market (Immortalis Fortizar, Providence)
and names every sell order priced more than **30% above Jita 4-4**.

- Public page: pure static HTML on GitHub Pages — visitors need no login.
- Data: a GitHub Actions cron job runs every 30 minutes with an EVE SSO refresh
  token (stored as repo secrets), pulls the structure market via ESI, compares
  against Jita 4-4 min-sell from [Janice](https://janice.e-351.com/) (falling
  back to the 5-day median when Jita is out of stock), and commits `data.json`.

## Setup

### 1. Create the EVE application

At [developers.eveonline.com/applications](https://developers.eveonline.com/applications):

- Connection type: **Authentication & API Access**
- Scope: `esi-markets.structure_markets.v1`
- Callback URL: `http://localhost:8787/callback`

### 2. Get a refresh token (one time, locally)

```bash
node scripts/get-token.mjs <CLIENT_ID> <CLIENT_SECRET>
```

Open the printed URL, log in with a character that has **docking access to the
Fortizar**, and copy the output.

### 3. Get a Janice API key

File a ticket on the [E-351 Discord](https://discord.gg/7McHR3r) to request an
API key. (For a quick test, the sample key from the
[Janice API docs](https://janice.e-351.com/api/docs) works, but get your own
for the recurring job.)

### 4. Create the GitHub repo

Push this folder to GitHub, then:

- **Settings → Secrets and variables → Actions**: add `EVE_CLIENT_ID`,
  `EVE_CLIENT_SECRET`, `EVE_REFRESH_TOKEN`, `JANICE_API_KEY`.
- **Settings → Pages**: deploy from branch `main`, folder `/ (root)`.
- **Actions tab**: run the *update market data* workflow once manually.

Done. The page updates itself every ~30 minutes.

## Local testing

Open `index.html?mock=1` for a rendering test with fake data, or run the
fetcher locally:

```bash
EVE_CLIENT_ID=... EVE_CLIENT_SECRET=... EVE_REFRESH_TOKEN=... JANICE_API_KEY=... node scripts/fetch-data.mjs
```

## Verdict tiers

| Markup over Jita | Verdict |
|---|---|
| below threshold (default 30%) | ░ HONEST |
| ≥ threshold | ▒ CHEEKY |
| ≥ 50% | ▓ DICK |
| ≥ 100% | █ ASSHOLE |
| ≥ 200% | █ GALACTIC ASSHOLE |

Notes: ESI keeps market orders anonymous, so the app shames orders, not pilots.
Items with no Jita sell orders are skipped. Not affiliated with CCP Games.
