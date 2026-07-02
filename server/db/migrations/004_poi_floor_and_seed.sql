-- 004: POI additions for the guest-facing POI engine.
-- The Prompt-3 category list maps onto the existing poi_category enum
-- (bathroom -> restroom; info already present); only 'other' is new.

ALTER TYPE poi_category ADD VALUE IF NOT EXISTS 'other';

-- Optional indoor floor/level reference, e.g. '1', 'B1', 'Mezzanine'.
ALTER TABLE poi ADD COLUMN floor_level text;

-- Placeholder center for the seeded venue (matches the client's fallback map
-- center) so demo POIs are visible before real coordinates are set. Reposition
-- with the POI admin API or POST /api/pois/seed-demo?lat=..&lng=..
UPDATE venue
SET center = ST_SetSRID(ST_MakePoint(-88.0, 44.5), 4326)::geography
WHERE slug = 'lake-resort' AND center IS NULL;

-- Sample POIs ~50-160 m around that center: three exits, restrooms, a medic
-- tent, and a food stand. Only seeds if the venue has no POIs yet.
INSERT INTO poi (venue_id, category, name, location, floor_level)
SELECT v.id, x.category::poi_category, x.name,
       ST_SetSRID(ST_MakePoint(x.lng, x.lat), 4326)::geography, x.floor_level
FROM venue v
CROSS JOIN (VALUES
  ('exit',     'North Exit — Main Gate',    44.50120, -88.00000, NULL),
  ('exit',     'South Exit — Boat Ramp',    44.49880, -88.00050, NULL),
  ('exit',     'East Exit — Service Road',  44.50010, -87.99820, NULL),
  ('restroom', 'Restrooms — Main Lodge',    44.50040, -88.00100, '1'),
  ('medic',    'First Aid Tent',            44.49960, -87.99920, NULL),
  ('food',     'Grill Shack',               44.50070, -87.99950, NULL)
) AS x(category, name, lat, lng, floor_level)
WHERE v.slug = 'lake-resort'
  AND NOT EXISTS (SELECT 1 FROM poi WHERE poi.venue_id = v.id);
