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
  x INTEGER, y INTEGER
);

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
-- Not wired into the Worker yet (Day 1 owner-update route trusts the
-- request); add a real check here when there's time for it. Note in
-- the demo/pitch that this is the known gap if a judge asks.
CREATE TABLE IF NOT EXISTS owner_claims (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  owner_contact TEXT NOT NULL,  -- phone or email used to claim it
  verified INTEGER DEFAULT 0
);

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
