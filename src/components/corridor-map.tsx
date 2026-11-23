/**
 * ZoneMap — the I-77 corridor as a simple projected plot.
 *
 * Equirectangular projection with a cos(lat) correction on longitude, which
 * is accurate enough over a hundred-mile corridor and needs no tiles, API key
 * or client-side map library. It is a schematic for picking zones and seeing
 * who sits where, not a navigational map.
 */
type Point = { lat: number; lng: number };

type ZoneMark = Point & {
  id: string;
  name: string;
  radiusMiles: number;
  active: boolean;
  memberCount: number;
};

type MemberMark = Point & {
  id: string;
  name: string;
  zoneId: string;
};

type SupplierMark = Point & { id: string; name: string };

const WIDTH = 620;
const HEIGHT = 760;
const PAD = 56;
const MILES_PER_DEG_LAT = 69;

export function CorridorMap({
  zones,
  members,
  suppliers,
  highlightZoneId,
}: {
  zones: ZoneMark[];
  members: MemberMark[];
  suppliers: SupplierMark[];
  highlightZoneId?: string;
}) {
  const all: Point[] = [...zones, ...members, ...suppliers];
  if (all.length === 0) return null;

  const lats = all.map((p) => p.lat);
  const lngs = all.map((p) => p.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const lngScale = Math.cos((midLat * Math.PI) / 180);

  // Work in "corrected degrees" so one unit east equals one unit north.
  const xs = lngs.map((l) => l * lngScale);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...lats);
  const maxY = Math.max(...lats);

  const spanX = Math.max(maxX - minX, 0.08);
  const spanY = Math.max(maxY - minY, 0.08);
  // One scale for both axes keeps the radius circles honest.
  const scale = Math.min((WIDTH - PAD * 2) / spanX, (HEIGHT - PAD * 2) / spanY);

  const cx = (p: Point) =>
    PAD + (p.lng * lngScale - minX) * scale + (WIDTH - PAD * 2 - spanX * scale) / 2;
  const cy = (p: Point) =>
    HEIGHT - PAD - (p.lat - minY) * scale - (HEIGHT - PAD * 2 - spanY * scale) / 2;

  const milesToPx = (miles: number) => (miles / MILES_PER_DEG_LAT) * scale;

  // The corridor itself: zone centres ordered north to south.
  const corridor = [...zones].sort((a, b) => b.lat - a.lat);
  const path = corridor
    .map((z, i) => `${i === 0 ? "M" : "L"} ${cx(z).toFixed(1)} ${cy(z).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-auto w-full"
      role="img"
      aria-label={`I-77 corridor map showing ${zones.length} zones and ${members.length} member locations`}
    >
      <defs>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path
            d="M 40 0 L 0 0 0 40"
            fill="none"
            stroke="var(--ink-850)"
            strokeWidth="1"
          />
        </pattern>
      </defs>
      <rect width={WIDTH} height={HEIGHT} fill="var(--ink-950)" />
      <rect width={WIDTH} height={HEIGHT} fill="url(#grid)" />

      {/* The interstate */}
      <path
        d={path}
        fill="none"
        stroke="var(--ink-600)"
        strokeWidth="14"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path}
        fill="none"
        stroke="var(--signal)"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray="10 12"
        opacity="0.5"
      />

      {/* Zone service radii */}
      {zones.map((z) => (
        <g key={z.id}>
          <circle
            cx={cx(z)}
            cy={cy(z)}
            r={milesToPx(z.radiusMiles)}
            fill={
              z.id === highlightZoneId
                ? "var(--signal-dim)"
                : z.active
                  ? "var(--route-dim)"
                  : "transparent"
            }
            fillOpacity={z.id === highlightZoneId ? 0.6 : 0.45}
            stroke={
              z.id === highlightZoneId
                ? "var(--signal)"
                : z.active
                  ? "var(--route)"
                  : "var(--ink-600)"
            }
            strokeWidth="1"
            strokeDasharray={z.active ? undefined : "4 4"}
          />
        </g>
      ))}

      {/* Supplier origins */}
      {suppliers.map((s) => (
        <g key={s.id}>
          <rect
            x={cx(s) - 5}
            y={cy(s) - 5}
            width="10"
            height="10"
            fill="var(--ink-900)"
            stroke="var(--guide)"
            strokeWidth="1.5"
            transform={`rotate(45 ${cx(s)} ${cy(s)})`}
          />
          <text
            x={cx(s) + 11}
            y={cy(s) + 3.5}
            fill="var(--guide)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {s.name}
          </text>
        </g>
      ))}

      {/* Members */}
      {members.map((m) => (
        <circle
          key={m.id}
          cx={cx(m)}
          cy={cy(m)}
          r="3"
          fill={m.zoneId === highlightZoneId ? "var(--signal)" : "var(--text-mid)"}
        >
          <title>{m.name}</title>
        </circle>
      ))}

      {/* Zone labels last so they sit above everything */}
      {zones.map((z) => (
        <g key={`label-${z.id}`}>
          <circle
            cx={cx(z)}
            cy={cy(z)}
            r="3.5"
            fill={z.active ? "var(--signal)" : "var(--ink-500)"}
          />
          <text
            x={cx(z) + 10}
            y={cy(z) - 4}
            fill={z.active ? "var(--text-hi)" : "var(--text-low)"}
            fontSize="12"
            fontWeight="600"
          >
            {z.name}
          </text>
          <text
            x={cx(z) + 10}
            y={cy(z) + 9}
            fill="var(--text-low)"
            fontSize="10"
            fontFamily="var(--font-mono)"
          >
            {z.active
              ? `${z.memberCount} members · ${z.radiusMiles} mi`
              : `planned · ${z.radiusMiles} mi`}
          </text>
        </g>
      ))}
    </svg>
  );
}
