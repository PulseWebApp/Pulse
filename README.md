# Pulse — real-time local conditions

Live wait times at nearby shops, clinics, and gas stations; crowd-reported
road hazards, closures, and traffic-signal states; and a business-owner
portal so shops can self-report their own status. Built for **RLC Hacks
2026**.

**Live app:** https://pulse-app.asadzahid100.workers.dev
**API:** https://pulse.as4dzahid.workers.dev

## What's built

- **Real-time feed** — wait times, live-user counts (distinct sessions
  seen in the last 2 minutes), and crowd check-ins per location, backed
  by Cloudflare D1 (not hardcoded demo data).
- **Auth** — email/password signup with 6-digit email verification,
  PBKDF2-SHA256 hashing via native Web Crypto, bearer-token sessions.
  Guest mode also available.
- **Verified business-owner updates** — an owner can only update a
  location's status after their claim on it is verified
  (`owner_claims` table); unverified or mismatched claims are rejected
  server-side.
- **Road & signal reporting** — crowd-sourced hazards, closures, jams,
  and traffic-signal state, with confirm/clear voting.
- **Real analytics** — busiest times and busiest areas computed from
  actual check-in and report history, never fabricated.
- **Directions** — multi-route options via OpenRouteService, with
  traffic warnings sourced from real user reports, typed-origin
  geocoding via Nominatim, and drive/walk/bike/transit modes.
- **Full settings & personalization** — profile with photo upload,
  notifications, theme (light/dark/system), accent color, map style
  (standard/dark/satellite), saved places, recent searches.
- **8-language i18n** — English, Chinese, Hindi, Spanish, French,
  Arabic, Urdu, Portuguese. RTL languages translate text only; layout
  stays fixed LTR by design.

## Stack

- **Frontend**: single static `frontend/index.html` (vanilla HTML/CSS/JS,
  no build step, no framework), Leaflet.js for the map.
- **Backend**: Cloudflare Worker (`worker/src/index.js`) exposing a
  JSON API under `/api/*`.
- **Database**: Cloudflare D1 (SQLite-compatible); schema in
  `worker/schema.sql`.

## Map attribution

Map tiles are provided by OpenStreetMap, CARTO, and Esri ArcGIS World
Imagery (satellite mode). Attribution is displayed on the map itself per
each provider's terms of use.

## Deploying the API (Worker)

```bash
cd worker
npm install -g wrangler   # if not already installed
wrangler login
wrangler deploy
```

Set the following as Worker secrets for full functionality:
- `RESEND_API_KEY` — verification emails (signup still works without it;
  falls back to returning the code directly in the API response)
- `OPENROUTESERVICE_API_KEY` — turn-by-turn directions

### Database (D1)

```bash
wrangler d1 create pulse-db
# copy the database_id into wrangler.toml's [[d1_databases]] block

wrangler d1 execute pulse-db --file=schema.sql
wrangler deploy
```

**Important:** don't re-run the full `schema.sql` against a live database
— its seed `INSERT` statements aren't idempotent and will duplicate data.
For schema changes, run only the new `ALTER TABLE` statement needed,
after checking current state with `PRAGMA table_info(<table>)`.

## Deploying the frontend

```bash
cd frontend
wrangler pages deploy .
```

`API_BASE` in `frontend/index.html` points at the deployed Worker API and
is the source of truth for what the frontend calls.

## Verifying it's publicly accessible

Open the deployed frontend URL in an incognito/private window, logged out
of everything. It should load and work fully.

## Known gaps (disclosed, not hidden)

- **Overpass "Nearby Places" doesn't refresh on map pan** — the fetch
  runs once on load, centered on the initial location. Panning far away
  won't show new places until reload or a new search. A pan-triggered
  refresh was discussed but not built in the hackathon timeline.
- **Signal-state and hazard reports aren't fact-checked** — they're
  crowd-confirmed only, same trust model as Waze.
- **i18n coverage is broad but not guaranteed exhaustive** — any UI
  surface not explicitly verified may still have untranslated strings.
- **Map tile labels (street/place names on the tiles themselves) aren't
  translatable** — the free CARTO raster tiles don't support it; a paid
  vector-tile provider would be needed to fix this.
- **No real-time traffic data** — would require a paid API beyond the
  hackathon's scope.

## AI disclosure

AI coding assistants were used throughout development — architecture
decisions, the backend API and database schema, frontend UI, the auth
system, i18n, analytics, and debugging — with the team directing
requirements, testing, and final decisions.
