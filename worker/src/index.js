// Pulse API — Cloudflare Worker (Day 2: backed by D1)
//
// Every route below queries the real D1 database bound as env.DB.
// Schema lives in ../schema.sql. JSON shapes returned are unchanged
// from Day 1 — the frontend needs no changes for this swap.

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

function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return s + ' sec ago';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min ago';
  return Math.round(m / 60) + ' hr ago';
}

function mapLocation(row) {
  const ratingCount = row.rating_count || 0;
  const ratingAvg = ratingCount > 0 ? Math.round((row.rating_sum / ratingCount) * 10) / 10 : null;
  const crowdCount = row.crowd_count || 0;
  const crowdLevel = crowdCount >= 5 ? 'High' : crowdCount >= 2 ? 'Medium' : crowdCount >= 1 ? 'Low' : null;
  return {
    id: row.id, name: row.name, category: row.category, icon: row.icon,
    distance: row.distance, status: row.status, minutes: row.minutes,
    confirms: row.confirms, updated: timeAgo(row.updated_at),
    ownerOwned: !!row.owner_owned, ownerVerified: !!row.owner_verified,
    note: row.note, x: row.x, y: row.y,
    ratingAvg, ratingCount,
    photoUrl: row.photo_url || null,
    crowdLevel, crowdCount,
  };
}
function mapRoadReport(row) {
  return {
    id: row.id, name: row.name, type: row.type, icon: row.icon,
    detail: row.detail, confirms: row.confirms,
    updated: timeAgo(row.created_at), x: row.x, y: row.y,
  };
}
function mapSignal(row) {
  return {
    id: row.id, name: row.name, color: row.color,
    reportedAt: row.reported_at, confirms: row.confirms, x: row.x, y: row.y,
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });
    if (!env.DB) return json({ error: 'D1 not bound yet — check wrangler.toml' }, 500);

    // GET /api/feed
    if (path === '/api/feed' && method === 'GET') {
      const crowdWindowStart = Date.now() - (2 * 60 * 60 * 1000); // last 2 hours
      const liveWindowStart = Date.now() - (2 * 60 * 1000); // last 2 minutes
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);
      const todayStart = startOfToday.getTime();

      const [locs, roads, sigs, liveUsersRow, reportsTodayRow, verifiedRow] = await Promise.all([
        env.DB.prepare(
          `SELECT l.*, (SELECT COUNT(*) FROM checkins c WHERE c.location_id = l.id AND c.created_at > ?) AS crowd_count
           FROM locations l ORDER BY l.id`
        ).bind(crowdWindowStart).all(),
        env.DB.prepare('SELECT * FROM road_reports ORDER BY id DESC').all(),
        env.DB.prepare('SELECT * FROM signals ORDER BY id').all(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE last_seen > ?').bind(liveWindowStart).first(),
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM checkins WHERE created_at > ?) +
             (SELECT COUNT(*) FROM road_reports WHERE created_at > ?) +
             (SELECT COUNT(*) FROM signals WHERE reported_at > ?) AS n`
        ).bind(todayStart, todayStart, todayStart).first(),
        env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM locations WHERE owner_verified = 1) AS verified,
             (SELECT COUNT(*) FROM locations) AS total`
        ).first(),
      ]);

      const verifiedPct = verifiedRow.total > 0 ? Math.round((verifiedRow.verified / verifiedRow.total) * 100) : 0;

      return json({
        locations: locs.results.map(mapLocation),
        roadReports: roads.results.map(mapRoadReport),
        signals: sigs.results.map(mapSignal),
        stats: {
          liveUsers: liveUsersRow.n || 0,
          reportsToday: reportsTodayRow.n || 0,
          verifiedPct,
        },
      });
    }

    // POST /api/heartbeat  { sessionId }
    if (path === '/api/heartbeat' && method === 'POST') {
      const body = await request.json();
      if (!body.sessionId) return json({ error: 'sessionId required' }, 400);
      await env.DB.prepare(
        'INSERT INTO sessions (id, last_seen) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen'
      ).bind(body.sessionId, Date.now()).run();
      return json({ ok: true });
    }

    // POST /api/checkin  { locationId, minutes, status }
    if (path === '/api/checkin' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE locations SET minutes=?, status=?, confirms=confirms+1, updated_at=? WHERE id=?'
      ).bind(body.minutes, body.status, Date.now(), body.locationId).run();
      await env.DB.prepare(
        'INSERT INTO checkins (location_id, minutes, status, created_at) VALUES (?,?,?,?)'
      ).bind(body.locationId, body.minutes, body.status, Date.now()).run();
      return json({ ok: true });
    }

    // POST /api/report  { kind, name, detail, x, y }
    if (path === '/api/report' && method === 'POST') {
      const body = await request.json();
      const id = Date.now();
      if (body.kind === 'wait') {
        await env.DB.prepare(
          `INSERT INTO locations (id,name,category,icon,distance,status,minutes,confirms,updated_at,owner_owned,owner_verified,note,x,y)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(id, body.name || 'New spot', 'errand', 'ti-map-pin', 'nearby', 'amber', 10, 1, Date.now(), 0, 0, null, body.x || 100, body.y || 70).run();
        return json({ ok: true, id });
      }
      const kindMap = {
        signal: { type: 'hazard', icon: 'ti-traffic-cone' },
        closure: { type: 'closure', icon: 'ti-road-off' },
        jam: { type: 'jam', icon: 'ti-car' },
        police: { type: 'police', icon: 'ti-shield' },
        camera: { type: 'camera', icon: 'ti-camera' },
      };
      const k = kindMap[body.kind] || { type: 'hazard', icon: 'ti-alert-triangle' };
      await env.DB.prepare(
        `INSERT INTO road_reports (id,name,type,icon,detail,confirms,created_at,x,y)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(id, body.name || 'New report', k.type, k.icon, body.detail || 'Reported just now', 1, Date.now(), body.x || 200, body.y || 230).run();
      return json({ ok: true, id });
    }

    // POST /api/road-confirm  { id }
    if (path === '/api/road-confirm' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE road_reports SET confirms=confirms+1, created_at=? WHERE id=?'
      ).bind(Date.now(), body.id).run();
      return json({ ok: true });
    }

    // POST /api/road-clear  { id }
    if (path === '/api/road-clear' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare('DELETE FROM road_reports WHERE id=?').bind(body.id).run();
      return json({ ok: true });
    }

    // POST /api/signal-report  { id?, name?, color, x?, y? }
    if (path === '/api/signal-report' && method === 'POST') {
      const body = await request.json();
      if (body.id) {
        await env.DB.prepare(
          'UPDATE signals SET color=?, reported_at=?, confirms=confirms+1 WHERE id=?'
        ).bind(body.color, Date.now(), body.id).run();
        return json({ ok: true });
      }
      const id = Date.now();
      await env.DB.prepare(
        `INSERT INTO signals (id,name,color,reported_at,confirms,x,y) VALUES (?,?,?,?,?,?,?)`
      ).bind(id, body.name || 'New intersection', body.color || 'red', Date.now(), 1, body.x || 150, body.y || 150).run();
      return json({ ok: true, id });
    }

    // POST /api/owner-update  { locationId, status, note, photoUrl }
    if (path === '/api/owner-update' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE locations SET status=?, note=?, photo_url=?, updated_at=?, owner_verified=1 WHERE id=?'
      ).bind(body.status, body.note, body.photoUrl || null, Date.now(), body.locationId).run();
      return json({ ok: true });
    }

    // POST /api/rate  { locationId, stars }  — stars is 1-5
    if (path === '/api/rate' && method === 'POST') {
      const body = await request.json();
      const stars = Math.max(1, Math.min(5, Math.round(body.stars)));
      await env.DB.prepare(
        'UPDATE locations SET rating_sum=rating_sum+?, rating_count=rating_count+1 WHERE id=?'
      ).bind(stars, body.locationId).run();
      return json({ ok: true });
    }

    // GET /api/location-history?locationId=X — last 8 real check-ins for the wait-time sparkline
    if (path === '/api/location-history' && method === 'GET') {
      const locationId = url.searchParams.get('locationId');
      const rows = await env.DB.prepare(
        'SELECT minutes, created_at FROM checkins WHERE location_id=? ORDER BY created_at DESC LIMIT 8'
      ).bind(locationId).all();
      const points = rows.results.reverse().map(r => ({ minutes: r.minutes, createdAt: r.created_at }));
      return json({ points });
    }

    // GET /api/analytics — real aggregation from checkins + road_reports, no fake numbers
    if (path === '/api/analytics' && method === 'GET') {
      const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);

      const [dailyRows, hourlyRows, busiestRows, reportTypeRows] = await Promise.all([
        // Average wait per day, last 7 days that actually have data
        env.DB.prepare(
          `SELECT date(created_at/1000, 'unixepoch') AS day, AVG(minutes) AS avg_min, COUNT(*) AS n
           FROM checkins WHERE created_at > ? GROUP BY day ORDER BY day ASC`
        ).bind(sevenDaysAgo).all(),
        // Check-in count per hour of day (0-23), all-time
        env.DB.prepare(
          `SELECT CAST(strftime('%H', created_at/1000, 'unixepoch') AS INTEGER) AS hr, COUNT(*) AS n
           FROM checkins GROUP BY hr ORDER BY hr ASC`
        ).all(),
        // Busiest locations by check-in volume
        env.DB.prepare(
          `SELECT l.name, COUNT(c.id) AS n, AVG(c.minutes) AS avg_min
           FROM checkins c JOIN locations l ON l.id = c.location_id
           GROUP BY c.location_id ORDER BY n DESC LIMIT 5`
        ).all(),
        // Road reports grouped by real type
        env.DB.prepare('SELECT type, COUNT(*) AS n FROM road_reports GROUP BY type').all(),
      ]);

      return json({
        dailyAvgWait: dailyRows.results.map(r => ({ day: r.day, avgMinutes: Math.round(r.avg_min), count: r.n })),
        hourlyCheckins: hourlyRows.results.map(r => ({ hour: r.hr, count: r.n })),
        busiestLocations: busiestRows.results.map(r => ({ name: r.name, checkins: r.n, avgMinutes: Math.round(r.avg_min) })),
        reportsByType: reportTypeRows.results.map(r => ({ type: r.type, count: r.n })),
      });
    }

    return json({ error: 'not found', path }, 404);
  },
};
