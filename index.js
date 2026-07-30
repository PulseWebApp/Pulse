// Pulse API — Cloudflare Worker
//
// DAY 1 STATE: routes are real and wired up, but data lives in the
// DEMO_DATA object below instead of D1. This lets the frontend and
// deployment pipeline be proven end-to-end today.
//
// DAY 2 TODO (teammate): replace the DEMO_DATA reads/writes in each
// handler with real D1 queries against the tables in ../schema.sql.
// The JSON shape returned by each route should NOT change — the
// frontend is already built against this shape.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---- DAY 1 in-memory demo data (mirrors schema.sql seed rows) ----
let DEMO_DATA = {
  locations: [
    { id: 1, name: 'Eastside pharmacy', category: 'health', icon: 'ti-first-aid-kit', distance: '0.4 mi', status: 'green', minutes: 4, confirms: 6, updated: '40 sec ago', ownerOwned: false, ownerVerified: false, x: 100, y: 70 },
    { id: 2, name: 'City DMV branch', category: 'service', icon: 'ti-building-bank', distance: '1.1 mi', status: 'amber', minutes: 38, confirms: 21, updated: '2 min ago', ownerOwned: false, ownerVerified: false, x: 105, y: 205 },
    { id: 3, name: 'Riverside urgent care', category: 'health', icon: 'ti-stethoscope', distance: '0.8 mi', status: 'red', minutes: 57, confirms: 14, updated: '5 min ago', ownerOwned: false, ownerVerified: false, x: 245, y: 325 },
    { id: 4, name: 'Northgate laundromat', category: 'errand', icon: 'ti-wash', distance: '0.6 mi', status: 'green', minutes: 2, confirms: 3, updated: '6 min ago', ownerOwned: false, ownerVerified: false, x: 100, y: 430 },
    { id: 5, name: 'Shell station, Main St', category: 'fuel', icon: 'ti-gas-station', distance: '0.5 mi', status: 'amber', minutes: 12, confirms: 0, updated: '1 min ago', ownerOwned: true, ownerVerified: true, note: '2 pumps closed for maintenance', x: 250, y: 70 },
    { id: 6, name: 'Bilal barbershop', category: 'service', icon: 'ti-scissors', distance: '0.3 mi', status: 'red', minutes: 45, confirms: 0, updated: '3 min ago', ownerOwned: true, ownerVerified: true, note: '3 people ahead, walk-ins only', x: 57, y: 335 },
    { id: 7, name: 'Ranchers Restaurant', category: 'food', icon: 'ti-tools-kitchen-2', distance: '0.3 mi', status: 'green', minutes: 5, confirms: 8, updated: '2 min ago', ownerOwned: false, ownerVerified: false, x: 180, y: 115 },
    { id: 8, name: 'Layers Bakeshop', category: 'food', icon: 'ti-bread', distance: '0.5 mi', status: 'amber', minutes: 15, confirms: 4, updated: '3 min ago', ownerOwned: false, ownerVerified: false, x: 122, y: 310 },
  ],
  roadReports: [
    { id: 101, name: 'Signal down, 9th St and Elm St', type: 'hazard', icon: 'ti-traffic-cone', detail: 'Treat as 4-way stop', updated: '12 min ago', confirms: 9, x: 45, y: 395 },
    { id: 102, name: 'Highway 9 closed near Main St', type: 'closure', icon: 'ti-road-off', detail: 'Water main repair, est. clears 6:00 PM', updated: '21 min ago', confirms: 21, x: 250, y: 219 },
    { id: 103, name: 'Slow on Highway 9, eastbound', type: 'jam', icon: 'ti-car', detail: 'Adds about 15 min', updated: '4 min ago', confirms: 6, x: 300, y: 203 },
    { id: 104, name: 'Police reported, Main St', type: 'police', icon: 'ti-shield', detail: 'North end, near 2nd Ave', updated: '8 min ago', confirms: 30, x: 150, y: 40 },
    { id: 105, name: 'Speed camera, 2nd Ave', type: 'camera', icon: 'ti-camera', detail: 'Fixed location', updated: 'confirmed by many', confirms: 34, x: 280, y: 150 },
  ],
  signals: [
    { id: 201, name: 'Main St and 2nd Ave', color: 'red', reportedAt: Date.now() - 40000, confirms: 3, x: 150, y: 150 },
    { id: 202, name: 'Highway 9 and Main St', color: 'green', reportedAt: Date.now() - 15000, confirms: 5, x: 150, y: 252 },
    { id: 203, name: '9th St and 2nd Ave', color: 'red', reportedAt: Date.now() - 95000, confirms: 1, x: 54, y: 150 },
  ],
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    // GET /api/feed — everything the resident app needs on load
    if (path === '/api/feed' && method === 'GET') {
      return json(DEMO_DATA);
    }

    // POST /api/checkin  { locationId, minutes, status }
    if (path === '/api/checkin' && method === 'POST') {
      const body = await request.json();
      const loc = DEMO_DATA.locations.find(l => l.id === body.locationId);
      if (!loc) return json({ error: 'not found' }, 404);
      loc.minutes = body.minutes;
      loc.status = body.status;
      loc.confirms += 1;
      loc.updated = 'just now';
      return json({ ok: true, location: loc });
    }

    // POST /api/report  { kind: 'wait'|'hazard'|'closure'|'jam'|'police'|'camera', ...fields }
    if (path === '/api/report' && method === 'POST') {
      const body = await request.json();
      const id = Date.now();
      if (body.kind === 'wait') {
        const loc = { id, name: body.name || 'New spot', category: 'errand', icon: 'ti-map-pin', distance: 'nearby', status: 'amber', minutes: 10, confirms: 1, updated: 'just now', ownerOwned: false, ownerVerified: false, x: 100, y: 70 };
        DEMO_DATA.locations.unshift(loc);
        return json({ ok: true, location: loc });
      }
      const iconMap = { hazard: 'ti-traffic-cone', closure: 'ti-road-off', jam: 'ti-car', police: 'ti-shield', camera: 'ti-camera' };
      const report = { id, name: body.name || 'New report', type: body.kind, icon: iconMap[body.kind] || 'ti-alert-triangle', detail: body.detail || 'Reported just now', updated: 'just now', confirms: 1, x: body.x || 200, y: body.y || 230 };
      DEMO_DATA.roadReports.unshift(report);
      return json({ ok: true, report });
    }

    // POST /api/road-confirm  { id }  — "still there"
    if (path === '/api/road-confirm' && method === 'POST') {
      const body = await request.json();
      const r = DEMO_DATA.roadReports.find(x => x.id === body.id);
      if (!r) return json({ error: 'not found' }, 404);
      r.confirms += 1; r.updated = 'just now';
      return json({ ok: true, report: r });
    }

    // POST /api/road-clear  { id }  — "it's cleared"
    if (path === '/api/road-clear' && method === 'POST') {
      const body = await request.json();
      DEMO_DATA.roadReports = DEMO_DATA.roadReports.filter(x => x.id !== body.id);
      return json({ ok: true });
    }

    // POST /api/signal-report  { id, color } or { name, color } to create new
    if (path === '/api/signal-report' && method === 'POST') {
      const body = await request.json();
      let s = DEMO_DATA.signals.find(x => x.id === body.id);
      if (s) {
        s.color = body.color; s.reportedAt = Date.now(); s.confirms += 1;
      } else {
        s = { id: Date.now(), name: body.name || 'New intersection', color: body.color || 'red', reportedAt: Date.now(), confirms: 1, x: body.x || 150, y: body.y || 150 };
        DEMO_DATA.signals.unshift(s);
      }
      return json({ ok: true, signal: s });
    }

    // POST /api/owner-update  { locationId, status, note }
    if (path === '/api/owner-update' && method === 'POST') {
      const body = await request.json();
      const loc = DEMO_DATA.locations.find(l => l.id === body.locationId);
      if (!loc) return json({ error: 'not found' }, 404);
      loc.status = body.status;
      loc.note = body.note;
      loc.updated = 'Updated by owner \u00b7 just now';
      loc.ownerVerified = true;
      return json({ ok: true, location: loc });
    }

    return json({ error: 'not found', path }, 404);
  },
};
