/**
 * Diff an incoming supplier catalog against the one we hold.
 *
 * Pure. The output is a list of proposed changes, never an applied change:
 * a feed must not be able to move a price under a live pool by itself. An
 * operator applies each one after seeing what it does to open cycles.
 *
 * A price sheet that simply omits a SKU is treated as "no longer offered",
 * not as a deletion. Discontinuation deactivates the product; it never drops
 * the row, because settled cycles reference it.
 */
import type { CatalogItem } from "./types";

export type ExistingProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  packDescription: string;
  casesPerPallet: number;
  caseWeightLb: number;
  listPriceCents: number;
  tempClass: string;
  active: boolean;
  tiers: Array<{ minCases: number; unitPriceCents: number }>;
};

export type ProposedChange = {
  sku: string;
  productId: string | null;
  productName: string;
  changeType: "price" | "tier" | "new_product" | "discontinued" | "pack";
  oldValue: unknown;
  newValue: unknown;
  /** Per-case delta at list price. Positive means members pay more. */
  unitDeltaCents: number;
};

const sortTiers = (t: Array<{ minCases: number; unitPriceCents: number }>) =>
  [...t].sort((a, b) => a.minCases - b.minCases);

function tiersEqual(
  a: Array<{ minCases: number; unitPriceCents: number }>,
  b: Array<{ minCases: number; unitPriceCents: number }>,
): boolean {
  if (a.length !== b.length) return false;
  const x = sortTiers(a);
  const y = sortTiers(b);
  return x.every(
    (t, i) => t.minCases === y[i].minCases && t.unitPriceCents === y[i].unitPriceCents,
  );
}

export function diffCatalog(
  existing: ExistingProduct[],
  incoming: CatalogItem[],
): ProposedChange[] {
  const bySku = new Map(existing.map((p) => [p.sku, p]));
  const seen = new Set<string>();
  const changes: ProposedChange[] = [];

  for (const item of incoming) {
    seen.add(item.sku);
    const current = bySku.get(item.sku);

    if (!current) {
      if (item.discontinued) continue; // nothing to add
      changes.push({
        sku: item.sku,
        productId: null,
        productName: item.name,
        changeType: "new_product",
        oldValue: null,
        newValue: item,
        unitDeltaCents: 0,
      });
      continue;
    }

    if (item.discontinued) {
      if (current.active) {
        changes.push({
          sku: item.sku,
          productId: current.id,
          productName: current.name,
          changeType: "discontinued",
          oldValue: { active: true },
          newValue: { active: false },
          unitDeltaCents: 0,
        });
      }
      continue;
    }

    if (item.listPriceCents !== current.listPriceCents) {
      changes.push({
        sku: item.sku,
        productId: current.id,
        productName: current.name,
        changeType: "price",
        oldValue: { listPriceCents: current.listPriceCents },
        newValue: { listPriceCents: item.listPriceCents },
        unitDeltaCents: item.listPriceCents - current.listPriceCents,
      });
    }

    if (!tiersEqual(current.tiers, item.tiers)) {
      // Report the change at the deepest break both ladders define, which is
      // where a pooled order actually lands.
      const oldBest = sortTiers(current.tiers).at(-1)?.unitPriceCents ?? current.listPriceCents;
      const newBest = sortTiers(item.tiers).at(-1)?.unitPriceCents ?? item.listPriceCents;
      changes.push({
        sku: item.sku,
        productId: current.id,
        productName: current.name,
        changeType: "tier",
        oldValue: { tiers: sortTiers(current.tiers) },
        newValue: { tiers: sortTiers(item.tiers) },
        unitDeltaCents: newBest - oldBest,
      });
    }

    // Pack-out changes matter beyond price: pallet counts drive the freight
    // allocation, so a silent change here moves everyone's freight share.
    const packChanged =
      item.casesPerPallet !== current.casesPerPallet ||
      Math.abs(item.caseWeightLb - current.caseWeightLb) > 0.001 ||
      item.packDescription !== current.packDescription;

    if (packChanged) {
      changes.push({
        sku: item.sku,
        productId: current.id,
        productName: current.name,
        changeType: "pack",
        oldValue: {
          packDescription: current.packDescription,
          casesPerPallet: current.casesPerPallet,
          caseWeightLb: current.caseWeightLb,
        },
        newValue: {
          packDescription: item.packDescription,
          casesPerPallet: item.casesPerPallet,
          caseWeightLb: item.caseWeightLb,
        },
        unitDeltaCents: 0,
      });
    }
  }

  // Offered before, absent now.
  for (const product of existing) {
    if (!seen.has(product.sku) && product.active) {
      changes.push({
        sku: product.sku,
        productId: product.id,
        productName: product.name,
        changeType: "discontinued",
        oldValue: { active: true },
        newValue: { active: false, reason: "absent from latest price sheet" },
        unitDeltaCents: 0,
      });
    }
  }

  return changes;
}
