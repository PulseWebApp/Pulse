# Pulse — hackathon build

Real-time local conditions: wait times at nearby shops/clinics/gas
stations, road hazards and closures, and crowd-reported signal
states — plus a business-owner portal so shops can self-report.

## Current status: Day 1

The Worker API (`/worker`) is deployed and returns real (if
hardcoded) data. The frontend (`/frontend`) calls it over `fetch`,
with a graceful fallback to local demo data if the API is
unreachable — so the app never shows a blank screen, even mid-build.

D1 (the real database) is not wired in yet — that's Day 2. See
`worker/schema.sql` for the schema already written and ready to go.

## Deploying the API (Worker)

```bash
cd worker
npm install -g wrangler   # if not already installed
wrangler login
wrangler deploy
```

This gives you a URL like `https://pulse-api.<you>.workers.dev`.
Test it directly: `curl https://pulse-api.<you>.workers.dev/api/feed`
should return JSON.

### Day 2: switching from hardcoded data to D1

```bash
wrangler d1 create pulse-db
# copy the database_id it prints into wrangler.toml, uncomment the
# [[d1_databases]] block

wrangler d1 execute pulse-db --file=schema.sql

wrangler deploy
```

Then in `worker/src/index.js`, replace the `DEMO_DATA` reads/writes
in each route with `env.DB.prepare(...)` queries. The JSON shape
each route returns should stay the same — the frontend is already
built against it.

## Deploying the frontend

Any static host works (Cloudflare Pages, Vercel, Netlify). Simplest
with Wrangler:

```bash
cd frontend
wrangler pages deploy .
```

Before deploying (or redeploying after the API is live), open
`frontend/index.html` and set:

```js
const API_BASE = 'https://pulse-api.<you>.workers.dev';
```

If you leave `API_BASE` empty, the app still works — it just runs
entirely on local demo data with a visible "Demo mode" banner.

## Verifying it's actually public

Before submitting: open the deployed frontend URL in an incognito /
private browser window (logged out of everything). If it loads and
works there, it satisfies requirement #1.

## Known gaps (say these out loud if a judge asks, don't hide them)

- No real auth on the owner-update route yet — anyone could currently
  claim to be a business owner. `owner_claims` table in schema.sql is
  the intended fix (claim via phone/email verification), not built
  yet given the timeline.
- Signal-state and hazard reports aren't fact-checked — they're
  crowd-confirmed only, same trust model as Waze.
- Map is a stylized illustration, not a real map SDK (Google
  Maps/Mapbox) — deliberate choice to avoid API key management and
  extra integration time this week.
