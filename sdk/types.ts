/**
 * NannaBoo Partner SDK — TYPE CONTRACT ONLY (Phase 1 scaffold, no impl).
 *
 * This is the boundary a partner venue's own app would eventually call
 * without embedding our guest PWA. Design rules the types encode:
 *
 * 1. The SDK is a THIN client over the same server APIs our own app uses —
 *    consent, visibility tiers, geofencing, auditing, and retention are all
 *    enforced server-side per session. There is no privileged client path:
 *    a partner app can never see more than our guest app could.
 * 2. Everything is venue-scoped. A tenant is identified by (venueSlug,
 *    partnerKey); nothing in this contract assumes one global venue,
 *    one global group-code namespace, or one global geofence (see
 *    sdk/DESIGN.md for where Phase 1 code currently does).
 * 3. Consent is part of the API surface, not the partner's problem to
 *    reimplement: the SDK exposes consent state + copy from VenueConfig,
 *    and consent-gated calls fail typed (`ConsentRequiredError`) rather
 *    than silently returning less data.
 *
 * Shared row shapes come from the canonical schema contract.
 */

import type {
  Uuid,
  IsoTimestamp,
  LatLng,
  GeoPolygon,
  Poi,
  PoiCategory,
  ConsentScope,
  VisibilityMode,
  SharingLevel,
} from '../server/db/types';

// ───────────────────────────── session ─────────────────────────────

export interface SdkInit {
  /** API origin for this deployment (multi-tenant later: one per region). */
  baseUrl: string;
  /** Tenant identity. Resolves to a VenueConfig server-side. */
  venueSlug: string;
  /** Per-partner credential (NOT the venue ADMIN_KEY; scoped + revocable). */
  partnerKey: string;
  /**
   * Stable guest identity from the partner app (maps to guest.id).
   * The SDK never invents identity; the host app owns it.
   */
  guestId: Uuid;
  displayName: string;
  /** Event join code or ticket-derived event ref, venue-scoped. */
  eventCode: string;
}

export interface GuestSession {
  guestId: Uuid;
  eventId: Uuid;
  venue: VenueConfig;
  /** Server-acknowledged consent state at connect time. */
  consents: ConsentState;
  visibility: VisibilityMode;
  close(): Promise<void>;
}

// ───────────────────────────── consent ─────────────────────────────

export interface ConsentState {
  /**
   * venue_safety_network is present but always true while on site — it is
   * a disclosed condition of entry (anonymized-only), not a toggle.
   */
  granted: Record<ConsentScope, boolean>;
  /** Venue-configured plain-language copy the partner app must display. */
  copy: ConsentCopy;
}

/** Thrown (typed, catchable) when a call needs a scope the guest declined. */
export interface ConsentRequiredError extends Error {
  name: 'ConsentRequiredError';
  scope: ConsentScope;
  /** Ready-to-display explanation from VenueConfig.consent.copy. */
  explanation: string;
}

// ───────────────────────────── main surface ─────────────────────────────

export interface NannaBooSdk {
  /** Connects, joins the event, reconciles consent. One session per guest. */
  init(config: SdkInit): Promise<GuestSession>;

  /**
   * POIs near a point (or the guest's live position when omitted), with
   * distance/bearing. NEVER consent-gated — wayfinding is the hard
   * invariant and works for fully-declined guests.
   */
  getNearbyPois(query?: {
    category?: PoiCategory;
    origin?: LatLng;
    limit?: number;
  }): Promise<NearbyPoi[]>;

  /**
   * Live positions of accepted friends the guest may see. Server applies
   * visibility tiers, per-friend sharing levels, and the venue geofence —
   * the SDK receives only what the guest's own app would render.
   * Rejects with ConsentRequiredError('friend_sharing') if declined.
   */
  getFriendPositions(): Promise<FriendPosition[]>;

  /**
   * Guest-triggered SOS with optional free-text note (e.g. medical info —
   * consented by the act of sending). Resolves once security's inbox has
   * it. Never consent-gated: SOS is the request for help.
   */
  submitSosAlert(alert?: { note?: string; position?: LatLng }): Promise<SosReceipt>;

  /** Read/update consent + visibility (server is authoritative). */
  getConsentState(): Promise<ConsentState>;
  setConsent(scope: Extract<ConsentScope, 'identified_security_roster' | 'medical_info'>, granted: boolean): Promise<ConsentState>;
  setVisibility(mode: VisibilityMode): Promise<void>;
  setFriendSharingLevel(friendGuestId: Uuid, level: SharingLevel): Promise<void>;

  /** Push the guest's position (partner app owns the geolocation watch). */
  updatePosition(fix: { position: LatLng; accuracyM?: number; headingDeg?: number }): Promise<void>;

  /** Live subscriptions (WS-backed). Returns an unsubscribe fn. */
  on<E extends keyof SdkEvents>(event: E, cb: (payload: SdkEvents[E]) => void): () => void;
}

export interface SdkEvents {
  friendPositions: FriendPosition[];
  /** Guest's own geofence state (inside/outside the venue boundary). */
  presence: { insideVenue: boolean | null };
  sosAcknowledged: SosReceipt;
  consentChanged: ConsentState;
}

// ───────────────────────────── payloads ─────────────────────────────

export interface NearbyPoi extends Poi {
  distanceM: number | null;
  bearingDeg: number | null;
}

export interface FriendPosition {
  guestId: Uuid;
  displayName: string;
  position: LatLng | null;   // null = friend not currently sharing/visible
  accuracyM: number | null;
  updatedAt: IsoTimestamp | null;
}

export interface SosReceipt {
  incidentId: Uuid;
  receivedAt: IsoTimestamp;
  /** True once the alert is in the security console inbox. */
  queuedForSecurity: boolean;
}

// ───────────────────────────── VenueConfig ─────────────────────────────

/**
 * Everything a multi-tenant deployment loads PER PARTNER. Today these
 * values are scattered as hardcoded strings/CSS/env in the Phase 1 app —
 * the audit in sdk/DESIGN.md maps each field to where that lives now.
 */
export interface VenueConfig {
  venue: {
    slug: string;              // tenant key; today: DEFAULT_VENUE_SLUG env
    name: string;
    timezone: string;
  };

  branding: {
    appName: string;           // today hardcoded: "NannaBoo"
    logoText?: string;         // today: the "N" join-logo
    logoUrl?: string;
    colors: {
      primary: string;         // today: #1a73e8 across App.css
      accent: string;
      danger: string;          // SOS red
    };
    /** Tile/style source for the map (today: hardcoded OSM tile URL). */
    mapTileUrl?: string;
  };

  /** Physical site + positioning profile. */
  siteProfile: {
    center: LatLng;
    /** Venue geofence incl. parking (today: process-global singleton). */
    boundary: GeoPolygon | null;
    defaultZoom: number;
    /**
     * Positioning sources this site supports. Phase 1 is browser
     * geolocation only; BLE/UWB site surveys slot in here later without
     * changing the SDK surface.
     */
    positioning: {
      sources: Array<'browser_geolocation' | 'ble_beacons' | 'wifi_rtt' | 'uwb'>;
      /** e.g. beacon map / floor plans, opaque to the SDK. */
      siteSurveyRef?: string;
    };
    floors?: Array<{ level: string; name: string }>;
  };

  /** Seed/managed POI set for the venue (exits first-class). */
  pois: Array<Pick<Poi, 'category' | 'name' | 'location' | 'floorLevel'>>;

  /**
   * Consent presentation is PER VENUE: legal copy differs by venue/
   * jurisdiction. The flow order and enforcement do not — those are ours.
   * Today all of this copy is hardcoded in Onboarding.jsx/FriendsSheet.jsx.
   */
  consent: {
    copy: ConsentCopy;
    /** Raw-location purge window, hours (today: venue column, global var). */
    retentionHours: number;
    /** Which optional features this venue enables at all. */
    features: {
      friendFinder: boolean;
      arWayfinding: boolean;
      medicalProfile: boolean;
      socialConnectStubs: boolean;
    };
  };
}

export type ConsentCopy = Record<
  ConsentScope | 'locationWhy' | 'retentionNotice' | 'welcome',
  {
    title: string;
    body: string;
    /** venue_safety_network: true (condition of entry, disclosed not asked). */
    requiredForEntry?: boolean;
  }
>;
