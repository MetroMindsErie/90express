/**
 * Integration contracts.
 *
 * Everything a supplier or carrier sends is untrusted input. It is parsed
 * through the zod schemas here at the boundary and never passed into the
 * engine or the database in its raw form. A partner that sends a negative
 * price, a 900-pound case or a quote in dollars instead of cents should fail
 * loudly at the edge, not quietly corrupt a settlement three steps later.
 *
 * All money crossing these boundaries is integer cents, same as everywhere
 * else in the system. Adapters that talk to a partner using decimal dollars
 * convert at the edge and nowhere else.
 */
import { z } from "zod";

export type AdapterKind = "manual" | "csv" | "http";

/** Bounds that catch a misread unit before it reaches the database. */
const cents = z.number().int().min(0).max(100_000_00);
const positiveCents = z.number().int().min(1).max(100_000_00);

export const priceTierSchema = z.object({
  minCases: z.number().int().min(1).max(1_000_000),
  unitPriceCents: positiveCents,
});

export const catalogItemSchema = z.object({
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(64),
  packDescription: z.string().min(1).max(120),
  casesPerPallet: z.number().int().min(1).max(500),
  caseWeightLb: z.number().min(0.1).max(2_000),
  listPriceCents: positiveCents,
  tempClass: z.enum(["dry", "chill", "frozen"]).default("dry"),
  tiers: z.array(priceTierSchema).max(12).default([]),
  discontinued: z.boolean().default(false),
});

export type CatalogItem = z.infer<typeof catalogItemSchema>;

export const catalogResponseSchema = z.object({
  supplierRef: z.string().min(1).max(64).optional(),
  generatedAt: z.string().optional(),
  items: z.array(catalogItemSchema).max(5_000),
});

/**
 * A supplier's answer to "what will you charge for this collective order".
 *
 * `grantedUnitCents` may beat or miss the published ladder. Both are recorded;
 * see negotiated_prices.
 */
export const supplierQuoteSchema = z.object({
  quoteRef: z.string().min(1).max(64),
  validUntil: z.string().optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().min(1).max(64),
        totalCases: z.number().int().min(1).max(1_000_000),
        grantedUnitCents: positiveCents,
      }),
    )
    .max(1_000),
  minimumMet: z.boolean().default(true),
  note: z.string().max(500).optional(),
});

export type SupplierQuote = z.infer<typeof supplierQuoteSchema>;

export const orderAckSchema = z.object({
  orderRef: z.string().min(1).max(64),
  accepted: z.boolean(),
  expectedShipDate: z.string().optional(),
  rejectionReason: z.string().max(500).optional(),
});

export type OrderAck = z.infer<typeof orderAckSchema>;

// ---------------------------------------------------------------------------
// Carrier
// ---------------------------------------------------------------------------

export const rateQuoteSchema = z.object({
  quoteRef: z.string().min(1).max(64),
  serviceLevel: z.string().max(64).optional(),
  linehaulCents: cents,
  accessorialCents: cents.default(0),
  totalCents: positiveCents,
  transitDays: z.number().int().min(0).max(30).optional(),
  validUntil: z.string().optional(),
});

export type RateQuote = z.infer<typeof rateQuoteSchema>;

export const rateResponseSchema = z.object({
  quotes: z.array(rateQuoteSchema).max(20),
});

export const tenderResponseSchema = z.object({
  tenderRef: z.string().min(1).max(64),
  status: z.enum(["offered", "accepted", "declined", "expired"]),
  declineReason: z.string().max(500).optional(),
});

export type TenderResponse = z.infer<typeof tenderResponseSchema>;

export const trackingUpdateSchema = z.object({
  externalRef: z.string().min(1).max(96),
  code: z.string().min(1).max(32),
  message: z.string().min(1).max(500),
  occurredAt: z.string(),
  /** Which stop this refers to, by delivery sequence. */
  stopSequence: z.number().int().min(1).max(100).optional(),
  signedBy: z.string().max(120).optional(),
});

export type TrackingUpdate = z.infer<typeof trackingUpdateSchema>;

export const trackingResponseSchema = z.object({
  events: z.array(trackingUpdateSchema).max(500),
});

export const carrierInvoiceSchema = z.object({
  invoiceRef: z.string().min(1).max(64),
  tenderRef: z.string().min(1).max(64).optional(),
  invoiceDate: z.string(),
  linehaulCents: cents,
  accessorialCents: cents.default(0),
  totalCents: positiveCents,
  note: z.string().max(500).optional(),
});

export type CarrierInvoice = z.infer<typeof carrierInvoiceSchema>;

export const invoiceResponseSchema = z.object({
  invoices: z.array(carrierInvoiceSchema).max(500),
});

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

export type ProviderConfig = {
  id: string;
  name: string;
  adapter: AdapterKind;
  baseUrl: string | null;
  /** Name of the env var holding the token. Never the token. */
  authEnvVar: string | null;
  sourcePath: string | null;
  /** Partner's own id for the supplier or carrier, where it has one. */
  partnerRef: string;
};

export type RateRequest = {
  /** Supplier shipping point. */
  origin: { lat: number; lng: number };
  stops: Array<{
    ref: string;
    lat: number;
    lng: number;
    pallets: number;
    weightLb: number;
    liftgate: boolean;
  }>;
  pickupDate: string;
  equipment: string;
};

export type TenderRequest = RateRequest & {
  quoteRef: string | null;
  shipmentRef: string;
  /** Replayed on retry so the partner can discard a duplicate. */
  idempotencyKey: string;
};

export interface SupplierAdapter {
  readonly kind: AdapterKind;
  readonly config: ProviderConfig;
  /** Current catalog as the supplier publishes it. */
  fetchCatalog(): Promise<CatalogItem[]>;
  /** Price a pooled order. Not every supplier exposes this. */
  requestQuote?(req: {
    lines: Array<{ sku: string; totalCases: number }>;
    deliveryDate: string;
  }): Promise<SupplierQuote>;
  submitOrder?(req: {
    quoteRef: string;
    deliveryDate: string;
    idempotencyKey: string;
    lines: Array<{ sku: string; totalCases: number; buyerRef: string }>;
  }): Promise<OrderAck>;
}

export interface CarrierAdapter {
  readonly kind: AdapterKind;
  readonly config: ProviderConfig;
  rate(req: RateRequest): Promise<RateQuote[]>;
  tender(req: TenderRequest): Promise<TenderResponse>;
  track(tenderRef: string): Promise<TrackingUpdate[]>;
  fetchInvoices(sinceIso: string): Promise<CarrierInvoice[]>;
}

/** Raised when a partner responds but the payload cannot be trusted. */
export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}
