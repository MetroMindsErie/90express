/**
 * Geographic helpers for ZoneMap and route building.
 *
 * Straight-line distance is multiplied by a circuity factor to approximate
 * road miles. 1.15 is a conventional planning figure for interstate-corridor
 * freight; it is a planning estimate, not a routed distance. Swap in a real
 * routing engine (OSRM, HERE, PC*MILER) before invoicing a carrier off it.
 */
export const CIRCUITY_FACTOR = 1.15;

const EARTH_RADIUS_MILES = 3958.8;

export type Point = { lat: number; lng: number };

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in miles. */
export function haversineMiles(a: Point, b: Point): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Estimated road miles between two points. */
export function roadMiles(a: Point, b: Point): number {
  return haversineMiles(a, b) * CIRCUITY_FACTOR;
}

export type RouteStop<T> = { item: T; point: Point };

export type RoutePlan<T> = {
  /** Stops in delivery order. */
  ordered: Array<{ item: T; point: Point; milesFromPrev: number }>;
  /** Origin -> every stop, in order. Excludes the carrier's return leg. */
  totalMiles: number;
};

/**
 * Nearest-neighbour sequencing from the supplier origin.
 *
 * Deliberately simple: along a single interstate corridor with a handful of
 * stops, nearest-neighbour is within a few percent of optimal and is easy for
 * a dispatcher to sanity-check. Replace with a VRP solver when stop counts
 * grow past roughly a dozen or time windows start binding.
 */
export function planRoute<T>(origin: Point, stops: RouteStop<T>[]): RoutePlan<T> {
  const remaining = [...stops];
  const ordered: RoutePlan<T>["ordered"] = [];
  let cursor = origin;
  let totalMiles = 0;

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestMiles = roadMiles(cursor, remaining[0].point);
    for (let i = 1; i < remaining.length; i++) {
      const miles = roadMiles(cursor, remaining[i].point);
      if (miles < bestMiles) {
        bestMiles = miles;
        bestIndex = i;
      }
    }
    const [next] = remaining.splice(bestIndex, 1);
    const milesFromPrev = Math.round(bestMiles);
    ordered.push({ item: next.item, point: next.point, milesFromPrev });
    totalMiles += milesFromPrev;
    cursor = next.point;
  }

  return { ordered, totalMiles };
}

/** Whether a point falls inside a zone's service radius. */
export function withinZone(center: Point, radiusMiles: number, p: Point): boolean {
  return haversineMiles(center, p) <= radiusMiles;
}
