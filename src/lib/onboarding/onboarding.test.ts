import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  generateToken,
  hashPassword,
  hashToken,
  tokensMatch,
  verifyPassword,
} from "@/lib/auth/crypto";
import type { Carrier } from "@/lib/crs/freight";
import type { Product } from "@/lib/crs/pricing";
import { lookupPostalCode, matchZone, type ZoneCandidate } from "./corridor";
import { estimateSavings } from "./estimate";

// --- password hashing -------------------------------------------------------
//
// scrypt at OWASP parameters is slow on purpose, so these run few hashes.

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const hash = await hashPassword("correct horse battery staple");
    assert.equal(await verifyPassword("correct horse battery staple", hash), true);
    assert.equal(await verifyPassword("wrong horse battery staple", hash), false);
  });

  it("produces a different hash each time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("the same passphrase here"),
      hashPassword("the same passphrase here"),
    ]);
    assert.notEqual(a, b, "salts must differ");
    assert.equal(await verifyPassword("the same passphrase here", a), true);
    assert.equal(await verifyPassword("the same passphrase here", b), true);
  });

  it("records its parameters so they can be raised later", async () => {
    const hash = await hashPassword("parameters are recorded");
    const [scheme, N, r, p] = hash.split("$");
    assert.equal(scheme, "scrypt");
    assert.equal(Number(N), 1 << 17);
    assert.equal(Number(r), 8);
    assert.equal(Number(p), 1);
  });

  it("rejects a password short enough to brute-force", async () => {
    await assert.rejects(() => hashPassword("short"), /at least 12/);
  });

  it("refuses an unbounded password rather than doing the work", async () => {
    await assert.rejects(() => hashPassword("x".repeat(5000)), /at most 1024/);
  });

  it("treats a missing hash as a failed login, not a crash", async () => {
    assert.equal(await verifyPassword("anything at all", null), false);
    assert.equal(await verifyPassword("anything at all", undefined), false);
    assert.equal(await verifyPassword("anything at all", ""), false);
  });

  it("treats a malformed hash as a failed login", async () => {
    for (const bad of [
      "not-a-hash",
      "scrypt$$$$",
      "bcrypt$1$2$3$4$5",
      "scrypt$16384$8$1$onlyfiveparts",
    ]) {
      assert.equal(await verifyPassword("anything at all", bad), false, bad);
    }
  });

  it("refuses absurd parameters from a tampered row", async () => {
    // A huge N would be a denial of service against our own process.
    const tampered = `scrypt$${1 << 25}$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA`;
    assert.equal(await verifyPassword("anything at all", tampered), false);
  });

  it("normalises unicode so the same typed passphrase verifies", async () => {
    // U+00E9 against e + U+0301: visually identical, different bytes.
    const composed = "café passphrase here";
    const decomposed = "café passphrase here";
    assert.notEqual(composed, decomposed);
    const hash = await hashPassword(composed);
    assert.equal(await verifyPassword(decomposed, hash), true);
  });
});

describe("tokens", () => {
  it("generates distinct, URL-safe, high-entropy tokens", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const token = generateToken();
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      assert.ok(token.length >= 42, `token too short: ${token.length}`);
      assert.equal(seen.has(token), false);
      seen.add(token);
    }
  });

  it("hashes deterministically, and the hash is not the token", () => {
    const token = generateToken();
    assert.equal(hashToken(token), hashToken(token));
    assert.notEqual(hashToken(token), token);
  });

  it("compares hashes without a length-based shortcut being wrong", () => {
    const a = hashToken("one");
    assert.equal(tokensMatch(a, a), true);
    assert.equal(tokensMatch(a, hashToken("two")), false);
    assert.equal(tokensMatch(a, a.slice(0, 10)), false);
  });
});

// --- corridor and zone matching ---------------------------------------------

const ZONES: ZoneCandidate[] = [
  { id: "lkn", name: "Lake Norman", centerLat: 35.5849, centerLng: -80.8101, radiusMiles: 15, active: true },
  { id: "stv", name: "Statesville", centerLat: 35.7826, centerLng: -80.8873, radiusMiles: 18, active: true },
  { id: "nm", name: "North Meck", centerLat: 35.45, centerLng: -80.85, radiusMiles: 12, active: true },
  { id: "rh", name: "Rock Hill", centerLat: 34.9249, centerLng: -81.0251, radiusMiles: 15, active: false },
];

describe("postal code lookup", () => {
  it("resolves a corridor ZIP to a place", () => {
    const place = lookupPostalCode("28115");
    assert.ok(place);
    assert.equal(place.city, "Mooresville");
    assert.equal(place.state, "NC");
  });

  it("ignores ZIP+4 and surrounding whitespace", () => {
    assert.equal(lookupPostalCode(" 28115-1234 ")?.city, "Mooresville");
  });

  it("returns null outside the corridor rather than guessing", () => {
    assert.equal(lookupPostalCode("90210"), null);
    assert.equal(lookupPostalCode(""), null);
    assert.equal(lookupPostalCode("not a zip"), null);
  });
});

describe("matchZone", () => {
  it("matches a Mooresville address to Lake Norman", () => {
    const place = lookupPostalCode("28115")!;
    const match = matchZone(place, ZONES);
    assert.equal(match.outcome, "matched");
    assert.equal(match.zone?.id, "lkn");
  });

  it("matches a Huntersville address to North Meck", () => {
    const place = lookupPostalCode("28078")!;
    assert.equal(matchZone(place, ZONES).zone?.id, "nm");
  });

  it("waitlists an address whose nearest zone is only planned", () => {
    const place = lookupPostalCode("29730")!; // Rock Hill
    const match = matchZone(place, ZONES);
    assert.equal(match.outcome, "waitlist_planned");
    assert.equal(match.zone, null);
    assert.equal(match.nearest?.id, "rh");
    assert.ok((match.distanceMiles ?? 99) < 5);
  });

  it("never assigns a planned zone as a live match", () => {
    for (const zip of ["29730", "29732", "29745"]) {
      const match = matchZone(lookupPostalCode(zip)!, ZONES);
      assert.equal(match.zone, null, zip);
    }
  });

  it("reports distance from the zone it matched", () => {
    const match = matchZone(lookupPostalCode("28117")!, ZONES);
    assert.equal(match.outcome, "matched");
    assert.ok(match.distanceMiles !== null && match.distanceMiles >= 0);
  });

  it("handles having no zones at all", () => {
    const match = matchZone({ lat: 35.5, lng: -80.8 }, []);
    assert.equal(match.outcome, "no_zones");
    assert.equal(match.zone, null);
  });
});

// --- savings estimate -------------------------------------------------------

const oil: Product = {
  id: "oil",
  sku: "OIL-35",
  name: "Fryer Oil",
  category: "oils_fats",
  packDescription: "1/35 lb",
  casesPerPallet: 48,
  caseWeightLb: 36,
  listPriceCents: 3000,
  tiers: [
    { minCases: 50, unitPriceCents: 2850 },
    { minCases: 250, unitPriceCents: 2600 },
    { minCases: 1000, unitPriceCents: 2400 },
  ],
};

const carrier: Carrier = {
  id: "c1",
  name: "Test Carrier",
  equipment: "dry_van",
  capacityPallets: 26,
  maxWeightLb: 45000,
  linehaulRateCents: 285,
  minChargeCents: 45000,
  stopChargeCents: 7500,
  liftgateFeeCents: 4500,
};

const CHARLOTTE = { lat: 35.205, lng: -80.88 };
const MOORESVILLE = { lat: 35.5826, lng: -80.8176 };
const STATESVILLE = { lat: 35.7826, lng: -80.8873 };
const HUNTERSVILLE = { lat: 35.4107, lng: -80.8428 };

const products = new Map([["oil", oil]]);

const existingStop = (id: string, point: { lat: number; lng: number }, cases: number) => ({
  businessId: id,
  point,
  dockType: "liftgate" as const,
  items: [{ product: oil, cases }],
});

const baseInput = {
  destination: MOORESVILLE,
  dockType: "liftgate" as const,
  demand: new Map([["oil", 40]]),
  products,
  zoneDemand: new Map([["oil", 300]]),
  existingStops: [
    existingStop("a", STATESVILLE, 150),
    existingStop("b", HUNTERSVILLE, 150),
  ],
  supplierOrigin: CHARLOTTE,
  carrier,
  fees: { kind: "savings_share" as const, shareBps: 2000 },
  cyclesPerMonth: 2,
};

describe("savings estimate", () => {
  it("prices the applicant at the pooled tier, not their own", () => {
    const e = estimateSavings(baseInput);
    const line = e.lines[0];
    // 40 cases alone reaches nothing; 340 pooled reaches the 250 break.
    assert.equal(line.soloUnitCents, 3000);
    assert.equal(line.pooledUnitCents, 2600);
    assert.equal(line.savingsCents, 40 * 400);
  });

  it("scales the monthly figure by the cycle cadence", () => {
    const e = estimateSavings(baseInput);
    assert.equal(e.netPerMonthCents, Math.round(e.netPerCycleCents * 2));
  });

  it("never charges a fee larger than the savings", () => {
    const e = estimateSavings(baseInput);
    const gross = e.goodsSavingsCents + e.freightSavingsCents;
    assert.ok(e.feesCents <= Math.max(0, gross));
    assert.equal(e.netPerCycleCents, gross - e.feesCents);
  });

  it("says plainly when pooling moves the price not at all", () => {
    // An applicant already buying past the deepest break.
    const e = estimateSavings({
      ...baseInput,
      demand: new Map([["oil", 1200]]),
      zoneDemand: new Map([["oil", 0]]),
    });
    assert.equal(e.goodsSavingsCents, 0);
    assert.ok(e.caveats.some((c) => c.kind === "goods_flat"));
  });

  it("warns when the zone is too thin for consolidation to pay", () => {
    const e = estimateSavings({ ...baseInput, existingStops: [] });
    assert.ok(e.caveats.some((c) => c.kind === "thin_zone"));
    assert.ok(e.caveats.some((c) => c.kind === "no_history"));
  });

  it("does not warn about a thin zone once there are enough stops", () => {
    const e = estimateSavings({
      ...baseInput,
      existingStops: [
        existingStop("a", STATESVILLE, 100),
        existingStop("b", HUNTERSVILLE, 100),
        existingStop("c", { lat: 35.4868, lng: -80.8601 }, 100),
      ],
    });
    assert.equal(e.caveats.some((c) => c.kind === "thin_zone"), false);
  });

  it("labels itself an estimate until a carrier has rated it", () => {
    const e = estimateSavings(baseInput);
    assert.equal(e.isBenchmarked, true);
    assert.ok(e.caveats.some((c) => c.kind === "benchmark"));
  });

  it("drops the estimate caveat when a real quote is supplied", () => {
    const e = estimateSavings({ ...baseInput, quotedSoloFreightCents: 21_000 });
    assert.equal(e.isBenchmarked, false);
    assert.equal(e.freightSoloCents, 21_000);
    assert.equal(e.caveats.some((c) => c.kind === "benchmark"), false);
  });

  it("flags a freight position that loses money", () => {
    // A dock-equipped applicant with a large pallet share: cheap LTL alone,
    // expensive share of a truck.
    const e = estimateSavings({
      ...baseInput,
      dockType: "dock",
      demand: new Map([["oil", 600]]),
    });
    if (e.freightSavingsCents < 0) {
      assert.ok(e.caveats.some((c) => c.kind === "freight_loss"));
    }
  });

  it("ignores products the cycle's supplier does not carry", () => {
    const e = estimateSavings({
      ...baseInput,
      demand: new Map([
        ["oil", 40],
        ["not-stocked", 99],
      ]),
    });
    assert.equal(e.lines.length, 1);
  });

  it("produces a coherent empty estimate when nothing is declared", () => {
    const e = estimateSavings({ ...baseInput, demand: new Map() });
    assert.equal(e.lines.length, 0);
    assert.equal(e.goodsSavingsCents, 0);
  });

  it("charges a spend-based fee against pooled goods, not savings", () => {
    const e = estimateSavings({
      ...baseInput,
      fees: { kind: "spend_bps", procurementFeeBps: 250, freightCoordFeeCents: 2500 },
    });
    assert.equal(e.feesCents, Math.round(e.goodsPooledCents * 0.025) + 2500);
  });
});
