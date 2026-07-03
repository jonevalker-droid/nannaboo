/**
 * Canonical TypeScript types for the NannaBoo schema (mirrors
 * server/db/migrations/*.sql). The runtime server is plain JS for now; these
 * are the contract for Phase 2+ services and any TS client code.
 *
 * Conventions:
 * - UUIDs and timestamps are strings (ISO 8601) as returned over JSON.
 * - Geography(Point) columns surface as { lat, lng } in query results;
 *   Geography(Polygon) as GeoJSON.
 */

export type Uuid = string;
export type IsoTimestamp = string;

export interface LatLng {
  lat: number;
  lng: number;
}

/** GeoJSON polygon, [ [ [lng, lat], ... ] ] */
export interface GeoPolygon {
  type: 'Polygon';
  coordinates: number[][][];
}

// ---------------------------------------------------------------- enums

export type PoiCategory =
  | 'restroom' | 'exit' | 'medic' | 'food' | 'drink' | 'smoking' | 'atm'
  | 'lost_and_found' | 'info' | 'charging' | 'merch' | 'coat_check'
  | 'accessible_route' | 'parking' | 'rideshare' | 'water' | 'quiet_room'
  | 'other';

export type ConsentScope =
  | 'venue_safety_network'       // anonymous presence visible to venue safety ops
  | 'identified_security_roster' // name + position visible to security staff
  | 'friend_sharing';            // position visible to linked friends

export type SharingLevel = 'off' | 'this_event_only' | 'always';

/**
 * Guest-level default visibility toward OTHER GUESTS (staff safety views are
 * governed by ConsentScope, not this). A friend_link's SharingLevel can still
 * override down toward a specific friend.
 */
export type VisibilityMode = 'public' | 'friends_only' | 'off';

export type PositionSource = 'ble' | 'wifi' | 'cellular' | 'imu_fused';

export type StaffRole = 'admin' | 'promoter' | 'security';

export type IncidentStatus = 'open' | 'acknowledged' | 'resolved';

// ---------------------------------------------------------------- tables

export interface Venue {
  id: Uuid;
  name: string;
  slug: string;
  timezone: string;
  center: LatLng | null;
  boundary: GeoPolygon | null;
  createdAt: IsoTimestamp;
}

export interface Event {
  id: Uuid;
  venueId: Uuid;
  name: string;
  /** Phase 1 join code; null for ticketed events later. Unique among active events. */
  groupCode: string | null;
  startsAt: IsoTimestamp | null;
  /** null = active */
  endsAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
}

export interface Zone {
  id: Uuid;
  venueId: Uuid;
  name: string;
  boundary: GeoPolygon;
  capacity: number | null;
  createdAt: IsoTimestamp;
}

export interface Poi {
  id: Uuid;
  venueId: Uuid;
  zoneId: Uuid | null;
  category: PoiCategory;
  name: string;
  location: LatLng;
  /** Free text, e.g. 'long line', 'closed until 6pm'. */
  liveStatus: string | null;
  /** Optional indoor floor/level reference, e.g. '1', 'B1', 'Mezzanine'. */
  floorLevel: string | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface Guest {
  /** Client-generated UUID (localStorage nb_guest_id), validated server-side. */
  id: Uuid;
  displayName: string;
  visibilityMode: VisibilityMode;
  createdAt: IsoTimestamp;
  lastSeenAt: IsoTimestamp;
}

export interface ConsentGrant {
  id: Uuid;
  guestId: Uuid;
  /** null = not event-scoped (covers all events). */
  eventId: Uuid | null;
  scope: ConsentScope;
  grantedAt: IsoTimestamp;
  expiresAt: IsoTimestamp | null;
  revokedAt: IsoTimestamp | null;
}

export interface FriendLink {
  id: Uuid;
  /** The sharer. */
  guestId: Uuid;
  /** Who may see them. */
  friendGuestId: Uuid;
  /** Required when sharingLevel is 'this_event_only'. */
  eventId: Uuid | null;
  sharingLevel: SharingLevel;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

export interface PositionFix {
  id: number;
  guestId: Uuid;
  eventId: Uuid | null;
  location: LatLng;
  accuracyM: number | null;
  heading: number | null;
  source: PositionSource;
  /** 0..1 */
  confidence: number;
  recordedAt: IsoTimestamp;
}

export interface StaffSession {
  id: Uuid;
  venueId: Uuid;
  eventId: Uuid | null;
  displayName: string;
  role: StaffRole;
  /** Hash of the session credential; the raw token is never stored. */
  tokenHash: string | null;
  accessExpiresAt: IsoTimestamp;
  createdAt: IsoTimestamp;
  revokedAt: IsoTimestamp | null;
}

export interface IncidentLog {
  id: Uuid;
  venueId: Uuid;
  eventId: Uuid | null;
  zoneId: Uuid | null;
  /** staff_session id of the reporter. */
  reportedBy: Uuid | null;
  subjectGuestId: Uuid | null;
  category: string;
  description: string | null;
  location: LatLng | null;
  status: IncidentStatus;
  createdAt: IsoTimestamp;
  resolvedAt: IsoTimestamp | null;
}

/** Written by server/db/access.js on every identified-guest lookup. */
export interface AuditLog {
  id: number;
  /** staff_session id, guest id, or 'system'. */
  actor: string;
  actorStaffSessionId: Uuid | null;
  targetGuestId: Uuid | null;
  action: string;
  detail: Record<string, unknown> | null;
  at: IsoTimestamp;
}

/** Existing shared-pins feature (guest-created, max 3 per group, app-enforced). */
export interface Pin {
  id: Uuid;
  eventId: Uuid;
  label: string;
  location: LatLng;
  createdBy: Uuid | null;
  createdAt: IsoTimestamp;
}
