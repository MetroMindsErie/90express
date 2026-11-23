import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  dollarsToCents,
  HttpCarrierAdapter,
  HttpSupplierAdapter,
  ManualCarrierAdapter,
  parseCatalogCsv,
  parseCsv,
} from "./adapters";
import { diffCatalog, type ExistingProduct } from "./diff";
import { IntegrationError, catalogItemSchema, type ProviderConfig } from "./types";

// --- CSV parsing ------------------------------------------------------------

describe("parseCsv", () => {
  it("reads plain rows", () => {
    assert.deepEqual(parseCsv("a,b\n1,2"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    assert.deepEqual(parseCsv('sku,name\nX,"Bags, Kraft"'), [
      ["sku", "name"],
      ["X", "Bags, Kraft"],
    ]);
  });

  it("handles doubled quotes, which is how Excel writes inches", () => {
    assert.deepEqual(parseCsv('name\n"9"" Clamshell"'), [["name"], ['9" Clamshell']]);
  });

  it("handles newlines inside quoted fields", () => {
    assert.deepEqual(parseCsv('a\n"line1\nline2"'), [["a"], ["line1\nline2"]]);
  });

  it("handles CRLF line endings", () => {
    assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips the UTF-8 BOM Excel prepends", () => {
    const rows = parseCsv("﻿sku,name\nX,Y");
    assert.equal(rows[0][0], "sku");
  });

  it("drops blank lines rather than emitting empty rows", () => {
    assert.deepEqual(parseCsv("a\n\n1\n\n"), [["a"], ["1"]]);
  });
});

describe("dollarsToCents", () => {
  it("parses the usual forms", () => {
    assert.equal(dollarsToCents("$28.50"), 2850);
    assert.equal(dollarsToCents("28.50"), 2850);
    assert.equal(dollarsToCents("1,234.56"), 123456);
    assert.equal(dollarsToCents("7"), 700);
    assert.equal(dollarsToCents("7.5"), 750);
  });

  it("does not lose a cent to binary floating point", () => {
    // 28.50 * 100 is 2849.9999999999995 in IEEE 754.
    for (const d of ["28.50", "1.10", "4.70", "70.07", "0.29"]) {
      const cents = dollarsToCents(d);
      assert.equal(cents, Math.round(Number(d) * 100), `${d} -> ${cents}`);
      assert.ok(Number.isInteger(cents));
    }
  });

  it("rejects anything that is not a decimal amount", () => {
    for (const bad of ["", "abc", "12.345", "1.2.3", "$", "12e3"]) {
      assert.throws(() => dollarsToCents(bad), IntegrationError, `accepted "${bad}"`);
    }
  });
});

const HEADER =
  "sku,name,category,pack_description,cases_per_pallet,case_weight_lb,list_price,temp_class,discontinued,tier_1_min,tier_1_price,tier_2_min,tier_2_price";

describe("parseCatalogCsv", () => {
  it("parses a price sheet with a volume ladder", () => {
    const items = parseCatalogCsv(
      `${HEADER}\nCUP-16,16 oz Cups,disposables,20/50 ct,36,22,$52.90,dry,,40,$49.90,200,$46.50`,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].listPriceCents, 5290);
    assert.deepEqual(items[0].tiers, [
      { minCases: 40, unitPriceCents: 4990 },
      { minCases: 200, unitPriceCents: 4650 },
    ]);
  });

  it("reads columns by header name, not position", () => {
    const reordered =
      "list_price,sku,category,name,pack_description,cases_per_pallet,case_weight_lb,temp_class";
    const items = parseCatalogCsv(
      `${reordered}\n$12.00,A-1,dry_goods,Thing,1/ea,40,10,dry`,
    );
    assert.equal(items[0].sku, "A-1");
    assert.equal(items[0].listPriceCents, 1200);
    assert.equal(items[0].casesPerPallet, 40);
  });

  it("marks discontinued rows", () => {
    const items = parseCatalogCsv(
      `${HEADER}\nX-1,Gone,disposables,1/ea,10,5,$1.00,dry,Y,,,,`,
    );
    assert.equal(items[0].discontinued, true);
  });

  it("refuses a sheet missing a required column", () => {
    assert.throws(
      () => parseCatalogCsv("sku,name\nA,B"),
      /missing the "category" column|missing the "pack_description" column/,
    );
  });

  it("refuses a sheet with no data rows", () => {
    assert.throws(() => parseCatalogCsv(HEADER), /no data rows/);
  });

  it("names the offending row and SKU when a value is out of range", () => {
    assert.throws(
      () =>
        parseCatalogCsv(
          `${HEADER}\nBAD-1,Thing,disposables,1/ea,0,10,$1.00,dry,,,,,`,
        ),
      /row 2 \(SKU "BAD-1"\)/,
    );
  });

  it("rejects a negative price rather than storing it", () => {
    assert.throws(
      () =>
        parseCatalogCsv(
          `${HEADER}\nNEG-1,Thing,disposables,1/ea,10,10,-$5.00,dry,,,,,`,
        ),
      /SKU "NEG-1"/,
    );
  });
});

// --- schema bounds ----------------------------------------------------------

describe("catalog item validation", () => {
  const base = {
    sku: "A",
    name: "Thing",
    category: "dry_goods",
    packDescription: "1/ea",
    casesPerPallet: 40,
    caseWeightLb: 10,
    listPriceCents: 1000,
  };

  it("accepts a well-formed item", () => {
    assert.equal(catalogItemSchema.safeParse(base).success, true);
  });

  it("rejects a price that is really dollars", () => {
    // 2_000_000 cents is $20,000 a case: past the ceiling on purpose.
    assert.equal(
      catalogItemSchema.safeParse({ ...base, listPriceCents: 50_000_00 * 3 }).success,
      false,
    );
  });

  it("rejects a non-integer price", () => {
    assert.equal(
      catalogItemSchema.safeParse({ ...base, listPriceCents: 10.5 }).success,
      false,
    );
  });

  it("rejects an impossible pallet count", () => {
    assert.equal(
      catalogItemSchema.safeParse({ ...base, casesPerPallet: 0 }).success,
      false,
    );
  });
});

// --- catalog diff -----------------------------------------------------------

const existingProduct = (over: Partial<ExistingProduct> = {}): ExistingProduct => ({
  id: "p1",
  sku: "OIL-35",
  name: "Fryer Oil",
  category: "oils_fats",
  packDescription: "1/35 lb",
  casesPerPallet: 48,
  caseWeightLb: 36,
  listPriceCents: 3000,
  tempClass: "dry",
  active: true,
  tiers: [
    { minCases: 50, unitPriceCents: 2850 },
    { minCases: 250, unitPriceCents: 2600 },
  ],
  ...over,
});

const incomingItem = (over: Record<string, unknown> = {}) =>
  catalogItemSchema.parse({
    sku: "OIL-35",
    name: "Fryer Oil",
    category: "oils_fats",
    packDescription: "1/35 lb",
    casesPerPallet: 48,
    caseWeightLb: 36,
    listPriceCents: 3000,
    tempClass: "dry",
    tiers: [
      { minCases: 50, unitPriceCents: 2850 },
      { minCases: 250, unitPriceCents: 2600 },
    ],
    ...over,
  });

describe("diffCatalog", () => {
  it("reports nothing when the feed matches", () => {
    assert.deepEqual(diffCatalog([existingProduct()], [incomingItem()]), []);
  });

  it("is insensitive to tier ordering", () => {
    const changes = diffCatalog(
      [existingProduct()],
      [
        incomingItem({
          tiers: [
            { minCases: 250, unitPriceCents: 2600 },
            { minCases: 50, unitPriceCents: 2850 },
          ],
        }),
      ],
    );
    assert.deepEqual(changes, []);
  });

  it("detects a list price change and signs the delta", () => {
    const [change] = diffCatalog(
      [existingProduct()],
      [incomingItem({ listPriceCents: 3140 })],
    );
    assert.equal(change.changeType, "price");
    assert.equal(change.unitDeltaCents, 140);
    assert.equal(change.productId, "p1");
  });

  it("signs a price cut negative", () => {
    const [change] = diffCatalog(
      [existingProduct()],
      [incomingItem({ listPriceCents: 2900 })],
    );
    assert.equal(change.unitDeltaCents, -100);
  });

  it("detects a ladder change and measures it at the deepest break", () => {
    const [change] = diffCatalog(
      [existingProduct()],
      [
        incomingItem({
          tiers: [
            { minCases: 50, unitPriceCents: 2850 },
            { minCases: 250, unitPriceCents: 2600 },
            { minCases: 600, unitPriceCents: 2450 },
          ],
        }),
      ],
    );
    assert.equal(change.changeType, "tier");
    assert.equal(change.unitDeltaCents, 2450 - 2600);
  });

  it("detects a pack-out change, which moves freight shares", () => {
    const [change] = diffCatalog(
      [existingProduct()],
      [incomingItem({ casesPerPallet: 54 })],
    );
    assert.equal(change.changeType, "pack");
  });

  it("proposes a product the supplier offers and we do not carry", () => {
    const [change] = diffCatalog([], [incomingItem({ sku: "OIL-CAN" })]);
    assert.equal(change.changeType, "new_product");
    assert.equal(change.productId, null);
  });

  it("does not propose adding something already discontinued", () => {
    assert.deepEqual(diffCatalog([], [incomingItem({ discontinued: true })]), []);
  });

  it("treats a SKU absent from the sheet as no longer offered", () => {
    const [change] = diffCatalog([existingProduct()], []);
    assert.equal(change.changeType, "discontinued");
    assert.equal(change.productId, "p1");
  });

  it("does not re-flag a product already inactive", () => {
    assert.deepEqual(diffCatalog([existingProduct({ active: false })], []), []);
  });

  it("flags a SKU the feed marks discontinued", () => {
    const [change] = diffCatalog(
      [existingProduct()],
      [incomingItem({ discontinued: true })],
    );
    assert.equal(change.changeType, "discontinued");
  });

  it("reports price and ladder separately when both move", () => {
    const changes = diffCatalog(
      [existingProduct()],
      [
        incomingItem({
          listPriceCents: 3140,
          tiers: [{ minCases: 50, unitPriceCents: 2985 }],
        }),
      ],
    );
    assert.deepEqual(
      changes.map((c) => c.changeType).sort(),
      ["price", "tier"],
    );
  });
});

// --- HTTP adapters against a real socket ------------------------------------

describe("HTTP adapters", () => {
  let server: Server;
  let port = 0;
  // Each route name selects a response shape, including the broken ones.
  const routes = new Map<string, { status: number; body: string; type?: string }>();

  before(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer test-token") {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end('{"error":"unauthorized"}');
      }
      const key = `${req.method} ${req.url?.split("?")[0]}`;
      const route = routes.get(key);
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        return res.end('{"error":"not found"}');
      }
      res.writeHead(route.status, {
        "content-type": route.type ?? "application/json",
        "content-length": Buffer.byteLength(route.body),
      });
      res.end(route.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });
    process.env.TEST_PARTNER_TOKEN = "test-token";
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const config = (): ProviderConfig => ({
    id: "prov",
    name: "Test Partner",
    adapter: "http",
    baseUrl: `http://127.0.0.1:${port}`,
    authEnvVar: "TEST_PARTNER_TOKEN",
    sourcePath: null,
    partnerRef: "acme",
  });

  it("fetches and validates a catalog", async () => {
    routes.set(
      "GET /supplier/acme/catalog",
      {
        status: 200,
        body: JSON.stringify({
          items: [
            {
              sku: "A-1",
              name: "Thing",
              category: "dry_goods",
              packDescription: "1/ea",
              casesPerPallet: 40,
              caseWeightLb: 10,
              listPriceCents: 1000,
              tiers: [{ minCases: 10, unitPriceCents: 950 }],
            },
          ],
        }),
      },
    );
    const items = await new HttpSupplierAdapter(config()).fetchCatalog();
    assert.equal(items.length, 1);
    assert.equal(items[0].listPriceCents, 1000);
    // Defaults are applied at the boundary, not left undefined downstream.
    assert.equal(items[0].tempClass, "dry");
    assert.equal(items[0].discontinued, false);
  });

  it("rejects a payload that fails validation instead of storing it", async () => {
    routes.set("GET /supplier/acme/catalog", {
      status: 200,
      body: JSON.stringify({
        items: [{ sku: "A-1", name: "Thing", listPriceCents: -5 }],
      }),
    });
    await assert.rejects(
      () => new HttpSupplierAdapter(config()).fetchCatalog(),
      /failed validation/,
    );
  });

  it("rejects a body that is not JSON", async () => {
    routes.set("GET /supplier/acme/catalog", {
      status: 200,
      body: "<html>maintenance</html>",
      type: "text/html",
    });
    await assert.rejects(
      () => new HttpSupplierAdapter(config()).fetchCatalog(),
      /not JSON/,
    );
  });

  it("surfaces a partner error status", async () => {
    routes.set("GET /supplier/acme/catalog", {
      status: 500,
      body: '{"error":"boom"}',
    });
    await assert.rejects(
      () => new HttpSupplierAdapter(config()).fetchCatalog(),
      /returned 500/,
    );
  });

  it("fails loudly when the token env var is unset", async () => {
    const missing = { ...config(), authEnvVar: "DEFINITELY_NOT_SET_12345" };
    await assert.rejects(
      () => new HttpSupplierAdapter(missing).fetchCatalog(),
      /needs a token in DEFINITELY_NOT_SET_12345/,
    );
  });

  it("reports an unreachable partner rather than hanging", async () => {
    const dead = { ...config(), baseUrl: "http://127.0.0.1:1" };
    await assert.rejects(
      () => new HttpSupplierAdapter(dead).fetchCatalog(),
      /unreachable/,
    );
  });

  it("rates a load and validates the quote", async () => {
    routes.set("POST /carrier/acme/rates", {
      status: 200,
      body: JSON.stringify({
        quotes: [
          {
            quoteRef: "R-1",
            linehaulCents: 45_000,
            accessorialCents: 30_000,
            totalCents: 75_000,
            transitDays: 1,
          },
        ],
      }),
    });
    const quotes = await new HttpCarrierAdapter(config()).rate({
      origin: { lat: 35.2, lng: -80.8 },
      stops: [
        { ref: "a", lat: 35.5, lng: -80.8, pallets: 3, weightLb: 1200, liftgate: true },
      ],
      pickupDate: "2026-12-01",
      equipment: "dry_van",
    });
    assert.equal(quotes[0].totalCents, 75_000);
  });

  it("rejects a tender response with an unknown status", async () => {
    routes.set("POST /carrier/acme/tenders", {
      status: 200,
      body: JSON.stringify({ tenderRef: "T-1", status: "maybe" }),
    });
    await assert.rejects(
      () =>
        new HttpCarrierAdapter(config()).tender({
          origin: { lat: 35.2, lng: -80.8 },
          stops: [],
          pickupDate: "2026-12-01",
          equipment: "dry_van",
          quoteRef: null,
          shipmentRef: "s1",
          idempotencyKey: "k1",
        }),
      /failed validation/,
    );
  });
});

describe("manual adapters", () => {
  const config: ProviderConfig = {
    id: "p",
    name: "Queen City Drayage",
    adapter: "manual",
    baseUrl: null,
    authEnvVar: null,
    sourcePath: null,
    partnerRef: "queencity",
  };

  it("say plainly that there is no API rather than pretending", async () => {
    await assert.rejects(
      () => new ManualCarrierAdapter(config).rate(),
      /has no API/,
    );
  });
});
