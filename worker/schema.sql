-- Pulse D1 schema — for Day 2.
-- Run with: wrangler d1 execute pulse-db --file=schema.sql
-- Field names deliberately match the JSON the Worker already returns
-- in src/index.js's DEMO_DATA, so swapping DEMO_DATA reads for real
-- queries should be a near 1:1 mapping.

CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,       -- food | fuel | health | service | errand
  icon TEXT NOT NULL,           -- tabler icon class, e.g. ti-gas-station
  distance TEXT,
  status TEXT NOT NULL,         -- green | amber | red
  minutes INTEGER NOT NULL,
  confirms INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL,  -- unix ms; compute "x ago" at read time
  owner_owned INTEGER DEFAULT 0,
  owner_verified INTEGER DEFAULT 0,
  note TEXT,
  photo_url TEXT,                -- optional, set by owner via /api/owner-update
  x INTEGER, y INTEGER
);

-- Every check-in is now logged individually (not just aggregated into
-- locations.confirms) so /api/feed can compute a real "how many people
-- have checked in recently" live-crowd figure per place, instead of a
-- fake number.
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  minutes INTEGER,
  status TEXT,
  created_at INTEGER NOT NULL
);

-- Live-user tracking: each browser pings /api/heartbeat every 30s with a
-- random session id it generates once and stores in localStorage. "Live
-- users" is computed as distinct sessions seen in the last 2 minutes —
-- a real number, not a placeholder.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);

-- MIGRATION — if pulse-db already exists, just run:
--   CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS road_reports (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,           -- hazard | closure | jam | police | camera
  icon TEXT NOT NULL,
  detail TEXT,
  confirms INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  x INTEGER, y INTEGER
);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,          -- red | green
  reported_at INTEGER NOT NULL, -- unix ms — this IS the freshness timestamp
  confirms INTEGER DEFAULT 1,
  x INTEGER, y INTEGER
);

-- Owner claims: who can post owner-verified updates for which location.
-- user_id links a claim to a real account (see users/auth_tokens below) —
-- this closes the gap the comment used to flag; /api/owner-update now
-- checks this table against the bearer token before allowing an update.
CREATE TABLE IF NOT EXISTS owner_claims (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  owner_contact TEXT NOT NULL,  -- phone or email used to claim it
  user_id INTEGER REFERENCES users(id),
  verified INTEGER DEFAULT 0
);

-- ---------- Accounts (login/signup, guest mode stays fully unauthenticated) ----------
-- Passwords are hashed with PBKDF2-SHA256 (Web Crypto, native to Workers —
-- no external library). role='business' accounts can claim locations via
-- owner_claims above and post real owner-verified updates for just those.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'business'
  name TEXT,
  email_verified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 6-digit codes, short-lived. Sent via email once a domain + RESEND_API_KEY
-- are configured (see worker/src/index.js sendVerificationEmail) — until
-- then, signup returns the code directly in the response so the flow is
-- fully testable without real email delivery.
CREATE TABLE IF NOT EXISTS verification_codes (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  code TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);

-- Bearer tokens (sent as Authorization: Bearer <token>), not cookies —
-- avoids cross-subdomain SameSite issues since the frontend and API
-- Workers live on different *.workers.dev hosts.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Saved places, now per-account instead of only localStorage. A saved item
-- is either a real location_id, or a custom typed/geocoded address
-- (custom_name/custom_lat/custom_lng), matching the frontend's existing
-- Saved Places data model 1:1.
CREATE TABLE IF NOT EXISTS saved_items (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  collection TEXT NOT NULL,          -- 'Favorites' | 'Home' | 'Work' | custom
  location_id TEXT,
  custom_name TEXT, custom_lat REAL, custom_lng REAL,
  saved_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recent_searches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  label TEXT NOT NULL, lat REAL, lng REAL,
  searched_at INTEGER NOT NULL
);

-- MIGRATION — if pulse-db already exists, run just these (schema.sql's
-- CREATE TABLE IF NOT EXISTS statements are safe to re-run wholesale too):
--   CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', name TEXT, email_verified INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
--   CREATE TABLE IF NOT EXISTS auth_tokens (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
--   CREATE TABLE IF NOT EXISTS saved_items (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), collection TEXT NOT NULL, location_id TEXT, custom_name TEXT, custom_lat REAL, custom_lng REAL, saved_at INTEGER NOT NULL);
--   CREATE TABLE IF NOT EXISTS recent_searches (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), label TEXT NOT NULL, lat REAL, lng REAL, searched_at INTEGER NOT NULL);
--   CREATE TABLE IF NOT EXISTS verification_codes (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), code TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0);
--   ALTER TABLE owner_claims ADD COLUMN user_id INTEGER REFERENCES users(id);
--   ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;  -- only if users already existed without this column

-- Seed data mirroring src/index.js DEMO_DATA, so the app looks the
-- same the moment you switch from in-memory to D1.
INSERT INTO locations (id,name,category,icon,distance,status,minutes,confirms,updated_at,owner_owned,owner_verified,note,x,y) VALUES
(1,'Eastside pharmacy','health','ti-first-aid-kit','0.4 mi','green',4,6,strftime('%s','now')*1000,0,0,NULL,100,70),
(2,'City DMV branch','service','ti-building-bank','1.1 mi','amber',38,21,strftime('%s','now')*1000,0,0,NULL,105,205),
(3,'Riverside urgent care','health','ti-stethoscope','0.8 mi','red',57,14,strftime('%s','now')*1000,0,0,NULL,245,325),
(4,'Northgate laundromat','errand','ti-wash','0.6 mi','green',2,3,strftime('%s','now')*1000,0,0,NULL,100,430),
(5,'Shell station, Main St','fuel','ti-gas-station','0.5 mi','amber',12,0,strftime('%s','now')*1000,1,1,'2 pumps closed for maintenance',250,70),
(6,'Bilal barbershop','service','ti-scissors','0.3 mi','red',45,0,strftime('%s','now')*1000,1,1,'3 people ahead, walk-ins only',57,335),
(7,'Ranchers Restaurant','food','ti-tools-kitchen-2','0.3 mi','green',5,8,strftime('%s','now')*1000,0,0,NULL,180,115),
(8,'Layers Bakeshop','food','ti-bread','0.5 mi','amber',15,4,strftime('%s','now')*1000,0,0,NULL,122,310);

INSERT INTO road_reports (id,name,type,icon,detail,confirms,created_at,x,y) VALUES
(101,'Signal down, 9th St and Elm St','hazard','ti-traffic-cone','Treat as 4-way stop',9,strftime('%s','now')*1000,45,395),
(102,'Highway 9 closed near Main St','closure','ti-road-off','Water main repair, est. clears 6:00 PM',21,strftime('%s','now')*1000,250,219),
(103,'Slow on Highway 9, eastbound','jam','ti-car','Adds about 15 min',6,strftime('%s','now')*1000,300,203),
(104,'Police reported, Main St','police','ti-shield','North end, near 2nd Ave',30,strftime('%s','now')*1000,150,40),
(105,'Speed camera, 2nd Ave','camera','ti-camera','Fixed location',34,strftime('%s','now')*1000,280,150);

INSERT INTO signals (id,name,color,reported_at,confirms,x,y) VALUES
(201,'Main St and 2nd Ave','red',strftime('%s','now')*1000-40000,3,150,150),
(202,'Highway 9 and Main St','green',strftime('%s','now')*1000-15000,5,150,252),
(203,'9th St and 2nd Ave','red',strftime('%s','now')*1000-95000,1,54,150);
