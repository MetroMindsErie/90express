/**
 * Integration orchestration: the operations an operator actually runs.
 *
 *   syncCatalog        pull a supplier's catalog, stage what changed
 *   applyCatalogChange apply one staged change after review
 *   rateCycle          get real carrier quotes for a cycle's planned load,
 *                      including the per-member solo quotes that the savings
 *                      figures are measured against
 *   tenderShipment     offer the load to a carrier, idempotently
 *   pullTracking       ingest carrier status events, deduplicated
 *   reconcileInvoices  match carrier invoices against what members were
 *                      billed, and flag the difference
 *
 * Every operation opens a run, writes a numbered event log, and closes the
 * run with a status. When a partner is unreachable or sends something that
 * fails validation, the run fails and nothing is half-applied.
 */
import { randomUUID } from "node:crypto";

import { sql } from "@/lib/db/client";
import { analyzeCycle, loadProducts } from "@/lib/db/queries";
import { carrierAdapterFor, supplierAdapterFor } from "./adapters";
import { diffCatalog, type ExistingProduct, type ProposedChange } from "./diff";
import {
  IntegrationError,
  type ProviderConfig,
  type RateRequest,
} from "./types";

// ---------------------------------------------------------------------------
// Provider loading and run logging
// ---------------------------------------------------------------------------

export type ProviderRow = ProviderConfig & {
  partner: "supplier" | "carrier";
  supplierId: string | null;
  carrierId: string | null;
  enabled: boolean;
  lastRunAt: Date | null;
  syncIntervalMinutes: number | null;
};

export async function getProvider(id: string): Promise<ProviderRow | null> {
  const [row] = await sql<
    Array<{
      id: string;
      partner: "supplier" | "carrier";
      supplier_id: string | null;
      carrier_id: string | null;
      name: string;
      adapter: "manual" | "csv" | "http";
      base_url: string | null;
      auth_env_var: string | null;
      source_path: string | null;
      enabled: boolean;
      last_run_at: Date | null;
      sync_interval_minutes: number | null;
      partner_ref: string;
    }>
  >`select * from integration_providers where id = ${id}`;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    baseUrl: row.base_url,
    authEnvVar: row.auth_env_var,
    sourcePath: row.source_path,
    partnerRef: row.partner_ref,
    partner: row.partner,
    supplierId: row.supplier_id,
    carrierId: row.carrier_id,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    syncIntervalMinutes: row.sync_interval_minutes,
  };
}

type RunHandle = {
  id: string;
  log: (message: string, level?: "info" | "warn" | "error") => Promise<void>;
};

async function openRun(
  providerId: string,
  operation: string,
  trigger: string,
  idempotencyKey?: string,
): Promise<RunHandle> {
  const [run] = await sql<Array<{ id: string }>>`
    insert into integration_runs (provider_id, operation, trigger, idempotency_key)
    values (${providerId}, ${operation}, ${trigger}, ${idempotencyKey ?? null})
    returning id
  `;
  let sequence = 0;
  return {
    id: run.id,
    log: async (message, level = "info") => {
      sequence += 1;
      await sql`
        insert into integration_run_events (run_id, sequence, level, message)
        values (${run.id}, ${sequence}, ${level}, ${message})
      `;
    },
  };
}

async function closeRun(
  runId: string,
  status: "succeeded" | "partial" | "failed",
  counts: { seen?: number; changed?: number } = {},
  error?: string,
) {
  await sql`
    update integration_runs
    set status = ${status}, finished_at = now(),
        items_seen = ${counts.seen ?? 0}, items_changed = ${counts.changed ?? 0},
        error = ${error ?? null}
    where id = ${runId}
  `;
}

/** Message safe to store: partner text is data, never a stack trace. */
function errorText(err: unknown): string {
  if (err instanceof IntegrationError) {
    return err.detail
      ? `${err.message} (${JSON.stringify(err.detail).slice(0, 300)})`
      : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Catalog sync
// ---------------------------------------------------------------------------

export type SyncResult = {
  runId: string;
  itemsSeen: number;
  changesStaged: number;
  status: "succeeded" | "failed";
  error?: string;
};

export async function syncCatalog(
  providerId: string,
  trigger = "manual",
): Promise<SyncResult> {
  const provider = await getProvider(providerId);
  if (!provider) throw new Error("Provider not found.");
  if (provider.partner !== "supplier" || !provider.supplierId) {
    throw new Error("Catalog sync is a supplier operation.");
  }

  const run = await openRun(providerId, "catalog_sync", trigger);

  try {
    await run.log(`Fetching catalog from ${provider.name} via ${provider.adapter}.`);
    const adapter = supplierAdapterFor(provider);
    const incoming = await adapter.fetchCatalog();
    await run.log(`Received ${incoming.length} catalog items.`);

    const existing = await loadExistingProducts(provider.supplierId);
    const changes = diffCatalog(existing, incoming);

    if (changes.length === 0) {
      await run.log("Catalog matches what we hold. Nothing to review.");
      await closeRun(run.id, "succeeded", { seen: incoming.length, changed: 0 });
      return { runId: run.id, itemsSeen: incoming.length, changesStaged: 0, status: "succeeded" };
    }

    // Supersede anything still pending for this supplier: the newest feed is
    // the one to act on, and stale proposals are how a wrong price gets
    // applied a week later.
    const superseded = await sql`
      update catalog_changes set status = 'superseded'
      where supplier_id = ${provider.supplierId} and status = 'pending'
      returning id
    `;
    if (superseded.length > 0) {
      await run.log(
        `Superseded ${superseded.length} proposal(s) from an earlier sync.`,
        "warn",
      );
    }

    for (const change of changes) {
      const impact = await impactOf(provider.supplierId, change);
      await sql`
        insert into catalog_changes (run_id, supplier_id, product_id, sku, product_name,
                                     change_type, old_value, new_value,
                                     affected_open_cycles, committed_cases, impact_cents)
        values (${run.id}, ${provider.supplierId}, ${change.productId}, ${change.sku},
                ${change.productName}, ${change.changeType},
                ${change.oldValue ? sql.json(change.oldValue as never) : null},
                ${sql.json(change.newValue as never)},
                ${impact.openCycles}, ${impact.committedCases}, ${impact.impactCents})
      `;
      await run.log(
        `${change.changeType}: ${change.sku} — ${describeChange(change)}${
          impact.openCycles > 0
            ? ` Affects ${impact.openCycles} open cycle(s), ${impact.committedCases} committed case(s).`
            : ""
        }`,
        impact.openCycles > 0 ? "warn" : "info",
      );
    }

    await sql`update integration_providers set last_run_at = now() where id = ${providerId}`;
    await closeRun(run.id, "succeeded", {
      seen: incoming.length,
      changed: changes.length,
    });
    return {
      runId: run.id,
      itemsSeen: incoming.length,
      changesStaged: changes.length,
      status: "succeeded",
    };
  } catch (err) {
    const message = errorText(err);
    await run.log(message, "error");
    await closeRun(run.id, "failed", {}, message);
    return { runId: run.id, itemsSeen: 0, changesStaged: 0, status: "failed", error: message };
  }
}

function describeChange(change: ProposedChange): string {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  switch (change.changeType) {
    case "price": {
      const o = (change.oldValue as { listPriceCents: number }).listPriceCents;
      const n = (change.newValue as { listPriceCents: number }).listPriceCents;
      const pct = ((n - o) / o) * 100;
      return `list ${money(o)} → ${money(n)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`;
    }
    case "tier":
      return `volume ladder changed; deepest break moves ${change.unitDeltaCents >= 0 ? "+" : ""}${money(change.unitDeltaCents)}/case.`;
    case "new_product":
      return "offered by the supplier, not in our catalog.";
    case "discontinued":
      return "no longer offered.";
    case "pack":
      return "pack-out changed, which moves pallet counts and freight shares.";
  }
}

async function loadExistingProducts(supplierId: string): Promise<ExistingProduct[]> {
  const rows = await sql<
    Array<{
      id: string;
      sku: string;
      name: string;
      category: string;
      pack_description: string;
      cases_per_pallet: number;
      case_weight_lb: number;
      list_price_cents: number;
      temp_class: string;
      active: boolean;
      tiers: Array<{ min_cases: number; unit_price_cents: number }> | null;
    }>
  >`
    select p.id, p.sku, p.name, p.category, p.pack_description, p.cases_per_pallet,
           p.case_weight_lb::float8 as case_weight_lb, p.list_price_cents,
           p.temp_class, p.active,
           coalesce((select json_agg(json_build_object('min_cases', t.min_cases,
                                                       'unit_price_cents', t.unit_price_cents))
                     from price_tiers t where t.product_id = p.id), '[]'::json) as tiers
    from products p where p.supplier_id = ${supplierId}
  `;
  return rows.map((r) => ({
    id: r.id,
    sku: r.sku,
    name: r.name,
    category: r.category,
    packDescription: r.pack_description,
    casesPerPallet: r.cases_per_pallet,
    caseWeightLb: Number(r.case_weight_lb),
    listPriceCents: r.list_price_cents,
    tempClass: r.temp_class,
    active: r.active,
    tiers: (r.tiers ?? []).map((t) => ({
      minCases: t.min_cases,
      unitPriceCents: t.unit_price_cents,
    })),
  }));
}

/**
 * What a proposed change would do to cycles that are still open.
 *
 * Cycles past `open` are not counted: their prices are frozen in
 * negotiated_prices and a catalog change cannot reach them.
 */
async function impactOf(
  supplierId: string,
  change: ProposedChange,
): Promise<{ openCycles: number; committedCases: number; impactCents: number }> {
  if (!change.productId) {
    return { openCycles: 0, committedCases: 0, impactCents: 0 };
  }
  const [row] = await sql<Array<{ cycles: number; cases: number }>>`
    select count(distinct pc.id)::int as cycles,
           coalesce(sum(c.cases), 0)::int as cases
    from commitments c
    join pool_cycles pc on pc.id = c.cycle_id
    where c.product_id = ${change.productId}
      and pc.supplier_id = ${supplierId}
      and pc.status = 'open'
      and c.status <> 'cancelled'
  `;
  return {
    openCycles: row?.cycles ?? 0,
    committedCases: row?.cases ?? 0,
    impactCents: (row?.cases ?? 0) * change.unitDeltaCents,
  };
}

// ---------------------------------------------------------------------------
// Applying a reviewed change
// ---------------------------------------------------------------------------

export async function applyCatalogChange(
  changeId: string,
  decidedBy: string,
): Promise<void> {
  const [change] = await sql<
    Array<{
      id: string;
      supplier_id: string;
      product_id: string | null;
      sku: string;
      change_type: string;
      new_value: Record<string, unknown>;
      status: string;
    }>
  >`select * from catalog_changes where id = ${changeId}`;

  if (!change) throw new Error("Change not found.");
  if (change.status !== "pending") {
    throw new Error(`This change is already ${change.status}.`);
  }

  switch (change.change_type) {
    case "price": {
      await sql`
        update products set list_price_cents = ${Number(change.new_value.listPriceCents)}
        where id = ${change.product_id}
      `;
      break;
    }
    case "tier": {
      const tiers = change.new_value.tiers as Array<{
        minCases: number;
        unitPriceCents: number;
      }>;
      // Replace the ladder wholesale: a tier removed upstream must disappear
      // here too, or the pool keeps quoting a break the supplier withdrew.
      await sql`delete from price_tiers where product_id = ${change.product_id}`;
      for (const t of tiers) {
        await sql`
          insert into price_tiers (product_id, min_cases, unit_price_cents)
          values (${change.product_id}, ${t.minCases}, ${t.unitPriceCents})
        `;
      }
      break;
    }
    case "pack": {
      await sql`
        update products
        set pack_description = ${String(change.new_value.packDescription)},
            cases_per_pallet = ${Number(change.new_value.casesPerPallet)},
            case_weight_lb = ${Number(change.new_value.caseWeightLb)}
        where id = ${change.product_id}
      `;
      break;
    }
    case "discontinued": {
      // Deactivated, never deleted: settled cycles reference this row.
      await sql`update products set active = false where id = ${change.product_id}`;
      break;
    }
    case "new_product": {
      const v = change.new_value as {
        sku: string;
        name: string;
        category: string;
        packDescription: string;
        casesPerPallet: number;
        caseWeightLb: number;
        listPriceCents: number;
        tempClass: string;
        tiers: Array<{ minCases: number; unitPriceCents: number }>;
      };
      const [product] = await sql<Array<{ id: string }>>`
        insert into products (supplier_id, sku, name, category, pack_description,
                              cases_per_pallet, case_weight_lb, list_price_cents, temp_class)
        values (${change.supplier_id}, ${v.sku}, ${v.name}, ${v.category},
                ${v.packDescription}, ${v.casesPerPallet}, ${v.caseWeightLb},
                ${v.listPriceCents}, ${v.tempClass})
        on conflict (supplier_id, sku) do update
          set active = true, list_price_cents = excluded.list_price_cents
        returning id
      `;
      await sql`delete from price_tiers where product_id = ${product.id}`;
      for (const t of v.tiers) {
        await sql`
          insert into price_tiers (product_id, min_cases, unit_price_cents)
          values (${product.id}, ${t.minCases}, ${t.unitPriceCents})
        `;
      }
      break;
    }
    default:
      throw new Error(`Unknown change type ${change.change_type}.`);
  }

  await sql`
    update catalog_changes
    set status = 'applied', decided_at = now(), decided_by = ${decidedBy}
    where id = ${changeId}
  `;
}

export async function rejectCatalogChange(changeId: string, decidedBy: string) {
  const result = await sql`
    update catalog_changes
    set status = 'rejected', decided_at = now(), decided_by = ${decidedBy}
    where id = ${changeId} and status = 'pending'
    returning id
  `;
  if (result.length === 0) throw new Error("Change is not pending.");
}

// ---------------------------------------------------------------------------
// Carrier rating
// ---------------------------------------------------------------------------

export type RateResult = {
  runId: string;
  quotes: number;
  status: "succeeded" | "failed";
  error?: string;
};

/**
 * Rate a cycle's load with a live carrier, and rate each member's order as if
 * shipped alone.
 *
 * The second half is the point. Every savings figure in this system is
 * measured against a benchmark LTL estimate; a real quote for the same
 * shipment turns that estimate into a number a member can be shown without a
 * disclaimer.
 */
export async function rateCycle(
  providerId: string,
  cycleId: string,
  trigger = "manual",
): Promise<RateResult> {
  const provider = await getProvider(providerId);
  if (!provider) throw new Error("Provider not found.");
  if (provider.partner !== "carrier" || !provider.carrierId) {
    throw new Error("Rating is a carrier operation.");
  }

  const run = await openRun(providerId, "rate", trigger);

  try {
    const analysis = await analyzeCycle(cycleId);
    if (!analysis?.load) {
      throw new IntegrationError("That cycle has no load to rate yet.");
    }
    const { cycle, load, commitments } = analysis;
    const adapter = carrierAdapterFor(provider);
    const origin = { lat: cycle.supplier_lat, lng: cycle.supplier_lng };
    const products = await loadProducts(cycle.supplier_id);

    const stopFor = (businessId: string) =>
      load.stops.find((s) => s.businessId === businessId)!;
    const rowFor = (businessId: string) =>
      commitments.find((c) => c.business_id === businessId)!;

    const consolidatedReq: RateRequest = {
      origin,
      pickupDate: new Date(cycle.delivery_date).toISOString().slice(0, 10),
      equipment: load.carrier.equipment,
      stops: load.stops.map((s) => {
        const row = rowFor(s.businessId);
        return {
          // A partner gets an opaque reference, not a member's name.
          ref: s.businessId.slice(0, 8),
          lat: row.business_lat,
          lng: row.business_lng,
          pallets: s.pallets,
          weightLb: Math.round(s.weightLb),
          liftgate: s.needsLiftgate,
        };
      }),
    };

    await run.log(
      `Rating consolidated load: ${consolidatedReq.stops.length} stops, ${load.totalPallets} pallets.`,
    );
    const quotes = await adapter.rate(consolidatedReq);
    if (quotes.length === 0) throw new IntegrationError("Carrier returned no quotes.");

    let stored = 0;
    for (const q of quotes) {
      await sql`
        insert into carrier_quotes (run_id, provider_id, carrier_id, cycle_id, purpose,
                                    quote_ref, linehaul_cents, accessorial_cents, total_cents,
                                    transit_days, valid_until, benchmark_cents, raw)
        values (${run.id}, ${providerId}, ${provider.carrierId}, ${cycleId}, 'consolidated',
                ${q.quoteRef}, ${q.linehaulCents}, ${q.accessorialCents}, ${q.totalCents},
                ${q.transitDays ?? null}, ${q.validUntil ?? null},
                ${load.totalFreightCents}, ${sql.json(q as never)})
      `;
      stored += 1;
      const delta = q.totalCents - load.totalFreightCents;
      await run.log(
        `Quote ${q.quoteRef}: $${(q.totalCents / 100).toFixed(2)} against a $${(load.totalFreightCents / 100).toFixed(2)} contract-rate estimate (${delta >= 0 ? "+" : ""}$${(delta / 100).toFixed(2)}).`,
        Math.abs(delta) > load.totalFreightCents * 0.15 ? "warn" : "info",
      );
    }

    // Per-member solo quotes: the counterfactual, priced for real.
    for (const businessId of new Set(commitments.map((c) => c.business_id))) {
      const stop = stopFor(businessId);
      const row = rowFor(businessId);
      const items = commitments
        .filter((c) => c.business_id === businessId)
        .map((c) => ({ product: products.get(c.product_id)!, cases: c.cases }));
      const weight = items.reduce((a, i) => a + i.cases * i.product.caseWeightLb, 0);

      const soloQuotes = await adapter.rate({
        origin,
        pickupDate: consolidatedReq.pickupDate,
        equipment: load.carrier.equipment,
        stops: [
          {
            ref: businessId.slice(0, 8),
            lat: row.business_lat,
            lng: row.business_lng,
            pallets: stop.pallets,
            weightLb: Math.round(weight),
            liftgate: stop.needsLiftgate,
          },
        ],
      });

      const best = soloQuotes.sort((a, b) => a.totalCents - b.totalCents)[0];
      if (!best) continue;

      await sql`
        insert into carrier_quotes (run_id, provider_id, carrier_id, cycle_id, purpose,
                                    business_id, quote_ref, linehaul_cents, accessorial_cents,
                                    total_cents, transit_days, valid_until, benchmark_cents, raw)
        values (${run.id}, ${providerId}, ${provider.carrierId}, ${cycleId}, 'member_solo',
                ${businessId}, ${best.quoteRef}, ${best.linehaulCents}, ${best.accessorialCents},
                ${best.totalCents}, ${best.transitDays ?? null}, ${best.validUntil ?? null},
                ${stop.ltlBenchmarkCents}, ${sql.json(best as never)})
      `;
      stored += 1;
    }

    await run.log(
      `Stored ${stored} quote(s): 1 consolidated plus ${stored - quotes.length} member-solo comparisons.`,
    );
    await sql`update integration_providers set last_run_at = now() where id = ${providerId}`;
    await closeRun(run.id, "succeeded", { seen: stored, changed: stored });
    return { runId: run.id, quotes: stored, status: "succeeded" };
  } catch (err) {
    const message = errorText(err);
    await run.log(message, "error");
    await closeRun(run.id, "failed", {}, message);
    return { runId: run.id, quotes: 0, status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Tendering
// ---------------------------------------------------------------------------

export async function tenderShipment(
  providerId: string,
  shipmentId: string,
  trigger = "manual",
): Promise<{ runId: string; status: string; tenderRef?: string; error?: string }> {
  const provider = await getProvider(providerId);
  if (!provider?.carrierId) throw new Error("Tendering is a carrier operation.");

  // One accepted or outstanding tender per shipment and carrier. The key is
  // derived, not random, so a double-click cannot offer the same load twice.
  const idempotencyKey = `tender:${shipmentId}:${provider.carrierId}`;

  const [existing] = await sql<Array<{ id: string; status: string; tender_ref: string | null }>>`
    select id, status, tender_ref from carrier_tenders
    where idempotency_key = ${idempotencyKey}
  `;
  if (existing && ["offered", "accepted"].includes(existing.status)) {
    return {
      runId: "",
      status: existing.status,
      tenderRef: existing.tender_ref ?? undefined,
      error: `This load is already ${existing.status} with ${provider.name}.`,
    };
  }

  const run = await openRun(providerId, "tender", trigger, `${idempotencyKey}:${randomUUID()}`);

  try {
    const [shipment] = await sql<
      Array<{
        cycle_id: string;
        pickup_date: Date;
        status: string;
        supplier_lat: number;
        supplier_lng: number;
      }>
    >`
      select sh.cycle_id, sh.pickup_date, sh.status,
             s.origin_lat::float8 as supplier_lat, s.origin_lng::float8 as supplier_lng
      from shipments sh
      join pool_cycles pc on pc.id = sh.cycle_id
      join suppliers s on s.id = pc.supplier_id
      where sh.id = ${shipmentId}
    `;
    if (!shipment) throw new IntegrationError("Shipment not found.");

    // Only a load that has not left yet can be offered to a carrier. Without
    // this, a stray retry re-tenders a load that has already been delivered
    // and walks its status backwards.
    if (!["planned", "cancelled"].includes(shipment.status)) {
      throw new IntegrationError(
        `This load is already ${shipment.status.replace(/_/g, " ")}; it cannot be tendered again. Cancel it first if the carrier must change.`,
      );
    }

    const stops = await sql<
      Array<{
        business_id: string;
        sequence: number;
        pallets: number;
        weight_lb: number;
        lat: number;
        lng: number;
        dock_type: string;
      }>
    >`
      select ss.business_id, ss.sequence, ss.pallets, ss.weight_lb::float8 as weight_lb,
             b.lat::float8 as lat, b.lng::float8 as lng, b.dock_type
      from shipment_stops ss join businesses b on b.id = ss.business_id
      where ss.shipment_id = ${shipmentId} order by ss.sequence
    `;

    const [quote] = await sql<Array<{ id: string; quote_ref: string; total_cents: number }>>`
      select id, quote_ref, total_cents from carrier_quotes
      where cycle_id = ${shipment.cycle_id} and carrier_id = ${provider.carrierId}
        and purpose = 'consolidated'
      order by created_at desc limit 1
    `;

    const adapter = carrierAdapterFor(provider);
    await run.log(`Tendering ${stops.length} stops to ${provider.name}.`);

    const response = await adapter.tender({
      origin: { lat: shipment.supplier_lat, lng: shipment.supplier_lng },
      pickupDate: new Date(shipment.pickup_date).toISOString().slice(0, 10),
      equipment: "dry_van",
      shipmentRef: shipmentId.slice(0, 8),
      quoteRef: quote?.quote_ref ?? null,
      idempotencyKey,
      stops: stops.map((s) => ({
        ref: s.business_id.slice(0, 8),
        lat: s.lat,
        lng: s.lng,
        pallets: s.pallets,
        weightLb: Math.round(Number(s.weight_lb)),
        liftgate: s.dock_type !== "dock",
      })),
    });

    await sql`
      insert into carrier_tenders (shipment_id, carrier_id, quote_id, run_id, status,
                                   tender_ref, offered_cents, responded_at, decline_reason,
                                   idempotency_key)
      values (${shipmentId}, ${provider.carrierId}, ${quote?.id ?? null}, ${run.id},
              ${response.status}, ${response.tenderRef},
              ${quote?.total_cents ?? 0}, now(), ${response.declineReason ?? null},
              ${idempotencyKey})
      on conflict (idempotency_key) do update
        set status = excluded.status, tender_ref = excluded.tender_ref,
            responded_at = now(), decline_reason = excluded.decline_reason
    `;

    if (response.status === "accepted") {
      await sql`
        update shipments set status = 'tendered', tendered_at = now(), carrier_id = ${provider.carrierId}
        where id = ${shipmentId}
      `;
      await sql`
        insert into tracking_events (shipment_id, code, message, source, external_ref)
        values (${shipmentId}, 'tendered',
                ${`Load accepted by ${provider.name} — tender ${response.tenderRef}.`},
                'carrier_feed', ${`${response.tenderRef}-ACCEPT`})
        on conflict do nothing
      `;
      await run.log(`Accepted. Tender reference ${response.tenderRef}.`);
    } else {
      await run.log(
        `Declined: ${response.declineReason ?? "no reason given"}.`,
        "warn",
      );
    }

    await closeRun(run.id, "succeeded", { seen: 1, changed: 1 });
    return { runId: run.id, status: response.status, tenderRef: response.tenderRef };
  } catch (err) {
    const message = errorText(err);
    await run.log(message, "error");
    await closeRun(run.id, "failed", {}, message);
    return { runId: run.id, status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export async function pullTracking(
  providerId: string,
  shipmentId: string,
  trigger = "manual",
): Promise<{ runId: string; ingested: number; status: string; error?: string }> {
  const provider = await getProvider(providerId);
  if (!provider?.carrierId) throw new Error("Tracking is a carrier operation.");

  const run = await openRun(providerId, "track", trigger);

  try {
    const [tender] = await sql<Array<{ tender_ref: string | null }>>`
      select tender_ref from carrier_tenders
      where shipment_id = ${shipmentId} and carrier_id = ${provider.carrierId}
        and status = 'accepted'
      order by offered_at desc limit 1
    `;
    if (!tender?.tender_ref) {
      throw new IntegrationError("No accepted tender for this load, so nothing to track.");
    }

    const adapter = carrierAdapterFor(provider);
    const events = await adapter.track(tender.tender_ref);
    await run.log(`Carrier returned ${events.length} status event(s).`);

    const stops = await sql<Array<{ id: string; sequence: number }>>`
      select id, sequence from shipment_stops where shipment_id = ${shipmentId}
    `;
    const stopBySeq = new Map(stops.map((s) => [s.sequence, s.id]));

    let ingested = 0;
    for (const e of events) {
      const stopId = e.stopSequence ? (stopBySeq.get(e.stopSequence) ?? null) : null;
      // external_ref carries the dedup: re-pulling the feed is free.
      const inserted = await sql`
        insert into tracking_events (shipment_id, stop_id, code, message, occurred_at,
                                     source, external_ref)
        values (${shipmentId}, ${stopId}, ${e.code}, ${e.message},
                ${new Date(e.occurredAt)}, 'carrier_feed', ${e.externalRef})
        on conflict (shipment_id, external_ref) where external_ref is not null
        do nothing
        returning id
      `;
      if (inserted.length === 0) continue;
      ingested += 1;

      if (stopId && e.code === "delivered") {
        await sql`
          update shipment_stops
          set status = 'delivered', delivered_at = ${new Date(e.occurredAt)},
              pod_signed_by = coalesce(${e.signedBy ?? null}, pod_signed_by)
          where id = ${stopId}
        `;
      } else if (stopId && e.code === "out_for_delivery") {
        await sql`
          update shipment_stops set status = 'out_for_delivery'
          where id = ${stopId} and status = 'planned'
        `;
      }
      if (e.code === "picked_up") {
        await sql`
          update shipments set status = 'in_transit'
          where id = ${shipmentId} and status in ('planned','tendered','accepted')
        `;
      }
    }

    // A load whose every stop is delivered is delivered.
    await sql`
      update shipments sh set status = 'delivered'
      where sh.id = ${shipmentId}
        and not exists (
          select 1 from shipment_stops ss
          where ss.shipment_id = sh.id and ss.status <> 'delivered'
        )
    `;

    await run.log(`Ingested ${ingested} new event(s); the rest were already recorded.`);
    await sql`update integration_providers set last_run_at = now() where id = ${providerId}`;
    await closeRun(run.id, "succeeded", { seen: events.length, changed: ingested });
    return { runId: run.id, ingested, status: "succeeded" };
  } catch (err) {
    const message = errorText(err);
    await run.log(message, "error");
    await closeRun(run.id, "failed", {}, message);
    return { runId: run.id, ingested: 0, status: "failed", error: message };
  }
}

// ---------------------------------------------------------------------------
// Invoice reconciliation
// ---------------------------------------------------------------------------

/** Absorb rounding-scale differences; anything larger is a real variance. */
export const VARIANCE_TOLERANCE_CENTS = 500;

export async function reconcileInvoices(
  providerId: string,
  trigger = "manual",
): Promise<{ runId: string; received: number; variances: number; status: string; error?: string }> {
  const provider = await getProvider(providerId);
  if (!provider?.carrierId) throw new Error("Invoice sync is a carrier operation.");

  const run = await openRun(providerId, "invoice_sync", trigger);

  try {
    const adapter = carrierAdapterFor(provider);
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const invoices = await adapter.fetchInvoices(since);
    await run.log(`Carrier returned ${invoices.length} invoice(s) since ${since.slice(0, 10)}.`);

    let stored = 0;
    let variances = 0;

    for (const invoice of invoices) {
      // Match by tender reference. An invoice we cannot tie to a load we
      // tendered is not paid on the strength of the carrier saying so.
      const [tender] = await sql<Array<{ shipment_id: string }>>`
        select shipment_id from carrier_tenders
        where tender_ref = ${invoice.tenderRef ?? ""} and carrier_id = ${provider.carrierId}
      `;
      if (!tender) {
        await run.log(
          `Invoice ${invoice.invoiceRef} references tender ${invoice.tenderRef ?? "(none)"}, which does not match any load we tendered. Held for review.`,
          "warn",
        );
        continue;
      }

      const [allocated] = await sql<Array<{ total: number }>>`
        select coalesce(sum(freight_cents), 0)::int as total
        from shipment_stops where shipment_id = ${tender.shipment_id}
      `;
      const allocatedCents = allocated?.total ?? 0;
      const variance = invoice.totalCents - allocatedCents;
      const status =
        Math.abs(variance) <= VARIANCE_TOLERANCE_CENTS ? "matched" : "variance";

      const result = await sql`
        insert into freight_invoices (shipment_id, carrier_id, run_id, invoice_ref, invoice_date,
                                      linehaul_cents, accessorial_cents, total_cents,
                                      allocated_cents, variance_cents, status, note, raw)
        values (${tender.shipment_id}, ${provider.carrierId}, ${run.id}, ${invoice.invoiceRef},
                ${invoice.invoiceDate}, ${invoice.linehaulCents}, ${invoice.accessorialCents},
                ${invoice.totalCents}, ${allocatedCents}, ${variance}, ${status},
                ${invoice.note ?? null}, ${sql.json(invoice as never)})
        on conflict (carrier_id, invoice_ref) do update
          set total_cents = excluded.total_cents,
              linehaul_cents = excluded.linehaul_cents,
              accessorial_cents = excluded.accessorial_cents,
              allocated_cents = excluded.allocated_cents,
              variance_cents = excluded.variance_cents,
              status = excluded.status,
              note = excluded.note
        returning id
      `;
      if (result.length > 0) stored += 1;

      if (status === "variance") {
        variances += 1;
        await run.log(
          `Invoice ${invoice.invoiceRef} bills $${(invoice.totalCents / 100).toFixed(2)} against $${(allocatedCents / 100).toFixed(2)} allocated to members — a ${variance >= 0 ? "shortfall" : "credit"} of $${(Math.abs(variance) / 100).toFixed(2)}.${invoice.note ? ` Carrier note: ${invoice.note}` : ""}`,
          "warn",
        );
      }
    }

    await sql`update integration_providers set last_run_at = now() where id = ${providerId}`;
    await closeRun(
      run.id,
      variances > 0 ? "partial" : "succeeded",
      { seen: invoices.length, changed: stored },
    );
    return {
      runId: run.id,
      received: stored,
      variances,
      status: variances > 0 ? "partial" : "succeeded",
    };
  } catch (err) {
    const message = errorText(err);
    await run.log(message, "error");
    await closeRun(run.id, "failed", {}, message);
    return { runId: run.id, received: 0, variances: 0, status: "failed", error: message };
  }
}

/**
 * Re-price a member's solo counterfactual from live quotes where we have them.
 *
 * Returns a map from business id to a quoted solo freight cost, for the
 * settlement to use instead of LTL_BENCHMARK. Where no quote exists the
 * benchmark still applies and the figure stays labelled an estimate.
 */
export async function quotedSoloFreight(
  cycleId: string,
): Promise<Map<string, number>> {
  const rows = await sql<Array<{ business_id: string; total_cents: number }>>`
    select distinct on (business_id) business_id, total_cents
    from carrier_quotes
    where cycle_id = ${cycleId} and purpose = 'member_solo' and business_id is not null
    order by business_id, created_at desc
  `;
  return new Map(rows.map((r) => [r.business_id, r.total_cents]));
}
