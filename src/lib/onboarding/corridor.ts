/**
 * Postal-code lookup for the I-77 corridor.
 *
 * A bundled table rather than a geocoding API, for two reasons: an
 * applicant's address never leaves this system, and onboarding does not
 * depend on a third party being up. Centroids are approximate and only ever
 * used to pick a zone and estimate a delivery stop — never to route a driver.
 *
 * Extending the corridor means adding rows here. A postal code that is not in
 * the table is outside the service area, which is the honest answer.
 */
import { haversineMiles, type Point } from "@/lib/crs/geo";

export type CorridorPlace = Point & { city: string; state: string };

const CORRIDOR: Record<string, CorridorPlace> = {
  // Iredell County
  "28115": { city: "Mooresville", state: "NC", lat: 35.5826, lng: -80.8176 },
  "28117": { city: "Mooresville", state: "NC", lat: 35.5951, lng: -80.8862 },
  "28166": { city: "Troutman", state: "NC", lat: 35.6996, lng: -80.887 },
  "28625": { city: "Statesville", state: "NC", lat: 35.8126, lng: -80.8451 },
  "28677": { city: "Statesville", state: "NC", lat: 35.77, lng: -80.92 },
  "28687": { city: "Statesville", state: "NC", lat: 35.7826, lng: -80.8873 },

  // North Mecklenburg
  "28078": { city: "Huntersville", state: "NC", lat: 35.4107, lng: -80.8428 },
  "28031": { city: "Cornelius", state: "NC", lat: 35.4868, lng: -80.8601 },
  "28036": { city: "Davidson", state: "NC", lat: 35.4993, lng: -80.8486 },

  // Charlotte, north of uptown
  "28206": { city: "Charlotte", state: "NC", lat: 35.2576, lng: -80.8271 },
  "28205": { city: "Charlotte", state: "NC", lat: 35.2271, lng: -80.7931 },
  "28216": { city: "Charlotte", state: "NC", lat: 35.2845, lng: -80.8752 },
  "28262": { city: "Charlotte", state: "NC", lat: 35.3254, lng: -80.743 },
  "28269": { city: "Charlotte", state: "NC", lat: 35.3284, lng: -80.7979 },
  "28213": { city: "Charlotte", state: "NC", lat: 35.2834, lng: -80.7598 },

  // York County, South Carolina — the planned southern extension
  "29730": { city: "Rock Hill", state: "SC", lat: 34.9249, lng: -81.0251 },
  "29732": { city: "Rock Hill", state: "SC", lat: 34.9718, lng: -81.0487 },
  "29745": { city: "York", state: "SC", lat: 34.9954, lng: -81.2412 },
  "29715": { city: "Fort Mill", state: "SC", lat: 35.0074, lng: -80.9451 },
};

export function lookupPostalCode(postal: string): CorridorPlace | null {
  const key = postal.trim().slice(0, 5);
  return CORRIDOR[key] ?? null;
}

export function corridorPostalCodes(): string[] {
  return Object.keys(CORRIDOR).sort();
}

export type ZoneCandidate = {
  id: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusMiles: number;
  active: boolean;
};

export type ZoneMatch = {
  /** The active zone that covers this point, if any. */
  zone: ZoneCandidate | null;
  /** Closest zone of any kind, used for waitlisting. */
  nearest: ZoneCandidate | null;
  distanceMiles: number | null;
  outcome: "matched" | "waitlist_planned" | "waitlist_far" | "no_zones";
};

/**
 * Match a location to a zone.
 *
 * An applicant inside an active zone's radius joins it. One outside every
 * active zone is waitlisted against the nearest zone — if that zone is
 * planned rather than active, the waitlist is the demand signal that decides
 * when it opens.
 */
export function matchZone(point: Point, zones: ZoneCandidate[]): ZoneMatch {
  if (zones.length === 0) {
    return { zone: null, nearest: null, distanceMiles: null, outcome: "no_zones" };
  }

  const scored = zones
    .map((z) => ({
      zone: z,
      miles: haversineMiles(point, { lat: z.centerLat, lng: z.centerLng }),
    }))
    .sort((a, b) => a.miles - b.miles);

  const covering = scored.find((s) => s.zone.active && s.miles <= s.zone.radiusMiles);
  if (covering) {
    return {
      zone: covering.zone,
      nearest: covering.zone,
      distanceMiles: Math.round(covering.miles * 10) / 10,
      outcome: "matched",
    };
  }

  const nearest = scored[0];
  return {
    zone: null,
    nearest: nearest.zone,
    distanceMiles: Math.round(nearest.miles * 10) / 10,
    outcome: nearest.zone.active ? "waitlist_far" : "waitlist_planned",
  };
}
