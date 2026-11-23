/**
 * Mock supplier and carrier endpoints.
 *
 * Exists so the HTTP adapters are exercised end to end — real sockets, real
 * JSON, real validation failures — instead of being typed against nothing
 * until a partner finally sends credentials. It also pins the contract we
 * hand a partner: this file is the reference implementation of what
 * src/lib/integrations/types.ts expects.
 *
 *   npm run mock-partners        # listens on 4010
 *
 * It deliberately misbehaves in small, realistic ways:
 *   - the broadline catalog comes back with a price rise and a discontinued
 *     SKU, so a sync has something to stage;
 *   - carrier rates land near, but not on, the static contract rate;
 *   - one invoice bills a detention charge that was never quoted, so the
 *     reconciler has a variance to catch.
 */
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_PARTNERS_PORT ?? 4010);
const TOKEN = process.env.MOCK_PARTNER_TOKEN ?? "dev-partner-token";

/** Deterministic jitter so repeated runs produce stable numbers. */
function seeded(key: string, min: number, max: number): number {
  const h = createHash("sha256").update(key).digest();
  const unit = h.readUInt32BE(0) / 0xffffffff;
  return Math.round(min + unit * (max - min));
}

// ---------------------------------------------------------------------------
// Supplier catalogs
// ---------------------------------------------------------------------------

type Tier = { minCases: number; unitPriceCents: number };
type Item = {
  sku: string;
  name: string;
  category: string;
  packDescription: string;
  casesPerPallet: number;
  caseWeightLb: number;
  listPriceCents: number;
  tempClass: "dry" | "chill" | "frozen";
  tiers: Tier[];
  discontinued?: boolean;
};

/**
 * Piedmont's published catalog. Matches the seeded data except where noted —
 * those exceptions are what a sync should surface for review.
 */
const PIEDMONT: Item[] = [
  // Oil is up 4.7%: the commodity move a buyer most wants warning of.
  { sku: "OIL-35", name: "Fryer Oil, 35 lb", category: "oils_fats", packDescription: "1/35 lb jug", casesPerPallet: 48, caseWeightLb: 36, listPriceCents: 3140, tempClass: "dry", tiers: [{ minCases: 50, unitPriceCents: 2985 }, { minCases: 250, unitPriceCents: 2720 }, { minCases: 1000, unitPriceCents: 2510 }] },
  { sku: "FLR-50", name: "All-Purpose Flour, 50 lb", category: "dry_goods", packDescription: "1/50 lb bag", casesPerPallet: 40, caseWeightLb: 50, listPriceCents: 2200, tempClass: "dry", tiers: [{ minCases: 40, unitPriceCents: 2080 }, { minCases: 200, unitPriceCents: 1900 }, { minCases: 800, unitPriceCents: 1750 }] },
  { sku: "RIC-25", name: "Long Grain Rice, 25 lb", category: "dry_goods", packDescription: "1/25 lb bag", casesPerPallet: 56, caseWeightLb: 25, listPriceCents: 1950, tempClass: "dry", tiers: [{ minCases: 50, unitPriceCents: 1850 }, { minCases: 250, unitPriceCents: 1700 }, { minCases: 900, unitPriceCents: 1580 }] },
  // A deeper break appears at 600: pooling just got more valuable here.
  { sku: "SAU-TOM", name: "Tomato Sauce, #10", category: "dry_goods", packDescription: "6/#10 cans", casesPerPallet: 72, caseWeightLb: 38, listPriceCents: 2750, tempClass: "dry", tiers: [{ minCases: 50, unitPriceCents: 2600 }, { minCases: 250, unitPriceCents: 2400 }, { minCases: 600, unitPriceCents: 2290 }, { minCases: 1000, unitPriceCents: 2240 }] },
  { sku: "CHK-40", name: "Breaded Chicken Tenders", category: "protein", packDescription: "4/10 lb", casesPerPallet: 45, caseWeightLb: 42, listPriceCents: 8900, tempClass: "frozen", tiers: [{ minCases: 30, unitPriceCents: 8500 }, { minCases: 150, unitPriceCents: 8050 }, { minCases: 600, unitPriceCents: 7600 }] },
  { sku: "BEF-80", name: "Ground Beef 80/20", category: "protein", packDescription: "4/10 lb chub", casesPerPallet: 50, caseWeightLb: 42, listPriceCents: 12400, tempClass: "chill", tiers: [{ minCases: 25, unitPriceCents: 11900 }, { minCases: 120, unitPriceCents: 11200 }, { minCases: 500, unitPriceCents: 10600 }] },
  // Repacked from 4/5 lb to 2/10 lb: same weight, different pallet count.
  { sku: "CHS-SHRD", name: "Shredded Mozzarella", category: "dairy", packDescription: "2/10 lb", casesPerPallet: 54, caseWeightLb: 21, listPriceCents: 6400, tempClass: "chill", tiers: [{ minCases: 40, unitPriceCents: 6150 }, { minCases: 200, unitPriceCents: 5800 }, { minCases: 700, unitPriceCents: 5500 }] },
  // Offered by the supplier, not yet in our catalog.
  { sku: "OIL-CAN", name: "Canola Oil, 35 lb", category: "oils_fats", packDescription: "1/35 lb jug", casesPerPallet: 48, caseWeightLb: 36, listPriceCents: 2890, tempClass: "dry", tiers: [{ minCases: 50, unitPriceCents: 2740 }, { minCases: 250, unitPriceCents: 2520 }] },
];

const YADKIN: Item[] = [
  { sku: "PRD-ONI", name: "Yellow Onions, 50 lb", category: "produce", packDescription: "1/50 lb sack", casesPerPallet: 45, caseWeightLb: 50, listPriceCents: 2650, tempClass: "dry", tiers: [{ minCases: 30, unitPriceCents: 2500 }, { minCases: 150, unitPriceCents: 2300 }, { minCases: 600, unitPriceCents: 2150 }] },
  { sku: "PRD-POT", name: "Russet Potatoes, 50 lb", category: "produce", packDescription: "1/50 lb sack", casesPerPallet: 45, caseWeightLb: 50, listPriceCents: 2380, tempClass: "dry", tiers: [{ minCases: 30, unitPriceCents: 2250 }, { minCases: 150, unitPriceCents: 2080 }, { minCases: 600, unitPriceCents: 1950 }] },
  // Seasonal: lettuce up 9%, which is exactly the move a weekly pool wants flagged.
  { sku: "PRD-LET", name: "Iceberg Lettuce", category: "produce", packDescription: "24 ct", casesPerPallet: 40, caseWeightLb: 42, listPriceCents: 3760, tempClass: "chill", tiers: [{ minCases: 25, unitPriceCents: 3580 }, { minCases: 120, unitPriceCents: 3330 }, { minCases: 500, unitPriceCents: 3140 }] },
  { sku: "PRD-TOM", name: "Roma Tomatoes, 25 lb", category: "produce", packDescription: "1/25 lb", casesPerPallet: 50, caseWeightLb: 25, listPriceCents: 2890, tempClass: "chill", tiers: [{ minCases: 25, unitPriceCents: 2750 }, { minCases: 120, unitPriceCents: 2560 }, { minCases: 500, unitPriceCents: 2400 }] },
];

const CATALOGS: Record<string, Item[]> = {
  piedmont: PIEDMONT,
  yadkin: YADKIN,
};

// ---------------------------------------------------------------------------
// Carrier behaviour
// ---------------------------------------------------------------------------

type CarrierProfile = {
  ratePerMile: number;
  minCharge: number;
  stopCharge: number;
  liftgate: number;
  fuelPct: number;
};

const CARRIERS: Record<string, CarrierProfile> = {
  // Beats its contract rate slightly: a live market, not a rate card.
  iredell: { ratePerMile: 276, minCharge: 43_500, stopCharge: 7_500, liftgate: 4_500, fuelPct: 0.06 },
  catawbacold: { ratePerMile: 344, minCharge: 56_000, stopCharge: 8_500, liftgate: 5_000, fuelPct: 0.08 },
  queencity: { ratePerMile: 282, minCharge: 42_000, stopCharge: 7_000, liftgate: 4_000, fuelPct: 0.05 },
};

const tenders = new Map<
  string,
  { tenderRef: string; status: string; totalCents: number; stops: number; pickupDate: string }
>();
const idempotency = new Map<string, unknown>();

function haversineMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

type RateBody = {
  origin: { lat: number; lng: number };
  stops: Array<{ ref: string; lat: number; lng: number; pallets: number; weightLb: number; liftgate: boolean }>;
  pickupDate: string;
  equipment: string;
};

function priceLoad(profile: CarrierProfile, body: RateBody) {
  // Nearest-neighbour, same as the planner, so the two are comparable.
  const remaining = [...body.stops];
  let cursor = body.origin;
  let miles = 0;
  while (remaining.length) {
    let best = 0;
    let bestMiles = haversineMiles(cursor, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const m = haversineMiles(cursor, remaining[i]);
      if (m < bestMiles) {
        bestMiles = m;
        best = i;
      }
    }
    miles += bestMiles * 1.15;
    cursor = remaining[best];
    remaining.splice(best, 1);
  }
  const routeMiles = Math.round(miles);
  const linehaulBase = Math.max(profile.minCharge, profile.ratePerMile * routeMiles);
  const fuel = Math.round(linehaulBase * profile.fuelPct);
  const stopCharges = profile.stopCharge * body.stops.length;
  const liftgates = body.stops.filter((s) => s.liftgate).length * profile.liftgate;
  return {
    routeMiles,
    linehaulCents: linehaulBase + fuel,
    accessorialCents: stopCharges + liftgates,
    totalCents: linehaulBase + fuel + stopCharges + liftgates,
  };
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function send(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/health") {
    return send(res, 200, { ok: true, suppliers: Object.keys(CATALOGS), carriers: Object.keys(CARRIERS) });
  }

  // Every partner route is authenticated, so the adapter's token handling is
  // exercised rather than assumed.
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  const idemKey = req.headers["idempotency-key"];
  if (typeof idemKey === "string" && idempotency.has(idemKey)) {
    return send(res, 200, idempotency.get(idemKey));
  }

  // /supplier/:ref/...
  if (parts[0] === "supplier") {
    const ref = parts[1];
    const catalog = CATALOGS[ref];
    if (!catalog) return send(res, 404, { error: "unknown supplier" });

    if (parts[2] === "catalog" && req.method === "GET") {
      return send(res, 200, {
        supplierRef: ref,
        generatedAt: new Date().toISOString(),
        items: catalog,
      });
    }

    if (parts[2] === "quote" && req.method === "POST") {
      const body = (await readBody(req)) as {
        lines?: Array<{ sku: string; totalCases: number }>;
      } | null;
      if (!body?.lines) return send(res, 400, { error: "lines required" });

      const lines = body.lines.map((line) => {
        const item = catalog.find((i) => i.sku === line.sku);
        if (!item) return null;
        const ladder = [...item.tiers]
          .sort((a, b) => a.minCases - b.minCases)
          .filter((t) => line.totalCases >= t.minCases)
          .at(-1);
        const base = ladder?.unitPriceCents ?? item.listPriceCents;
        // A real concession of 0.5–2%, varying by SKU but stable per run.
        const concession = seeded(`${ref}:${line.sku}`, 50, 200) / 10_000;
        return {
          sku: line.sku,
          totalCases: line.totalCases,
          grantedUnitCents: Math.round(base * (1 - concession)),
        };
      });

      if (lines.some((l) => l === null)) {
        return send(res, 422, { error: "unknown sku in quote request" });
      }

      const payload = {
        quoteRef: `Q-${ref.toUpperCase()}-${randomUUID().slice(0, 8)}`,
        validUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        lines,
        minimumMet: true,
        note: "Pricing held for 72 hours. Freight arranged separately.",
      };
      return send(res, 200, payload);
    }

    if (parts[2] === "orders" && req.method === "POST") {
      const payload = {
        orderRef: `PO-${ref.toUpperCase()}-${randomUUID().slice(0, 8)}`,
        accepted: true,
        expectedShipDate: new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10),
      };
      if (typeof idemKey === "string") idempotency.set(idemKey, payload);
      return send(res, 200, payload);
    }
  }

  // /carrier/:ref/...
  if (parts[0] === "carrier") {
    const ref = parts[1];
    const profile = CARRIERS[ref];
    if (!profile) return send(res, 404, { error: "unknown carrier" });

    if (parts[2] === "rates" && req.method === "POST") {
      const body = (await readBody(req)) as RateBody | null;
      if (!body?.stops?.length) return send(res, 400, { error: "stops required" });
      const priced = priceLoad(profile, body);
      return send(res, 200, {
        quotes: [
          {
            quoteRef: `R-${ref.toUpperCase()}-${randomUUID().slice(0, 8)}`,
            serviceLevel: "standard",
            linehaulCents: priced.linehaulCents,
            accessorialCents: priced.accessorialCents,
            totalCents: priced.totalCents,
            transitDays: priced.routeMiles > 250 ? 2 : 1,
            validUntil: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          },
        ],
      });
    }

    if (parts[2] === "tenders" && req.method === "POST") {
      const body = (await readBody(req)) as (RateBody & { shipmentRef?: string }) | null;
      if (!body?.stops?.length) return send(res, 400, { error: "stops required" });
      const priced = priceLoad(profile, body);
      const tenderRef = `T-${ref.toUpperCase()}-${randomUUID().slice(0, 8)}`;
      // Reefer capacity is tight: decline the odd load, which the tender
      // flow has to handle rather than assume away.
      const accepted = !(ref === "catawbacold" && body.stops.length > 4);
      tenders.set(tenderRef, {
        tenderRef,
        status: accepted ? "accepted" : "declined",
        totalCents: priced.totalCents,
        stops: body.stops.length,
        pickupDate: body.pickupDate,
      });
      const payload = {
        tenderRef,
        status: accepted ? "accepted" : "declined",
        ...(accepted ? {} : { declineReason: "No reefer capacity for this pickup date." }),
      };
      if (typeof idemKey === "string") idempotency.set(idemKey, payload);
      return send(res, 200, payload);
    }

    if (parts[2] === "tenders" && parts[4] === "tracking" && req.method === "GET") {
      const tender = tenders.get(parts[3]);
      if (!tender) return send(res, 404, { error: "unknown tender" });
      const base = Date.now() - 6 * 3_600_000;
      const events = [
        {
          externalRef: `${tender.tenderRef}-PU`,
          code: "picked_up",
          message: "Loaded and departed shipper.",
          occurredAt: new Date(base).toISOString(),
        },
        ...Array.from({ length: tender.stops }, (_, i) => ({
          externalRef: `${tender.tenderRef}-ARR-${i + 1}`,
          code: i === 0 ? "delivered" : "out_for_delivery",
          message:
            i === 0
              ? `Stop ${i + 1} delivered and signed.`
              : `Stop ${i + 1} on board, in transit.`,
          occurredAt: new Date(base + (i + 1) * 45 * 60_000).toISOString(),
          stopSequence: i + 1,
          ...(i === 0 ? { signedBy: "Receiving" } : {}),
        })),
      ];
      return send(res, 200, { events });
    }

    if (parts[2] === "invoices" && req.method === "GET") {
      const invoices = [...tenders.values()]
        .filter((t) => t.status === "accepted")
        .map((t) => {
          // Detention on a load that was never quoted for it. This is the
          // single most common freight-billing surprise, and the reconciler
          // exists to catch it.
          const detention = seeded(t.tenderRef, 0, 3) === 0 ? 9_500 : 0;
          return {
            invoiceRef: `INV-${t.tenderRef.slice(2)}`,
            tenderRef: t.tenderRef,
            invoiceDate: new Date().toISOString().slice(0, 10),
            linehaulCents: Math.round(t.totalCents * 0.72),
            accessorialCents: t.totalCents - Math.round(t.totalCents * 0.72) + detention,
            totalCents: t.totalCents + detention,
            ...(detention ? { note: "Includes detention at stop 2 (62 min over)." } : {}),
          };
        });
      return send(res, 200, { invoices });
    }
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`Mock partner endpoints on http://localhost:${PORT}`);
  console.log(`  suppliers: ${Object.keys(CATALOGS).join(", ")}`);
  console.log(`  carriers:  ${Object.keys(CARRIERS).join(", ")}`);
  console.log(`  token:     ${TOKEN}`);
});
