// Pulse API — Cloudflare Worker (Day 2: backed by D1)
//
// Every route below queries the real D1 database bound as env.DB.
// Schema lives in ../schema.sql. JSON shapes returned are unchanged
// from Day 1 — the frontend needs no changes for this swap.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ---------- Auth helpers (PBKDF2 via Web Crypto — native to Workers, no external lib) ----------
function bytesToHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.substr(i * 2, 2), 16);
  return arr;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMaterial, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}
async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  return hash === hashHex;
}
function generateToken() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}
const TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
async function getUserFromToken(env, request) {
  const authHeader = request.headers.get('Authorization') || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.role, u.name, u.email_verified FROM auth_tokens t
     JOIN users u ON u.id = t.user_id WHERE t.token = ? AND t.expires_at > ?`
  ).bind(token, Date.now()).first();
  return row || null;
}
function publicUser(u) {
  return { id: u.id, email: u.email, role: u.role, name: u.name || null, emailVerified: !!u.email_verified };
}

// ---------- Email verification ----------
const VERIFICATION_CODE_LIFETIME_MS = 15 * 60 * 1000; // 15 min
function generateVerificationCode() {
  return String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
}
async function issueVerificationCode(env, userId) {
  const code = generateVerificationCode();
  await env.DB.prepare(
    'INSERT INTO verification_codes (user_id, code, created_at, expires_at) VALUES (?,?,?,?)'
  ).bind(userId, code, Date.now(), Date.now() + VERIFICATION_CODE_LIFETIME_MS).run();
  return code;
}
// Sends via Resend if RESEND_API_KEY + RESEND_FROM are configured (needs a
// verified domain — see schema.sql). Until then, this is a no-op that never
// throws, and the caller falls back to returning the code in the API
// response so the flow is fully testable without real email delivery.
async function sendVerificationEmail(env, toEmail, code) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [toEmail],
        subject: 'Your Pulse verification code',
        html: `<p>Your Pulse verification code is:</p><p style="font-size:28px; font-weight:700; letter-spacing:4px;">${code}</p><p>This code expires in 15 minutes.</p>`,
      }),
    });
    if (!res.ok) return { sent: false, reason: 'send_failed' };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: 'send_error' };
  }
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
    // Now requires a real, verified owner_claims row for this user + location —
    // previously this trusted any request (see schema.sql history for that note).
    if (path === '/api/owner-update' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const body = await request.json();
      const claim = await env.DB.prepare(
        'SELECT * FROM owner_claims WHERE user_id = ? AND location_id = ? AND verified = 1'
      ).bind(user.id, body.locationId).first();
      if (!claim) return json({ error: 'You do not have a verified claim on this location' }, 403);
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

    // GET /api/directions?from=lat,lng&to=lat,lng&profile=driving-car&alternatives=true
    // Proxies OpenRouteService so the API key never ships to the browser.
    // Requires a Worker secret: `wrangler secret put ORS_API_KEY` (free key from openrouteservice.org).
    // alternatives=true asks ORS for up to 3 route options (driving-car only — ORS only
    // supports alternatives for that profile with a single origin/destination pair).
    // ORS can reject alternative_routes for some origin/destination pairs (route too
    // long, no viable alternative under the share_factor, etc.) — if that happens we
    // silently retry without alternatives rather than failing the whole request.
    if (path === '/api/directions' && method === 'GET') {
      if (!env.ORS_API_KEY) return json({ error: 'Routing not configured — missing ORS_API_KEY secret' }, 500);

      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const profile = url.searchParams.get('profile') || 'driving-car';
      const wantAlternatives = url.searchParams.get('alternatives') === 'true';
      if (!from || !to) return json({ error: 'from and to query params are required, format lat,lng' }, 400);

      const [fromLat, fromLng] = from.split(',').map(Number);
      const [toLat, toLng] = to.split(',').map(Number);
      if ([fromLat, fromLng, toLat, toLng].some(n => Number.isNaN(n))) {
        return json({ error: 'invalid coordinates' }, 400);
      }

      const coordinates = [[fromLng, fromLat], [toLng, toLat]];

      async function callOrs(withAlternatives) {
        const reqBody = { coordinates };
        if (withAlternatives) {
          reqBody.alternative_routes = { target_count: 3, share_factor: 0.6, weight_factor: 1.4 };
        }
        const res = await fetch(`https://api.openrouteservice.org/v2/directions/${profile}/geojson`, {
          method: 'POST',
          headers: { 'Authorization': env.ORS_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
        });
        return res;
      }

      try {
        let orsRes = await callOrs(wantAlternatives && profile === 'driving-car');
        // Alternatives can be rejected for routes ORS can't find suitable alternates
        // for — retry once as a plain single-route request before giving up.
        if (!orsRes.ok && wantAlternatives) {
          orsRes = await callOrs(false);
        }
        if (!orsRes.ok) {
          const detail = await orsRes.text();
          return json({ error: 'Routing service error', detail: detail.slice(0, 300) }, 502);
        }
        const data = await orsRes.json();
        const features = data.features || [];
        if (!features.length) return json({ error: 'No route found' }, 404);

        const routes = features.map(feature => {
          const summary = feature.properties.summary || {};
          const steps = (feature.properties.segments || [])
            .flatMap(seg => seg.steps || [])
            .map(s => ({ instruction: s.instruction, distance: s.distance, duration: s.duration }));
          const geometry = feature.geometry.coordinates.map(([lng, lat]) => [lat, lng]); // GeoJSON is [lng,lat]; Leaflet wants [lat,lng]
          return {
            distanceMeters: Math.round(summary.distance || 0),
            durationSeconds: Math.round(summary.duration || 0),
            geometry,
            steps,
          };
        });
        // Old shape (distanceMeters/geometry/steps at top level) kept for any existing
        // caller — it's just routes[0]. New callers use `routes` for all options.
        return json({ ...routes[0], routes });
      } catch (e) {
        return json({ error: 'Routing request failed', detail: String(e) }, 500);
      }
    }

    // ---------- Auth ----------
    // POST /api/auth/signup  { email, password, name?, role? }
    if (path === '/api/auth/signup' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = (body.email || '').trim().toLowerCase();
      const password = body.password || '';
      if (!email || !email.includes('@')) return json({ error: 'A valid email is required' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);

      const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (existing) return json({ error: 'An account with that email already exists' }, 409);

      const role = body.role === 'business' ? 'business' : 'user';
      const { hash, salt } = await hashPassword(password);
      const result = await env.DB.prepare(
        'INSERT INTO users (email, password_hash, password_salt, role, name, created_at) VALUES (?,?,?,?,?,?)'
      ).bind(email, hash, salt, role, body.name || null, Date.now()).run();
      const userId = result.meta.last_row_id;

      const token = generateToken();
      await env.DB.prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
        .bind(token, userId, Date.now(), Date.now() + TOKEN_LIFETIME_MS).run();

      const code = await issueVerificationCode(env, userId);
      const sendResult = await sendVerificationEmail(env, email, code);

      const response = { token, user: publicUser({ id: userId, email, role, name: body.name || null, email_verified: 0 }), emailVerificationSent: sendResult.sent };
      if (!sendResult.sent) response.devVerificationCode = code; // only present when real email sending isn't configured yet
      return json(response);
    }

    // POST /api/auth/verify-email  { code }
    if (path === '/api/auth/verify-email' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const body = await request.json().catch(() => ({}));
      const code = (body.code || '').trim();
      if (!code) return json({ error: 'code is required' }, 400);

      const row = await env.DB.prepare(
        'SELECT * FROM verification_codes WHERE user_id = ? AND code = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1'
      ).bind(user.id, code, Date.now()).first();
      if (!row) return json({ error: 'That code is invalid or has expired' }, 400);

      await env.DB.prepare('UPDATE verification_codes SET used = 1 WHERE id = ?').bind(row.id).run();
      await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(user.id).run();
      return json({ ok: true });
    }

    // POST /api/auth/resend-verification
    if (path === '/api/auth/resend-verification' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      if (user.email_verified) return json({ ok: true, alreadyVerified: true });
      const code = await issueVerificationCode(env, user.id);
      const sendResult = await sendVerificationEmail(env, user.email, code);
      const response = { ok: true, emailVerificationSent: sendResult.sent };
      if (!sendResult.sent) response.devVerificationCode = code;
      return json(response);
    }

    // POST /api/auth/login  { email, password }
    if (path === '/api/auth/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const email = (body.email || '').trim().toLowerCase();
      const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
      if (!user) return json({ error: 'Invalid email or password' }, 401);
      const ok = await verifyPassword(body.password || '', user.password_salt, user.password_hash);
      if (!ok) return json({ error: 'Invalid email or password' }, 401);

      const token = generateToken();
      await env.DB.prepare('INSERT INTO auth_tokens (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
        .bind(token, user.id, Date.now(), Date.now() + TOKEN_LIFETIME_MS).run();

      return json({ token, user: publicUser(user) });
    }

    // POST /api/auth/logout
    if (path === '/api/auth/logout' && method === 'POST') {
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
      if (token) await env.DB.prepare('DELETE FROM auth_tokens WHERE token = ?').bind(token).run();
      return json({ ok: true });
    }

    // GET /api/auth/me
    if (path === '/api/auth/me' && method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      return json({ user: publicUser(user) });
    }

    // ---------- Per-account saved places & recent searches ----------
    // GET /api/saved
    if (path === '/api/saved' && method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const rows = await env.DB.prepare('SELECT * FROM saved_items WHERE user_id = ? ORDER BY saved_at DESC').bind(user.id).all();
      return json({ items: rows.results });
    }

    // POST /api/saved  { collection, locationId? , customName?, customLat?, customLng? }
    if (path === '/api/saved' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.collection) return json({ error: 'collection is required' }, 400);
      await env.DB.prepare(
        `INSERT INTO saved_items (user_id, collection, location_id, custom_name, custom_lat, custom_lng, saved_at)
         VALUES (?,?,?,?,?,?,?)`
      ).bind(user.id, body.collection, body.locationId || null, body.customName || null, body.customLat || null, body.customLng || null, Date.now()).run();
      return json({ ok: true });
    }

    // DELETE /api/saved?id=123
    if (path === '/api/saved' && method === 'DELETE') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const id = url.searchParams.get('id');
      if (!id) return json({ error: 'id is required' }, 400);
      await env.DB.prepare('DELETE FROM saved_items WHERE id = ? AND user_id = ?').bind(id, user.id).run();
      return json({ ok: true });
    }

    // GET /api/recent-searches
    if (path === '/api/recent-searches' && method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const rows = await env.DB.prepare('SELECT * FROM recent_searches WHERE user_id = ? ORDER BY searched_at DESC LIMIT 10').bind(user.id).all();
      return json({ items: rows.results });
    }

    // POST /api/recent-searches  { label, lat, lng }
    if (path === '/api/recent-searches' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const body = await request.json().catch(() => ({}));
      if (!body.label) return json({ error: 'label is required' }, 400);
      await env.DB.prepare('INSERT INTO recent_searches (user_id, label, lat, lng, searched_at) VALUES (?,?,?,?,?)')
        .bind(user.id, body.label, body.lat || null, body.lng || null, Date.now()).run();
      return json({ ok: true });
    }

    // ---------- Business: claim a store ----------
    // POST /api/owner/claim  { locationId, contact }
    if (path === '/api/owner/claim' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      if (user.role !== 'business') return json({ error: 'Only business accounts can claim a store' }, 403);
      if (!user.email_verified) return json({ error: 'Verify your email before claiming a store' }, 403);
      const body = await request.json().catch(() => ({}));
      if (!body.locationId) return json({ error: 'locationId is required' }, 400);
      await env.DB.prepare(
        'INSERT INTO owner_claims (location_id, owner_contact, user_id, verified) VALUES (?,?,?,0)'
      ).bind(body.locationId, body.contact || user.email, user.id).run();
      return json({ ok: true, note: 'Claim submitted — pending verification' });
    }

    // GET /api/owner/locations — stores this business account can manage
    if (path === '/api/owner/locations' && method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      const rows = await env.DB.prepare(
        `SELECT l.*, oc.verified AS claim_verified FROM owner_claims oc
         JOIN locations l ON l.id = oc.location_id WHERE oc.user_id = ?`
      ).bind(user.id).all();
      return json({ locations: rows.results.map(mapLocation) });
    }

    // ---------- Admin: review pending store claims ----------
    // There's no signup path to role='admin' — promote an account directly
    // in the D1 console: UPDATE users SET role='admin' WHERE email='you@example.com';

    // GET /api/admin/claims — pending claims, joined with location + claimant info
    if (path === '/api/admin/claims' && method === 'GET') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      if (user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      const rows = await env.DB.prepare(
        `SELECT oc.id, oc.owner_contact, oc.created_at, l.id AS location_id, l.name AS location_name,
                u.email AS claimant_email, u.name AS claimant_name
         FROM owner_claims oc
         JOIN locations l ON l.id = oc.location_id
         LEFT JOIN users u ON u.id = oc.user_id
         WHERE oc.verified = 0 ORDER BY oc.id DESC`
      ).all();
      return json({ claims: rows.results });
    }

    // POST /api/admin/claims/approve  { claimId }
    if (path === '/api/admin/claims/approve' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      if (user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      const body = await request.json().catch(() => ({}));
      if (!body.claimId) return json({ error: 'claimId is required' }, 400);
      await env.DB.prepare('UPDATE owner_claims SET verified = 1 WHERE id = ?').bind(body.claimId).run();
      return json({ ok: true });
    }

    // POST /api/admin/claims/reject  { claimId }
    if (path === '/api/admin/claims/reject' && method === 'POST') {
      const user = await getUserFromToken(env, request);
      if (!user) return json({ error: 'Not authenticated' }, 401);
      if (user.role !== 'admin') return json({ error: 'Admin access required' }, 403);
      const body = await request.json().catch(() => ({}));
      if (!body.claimId) return json({ error: 'claimId is required' }, 400);
      await env.DB.prepare('DELETE FROM owner_claims WHERE id = ?').bind(body.claimId).run();
      return json({ ok: true });
    }

    // GET /api/busy-times?locationId=X
    // Real hour-of-day pattern from this location's actual check-in history.
    // No data yet for a location -> hasData:false, not a guessed pattern.
    if (path === '/api/busy-times' && method === 'GET') {
      const locationId = url.searchParams.get('locationId');
      if (!locationId) return json({ error: 'locationId is required' }, 400);
      const rows = await env.DB.prepare(
        `SELECT CAST(strftime('%H', datetime(created_at/1000,'unixepoch')) AS INTEGER) AS hour,
                AVG(minutes) AS avgWait, COUNT(*) AS n
         FROM checkins WHERE location_id = ? AND minutes IS NOT NULL
         GROUP BY hour ORDER BY hour`
      ).bind(locationId).all();
      const buckets = rows.results.map(r => ({ hour: r.hour, avgWait: Math.round(r.avgWait), count: r.n }));
      if (!buckets.length) return json({ locationId, hasData: false, buckets: [] });
      const busiest = buckets.reduce((a, b) => (b.avgWait > a.avgWait ? b : a), buckets[0]);
      return json({ locationId, hasData: true, buckets, busiestHour: busiest.hour, busiestAvgWait: busiest.avgWait });
    }

    // GET /api/busy-roads
    // Real hour-of-day jam pattern across all roads, from actual road_reports history.
    if (path === '/api/busy-roads' && method === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT name, CAST(strftime('%H', datetime(created_at/1000,'unixepoch')) AS INTEGER) AS hour, COUNT(*) AS n
         FROM road_reports WHERE type IN ('jam','closure')
         GROUP BY name, hour ORDER BY name, hour`
      ).all();
      if (!rows.results.length) return json({ hasData: false, roads: [] });
      const byRoad = {};
      rows.results.forEach(r => {
        if (!byRoad[r.name]) byRoad[r.name] = [];
        byRoad[r.name].push({ hour: r.hour, count: r.n });
      });
      const roads = Object.entries(byRoad).map(([name, buckets]) => {
        const busiest = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
        return { name, buckets, busiestHour: busiest.hour, reportCount: buckets.reduce((s, b) => s + b.count, 0) };
      });
      return json({ hasData: true, roads });
    }

    return json({ error: 'not found', path }, 404);
  },
};
