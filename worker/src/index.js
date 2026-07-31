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
  return {
    id: row.id, name: row.name, category: row.category, icon: row.icon,
    distance: row.distance, status: row.status, minutes: row.minutes,
    confirms: row.confirms, updated: timeAgo(row.updated_at),
    ownerOwned: !!row.owner_owned, ownerVerified: !!row.owner_verified,
    note: row.note, x: row.x, y: row.y,
    ratingAvg, ratingCount,
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
      const [locs, roads, sigs] = await Promise.all([
        env.DB.prepare('SELECT * FROM locations ORDER BY id').all(),
        env.DB.prepare('SELECT * FROM road_reports ORDER BY id DESC').all(),
        env.DB.prepare('SELECT * FROM signals ORDER BY id').all(),
      ]);
      return json({
        locations: locs.results.map(mapLocation),
        roadReports: roads.results.map(mapRoadReport),
        signals: sigs.results.map(mapSignal),
      });
    }

    // POST /api/checkin  { locationId, minutes, status }
    if (path === '/api/checkin' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE locations SET minutes=?, status=?, confirms=confirms+1, updated_at=? WHERE id=?'
      ).bind(body.minutes, body.status, Date.now(), body.locationId).run();
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

    // POST /api/owner-update  { locationId, status, note }
    if (path === '/api/owner-update' && method === 'POST') {
      const body = await request.json();
      await env.DB.prepare(
        'UPDATE locations SET status=?, note=?, updated_at=?, owner_verified=1 WHERE id=?'
      ).bind(body.status, body.note, Date.now(), body.locationId).run();
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

    return json({ error: 'not found', path }, 404);
  },
};
