/**
 * Concrete supplier and carrier adapters.
 *
 * Three transports, because small distributors and small carriers are not
 * all going to have an API:
 *
 *   csv    — a price sheet file. This is how most independent distributors
 *            actually publish prices, and supporting it is the difference
 *            between onboarding a supplier this month and next year.
 *   http   — a JSON API against the contracts in types.ts.
 *   manual — what the system did before: a human keys it in. Kept as a real
 *            adapter so a manual supplier is a first-class provider with a
 *            run history rather than a gap in the model.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { partnerFetch } from "./http";
import {
  carrierInvoiceSchema,
  catalogItemSchema,
  catalogResponseSchema,
  invoiceResponseSchema,
  IntegrationError,
  orderAckSchema,
  rateResponseSchema,
  supplierQuoteSchema,
  tenderResponseSchema,
  trackingResponseSchema,
  type AdapterKind,
  type CarrierAdapter,
  type CarrierInvoice,
  type CatalogItem,
  type OrderAck,
  type ProviderConfig,
  type RateQuote,
  type RateRequest,
  type SupplierAdapter,
  type SupplierQuote,
  type TenderRequest,
  type TenderResponse,
  type TrackingUpdate,
} from "./types";

// ---------------------------------------------------------------------------
// CSV price sheets
// ---------------------------------------------------------------------------

/**
 * Minimal RFC-4180 reader: quoted fields, doubled quotes, embedded commas
 * and newlines. Price sheets come out of Excel and all of those turn up.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // Strip a UTF-8 BOM, which Excel adds and which corrupts the first header.
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** "$28.50" / "28.50" / "2850¢" -> 2850. Rejects anything else. */
export function dollarsToCents(raw: string): number {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") throw new IntegrationError("Empty price field.");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new IntegrationError(`Price "${raw}" is not a decimal amount.`);
  }
  // Round through a string-free path to dodge 28.50 * 100 = 2849.9999.
  const [whole, frac = ""] = cleaned.split(".");
  const padded = (frac + "00").slice(0, 2);
  const sign = whole.startsWith("-") ? -1 : 1;
  return sign * (Math.abs(Number(whole)) * 100 + Number(padded));
}

const CSV_COLUMNS = [
  "sku",
  "name",
  "category",
  "pack_description",
  "cases_per_pallet",
  "case_weight_lb",
  "list_price",
  "temp_class",
] as const;

/**
 * Price sheet layout: the fixed columns above, then up to six repeating
 * `tier_n_min` / `tier_n_price` pairs. Columns are matched by header name so
 * a supplier reordering its export does not silently shift prices into the
 * weight column.
 */
export function parseCatalogCsv(text: string): CatalogItem[] {
  const rows = parseCsv(text);
  if (rows.length < 2) {
    throw new IntegrationError("Price sheet has no data rows.");
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const index = (name: string) => header.indexOf(name);

  for (const required of CSV_COLUMNS) {
    if (index(required) === -1) {
      throw new IntegrationError(
        `Price sheet is missing the "${required}" column. Found: ${header.join(", ")}`,
      );
    }
  }

  const items: CatalogItem[] = [];
  for (const [n, row] of rows.slice(1).entries()) {
    const cell = (name: string) => (row[index(name)] ?? "").trim();

    const tiers: Array<{ minCases: number; unitPriceCents: number }> = [];
    for (let t = 1; t <= 6; t++) {
      const minCol = index(`tier_${t}_min`);
      const priceCol = index(`tier_${t}_price`);
      if (minCol === -1 || priceCol === -1) continue;
      const min = (row[minCol] ?? "").trim();
      const price = (row[priceCol] ?? "").trim();
      if (min === "" || price === "") continue;
      tiers.push({
        minCases: Number(min),
        unitPriceCents: dollarsToCents(price),
      });
    }

    const discontinued = cell("discontinued").toLowerCase();
    const candidate = {
      sku: cell("sku"),
      name: cell("name"),
      category: cell("category"),
      packDescription: cell("pack_description"),
      casesPerPallet: Number(cell("cases_per_pallet")),
      caseWeightLb: Number(cell("case_weight_lb")),
      listPriceCents: dollarsToCents(cell("list_price")),
      tempClass: cell("temp_class") || "dry",
      tiers,
      discontinued: discontinued === "y" || discontinued === "true" || discontinued === "1",
    };

    const parsed = catalogItemSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new IntegrationError(
        `Price sheet row ${n + 2} (SKU "${candidate.sku}") is invalid: ${parsed.error.issues[0]?.message}`,
        parsed.error.issues.slice(0, 3),
      );
    }
    items.push(parsed.data);
  }

  return items;
}

export class CsvSupplierAdapter implements SupplierAdapter {
  readonly kind: AdapterKind = "csv";
  constructor(readonly config: ProviderConfig) {}

  async fetchCatalog(): Promise<CatalogItem[]> {
    if (!this.config.sourcePath) {
      throw new IntegrationError(`${this.config.name} has no price sheet path.`);
    }
    // Resolve inside the repo and refuse to climb out of it: the path comes
    // from a database row, which is not the same as being trustworthy.
    const root = process.cwd();
    const resolved = path.resolve(root, this.config.sourcePath);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new IntegrationError(
        `${this.config.name} price sheet path escapes the project directory.`,
      );
    }
    let text: string;
    try {
      text = await readFile(resolved, "utf8");
    } catch {
      throw new IntegrationError(
        `Price sheet not found at ${this.config.sourcePath}.`,
      );
    }
    return parseCatalogCsv(text);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export class HttpSupplierAdapter implements SupplierAdapter {
  readonly kind: AdapterKind = "http";
  constructor(readonly config: ProviderConfig) {}

  async fetchCatalog(): Promise<CatalogItem[]> {
    const res = await partnerFetch(
      this.config,
      `/supplier/${encodeURIComponent(this.config.partnerRef)}/catalog`,
      catalogResponseSchema,
    );
    return res.items;
  }

  async requestQuote(req: {
    lines: Array<{ sku: string; totalCases: number }>;
    deliveryDate: string;
  }): Promise<SupplierQuote> {
    return partnerFetch(
      this.config,
      `/supplier/${encodeURIComponent(this.config.partnerRef)}/quote`,
      supplierQuoteSchema,
      { method: "POST", body: req },
    );
  }

  async submitOrder(req: {
    quoteRef: string;
    deliveryDate: string;
    idempotencyKey: string;
    lines: Array<{ sku: string; totalCases: number; buyerRef: string }>;
  }): Promise<OrderAck> {
    return partnerFetch(
      this.config,
      `/supplier/${encodeURIComponent(this.config.partnerRef)}/orders`,
      orderAckSchema,
      { method: "POST", body: req, idempotencyKey: req.idempotencyKey },
    );
  }
}

export class HttpCarrierAdapter implements CarrierAdapter {
  readonly kind: AdapterKind = "http";
  constructor(readonly config: ProviderConfig) {}

  private base(suffix: string) {
    return `/carrier/${encodeURIComponent(this.config.partnerRef)}${suffix}`;
  }

  async rate(req: RateRequest): Promise<RateQuote[]> {
    const res = await partnerFetch(this.config, this.base("/rates"), rateResponseSchema, {
      method: "POST",
      body: req,
    });
    return res.quotes;
  }

  async tender(req: TenderRequest): Promise<TenderResponse> {
    return partnerFetch(this.config, this.base("/tenders"), tenderResponseSchema, {
      method: "POST",
      body: req,
      idempotencyKey: req.idempotencyKey,
    });
  }

  async track(tenderRef: string): Promise<TrackingUpdate[]> {
    const res = await partnerFetch(
      this.config,
      this.base(`/tenders/${encodeURIComponent(tenderRef)}/tracking`),
      trackingResponseSchema,
    );
    return res.events;
  }

  async fetchInvoices(sinceIso: string): Promise<CarrierInvoice[]> {
    const res = await partnerFetch(
      this.config,
      this.base(`/invoices?since=${encodeURIComponent(sinceIso)}`),
      invoiceResponseSchema,
    );
    return res.invoices;
  }
}

// ---------------------------------------------------------------------------
// Manual
// ---------------------------------------------------------------------------

/**
 * A supplier with no feed at all.
 *
 * It still gets a provider row and a run history, so "this catalog is 94 days
 * stale because nobody has retyped it" is visible on the same screen as every
 * other provider, instead of being invisible.
 */
export class ManualSupplierAdapter implements SupplierAdapter {
  readonly kind: AdapterKind = "manual";
  constructor(readonly config: ProviderConfig) {}

  async fetchCatalog(): Promise<CatalogItem[]> {
    throw new IntegrationError(
      `${this.config.name} has no automated feed. Its catalog is maintained by hand.`,
    );
  }
}

export class ManualCarrierAdapter implements CarrierAdapter {
  readonly kind: AdapterKind = "manual";
  constructor(readonly config: ProviderConfig) {}

  private unsupported(): never {
    throw new IntegrationError(
      `${this.config.name} has no API. Rate, tender and track it by phone or email, and record the result here.`,
    );
  }

  async rate(): Promise<RateQuote[]> {
    this.unsupported();
  }
  async tender(): Promise<TenderResponse> {
    this.unsupported();
  }
  async track(): Promise<TrackingUpdate[]> {
    this.unsupported();
  }
  async fetchInvoices(): Promise<CarrierInvoice[]> {
    this.unsupported();
  }
}

export function supplierAdapterFor(config: ProviderConfig): SupplierAdapter {
  switch (config.adapter) {
    case "csv":
      return new CsvSupplierAdapter(config);
    case "http":
      return new HttpSupplierAdapter(config);
    default:
      return new ManualSupplierAdapter(config);
  }
}

export function carrierAdapterFor(config: ProviderConfig): CarrierAdapter {
  switch (config.adapter) {
    case "http":
      return new HttpCarrierAdapter(config);
    default:
      return new ManualCarrierAdapter(config);
  }
}

export { carrierInvoiceSchema };
