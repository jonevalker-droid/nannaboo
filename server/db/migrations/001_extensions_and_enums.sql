-- 001: extensions and enum types
-- PostGIS for geography columns, pgcrypto for gen_random_uuid().

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE poi_category AS ENUM (
  'restroom', 'exit', 'medic', 'food', 'drink', 'smoking', 'atm',
  'lost_and_found', 'info', 'charging', 'merch', 'coat_check',
  'accessible_route', 'parking', 'rideshare', 'water', 'quiet_room'
);

CREATE TYPE consent_scope AS ENUM (
  'venue_safety_network',      -- anonymous presence visible to venue safety ops
  'identified_security_roster',-- name + position visible to security staff
  'friend_sharing'             -- position visible to linked friends
);

CREATE TYPE sharing_level AS ENUM ('off', 'this_event_only', 'always');

CREATE TYPE position_source AS ENUM ('ble', 'wifi', 'cellular', 'imu_fused');

CREATE TYPE staff_role AS ENUM ('admin', 'promoter', 'security');

CREATE TYPE incident_status AS ENUM ('open', 'acknowledged', 'resolved');
