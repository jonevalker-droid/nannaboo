# Partner SDK & multi-tenant boundary — design note (Phase 1 scaffold)

**Status: types only (`sdk/types.ts`). Nothing here is implemented, wired, or
promised for Phase 1.** This exists so day-to-day Phase 1 work stops digging
the single-venue hole deeper.

## The boundary in one paragraph

A partner venue's app talks to the same server our guest PWA talks to,
through a thin SDK (`NannaBooSdk`) authenticated by `(venueSlug, partnerKey,
guestId)`. There is deliberately **no privileged client path**: consent
scopes, visibility tiers, the geofence, reason-coded audits, and retention
are all enforced server-side per session, so a partner integration can never
observe more than our own guest app could. Consent-gated calls fail typed
(`ConsentRequiredError` carrying the venue's own explanation copy) instead of
silently degrading — the partner renders our consent copy, never invents it.
Wayfinding (`getNearbyPois`) and `submitSosAlert` are never consent-gated,
mirroring the Prompt 7 hard invariant.

## Tenancy model

One deployment, many venues. `venueSlug` resolves to a `VenueConfig`
(branding, `SiteProfile` with boundary + positioning sources, POI seed,
consent copy, retention window, feature flags). Server state becomes
venue-keyed rather than process-global; guest-facing copy and colors come
from config rather than JSX/CSS. The guest PWA itself becomes "partner
zero" — it should eventually consume `VenueConfig` the same way.

## Audit: Phase 1 code that hardcodes single-venue assumptions

Ranked by how expensive the assumption gets if we keep building on it.
"Rewrite risk" = would force protocol/schema surgery later, not just a refactor.

| # | Where | Assumption | Rewrite risk |
|---|-------|-----------|--------------|
| 1 | `server/db/migrations/002_core_tables.sql:26` (`event_active_group_code_uq`) + WS `join` carrying only `groupCode` (`server/index.js`), in-memory `groups` map keyed by bare code (`server/index.js:48`), `resolveEventKey` `code:<GROUP>` fallback | **Group codes are a single global namespace.** Two venues can't both issue `SMITH2026`. The wire protocol has no venue field, so every client (and the `nb_group` localStorage) bakes this in. | **HIGH — protocol + schema.** Fix cheaply now by scoping the unique index to `(venue_id, upper(group_code))` and letting `join` carry an optional `venueSlug` (defaulted server-side), before more clients exist. |
| 2 | `server/geofence.js:9` (`let boundary = null`) | **One geofence per process.** Every visibility decision calls `geofence.contains()` against a module singleton. | **MEDIUM-HIGH.** Mechanical refactor to `Map<venueId, polygon>`, but it touches the hot path (`canSeePosition`) and the venue router; gets worse with every new caller. |
| 3 | `server/db/index.js:161` (`let retentionHours`) + purge `DELETE FROM position_fix` with **no venue join** (`server/db/index.js:199`) | **One retention window applied globally.** The purge already deletes ALL venues' rows using the default venue's setting — wrong the moment venue #2 exists, and it's a data-destruction path. | **MEDIUM-HIGH.** Join `position_fix → event → venue.position_retention_hours` in the purge; per-venue values in the notice endpoint. Do this before any second venue row is ever inserted. |
| 4 | `server/db/index.js:9,13` (`DEFAULT_VENUE_SLUG`, `defaultVenueId` singleton) — used by `ensureEventForGroup`, zone CRUD, staff-session bootstrap, boundary persistence, `poiStore` (`server/poiStore.js:65,89,159`) | **"The venue" is an ambient global.** Every write path silently pins to it. | **MEDIUM.** Schema is already venue-scoped (good), so this is threading a `venueId` parameter through ~10 call sites — annoying later, trivial per-call now. New code should take `venueId` explicitly instead of calling `getDefaultVenueId()`. |
| 5 | `client/src/components/Onboarding.jsx` (welcome/location-why/security/data copy), `FriendsSheet.jsx` consent + retention text, `App.css`/`dashboard.css` brand colors, `"NannaBoo"`/`"N"` logo strings, OSM tile URL in `MapView.jsx`/`Dashboard.jsx`, `manifest`/`sw.js` app identity | **Branding + consent copy compiled into the app.** Consent language is per-venue/jurisdiction; today it ships in the bundle. | **MEDIUM.** Maps 1:1 onto `VenueConfig.branding` / `consent.copy` (see types). No logic change — but every new hardcoded string increases the eventual extraction diff. |
| 6 | `ADMIN_KEY` single shared secret gating POI writes, boundary, staff bootstrap, purge (`routes/*.js`); `MEDICAL_INFO_KEY \|\| ADMIN_KEY` as the one medical encryption key (`server/consentStore.js`) | **One credential, one crypto key, all tenants.** Cross-tenant admin access by construction; medical key rotation is all-or-nothing. | **MEDIUM.** Future: per-partner keys (`partnerKey` in `SdkInit`) resolved to venue + role; per-venue medical data keys (or per-venue key wrap). Nothing to rewrite yet if new secrets aren't added to the global pattern. |
| 7 | In-memory fallback stores: `memoryZones` (`dashboardStore.js`), staff `memorySessions` (`staffAuth.js`), dispatch `staffPositions` (`routes/console.js`) — none venue-keyed | Memory mode assumes one venue implicitly. | **LOW.** Memory mode is a dev/demo convenience; acceptable to declare it single-tenant forever. |
| 8 | `GET /api/pois` returns the whole POI table with no venue filter param on the read path (write path is venue-scoped) | Guests of venue A would see venue B's exits. | **LOW-MEDIUM.** Read path already filters by `venue_id = default` internally — needs a venue param plumbed, small change. |

## What Phase 1 should do about this (and only this)

- **Nothing gets built now.** But two cheap guardrails are worth adopting in
  ongoing work: (a) new server code takes `venueId`/`venueConfig` as a
  parameter instead of importing a singleton; (b) new guest-facing consent
  copy goes into one collectable place rather than inline JSX.
- Item **#1** (global group-code namespace) and item **#3** (global purge) are
  the two that get materially more expensive with time — #1 with every new
  client build in the field, #3 the day a second venue row exists. If any
  pre-multi-tenant cleanup is ever scheduled, do those two first.

## Mapping today's endpoints to the SDK surface

| SDK call | Today's mechanism |
|---|---|
| `getNearbyPois()` | `GET /api/pois?category&lat&lng&limit` (public, never gated) |
| `getFriendPositions()` | WS `groupState` (server-filtered) + `friendState` |
| `submitSosAlert()` | WS `sos` → `sosAck`; console inbox pins it first |
| `setConsent()` / `getConsentState()` | WS `setRosterConsent`, `setMedicalInfo` acks |
| `setVisibility()` / `setFriendSharingLevel()` | WS `setVisibility`, `friendLevel` |
| `updatePosition()` | WS `position` |
| `VenueConfig.consent.retentionHours` | `GET /api/venue/retention` |
| `VenueConfig.siteProfile.boundary` | `GET /api/venue/boundary` |

The SDK would front these with a stable versioned surface (REST+WS or a
single WS multiplex) so the wire protocol can evolve behind it.
