/**
 * Drive every integration operation once, against the mock partners.
 *
 * This is the end-to-end check: catalog sync over HTTP and CSV, carrier
 * rating, tendering, tracking ingest and invoice reconciliation, all through
 * the same code paths the app uses.
 *
 *   npm run mock-partners      # in one shell
 *   npm run integrations:run   # in another
 */
import "dotenv/config";

import { sql } from "../src/lib/db/client";
import {
  pullTracking,
  rateCycle,
  reconcileInvoices,
  syncCatalog,
  tenderShipment,
} from "../src/lib/integrations/sync";

async function main() {
  const providers = await sql<
    Array<{ id: string; name: string; partner: string; adapter: string }>
  >`select id, name, partner, adapter from integration_providers order by partner, name`;

  console.log("=== Catalog sync ===");
  for (const p of providers.filter((x) => x.partner === "supplier")) {
    const result = await syncCatalog(p.id, "scripted");
    console.log(
      `  ${p.name} [${p.adapter}]: ${result.status}, ${result.itemsSeen} items, ${result.changesStaged} staged${result.error ? ` — ${result.error}` : ""}`,
    );
  }

  const [cycle] = await sql<Array<{ id: string; name: string }>>`
    select pc.id, pc.name from pool_cycles pc
    where exists (select 1 from commitments c where c.cycle_id = pc.id)
    order by pc.closes_at desc limit 1
  `;

  const iredell = providers.find((p) => p.name.startsWith("Iredell"));
  if (cycle && iredell) {
    console.log(`\n=== Rating "${cycle.name}" with ${iredell.name} ===`);
    const rated = await rateCycle(iredell.id, cycle.id, "scripted");
    console.log(`  ${rated.status}: ${rated.quotes} quotes${rated.error ? ` — ${rated.error}` : ""}`);

    const [quote] = await sql<Array<{ total_cents: number; benchmark_cents: number }>>`
      select total_cents, benchmark_cents from carrier_quotes
      where cycle_id = ${cycle.id} and purpose = 'consolidated'
      order by created_at desc limit 1
    `;
    if (quote) {
      const delta = quote.total_cents - quote.benchmark_cents;
      console.log(
        `  quoted $${(quote.total_cents / 100).toFixed(2)} vs contract-rate estimate $${(quote.benchmark_cents / 100).toFixed(2)} (${delta >= 0 ? "+" : ""}$${(delta / 100).toFixed(2)})`,
      );
    }
  }

  // Only a load that has not left yet can be tendered.
  const [shipment] = await sql<Array<{ id: string; cycle_name: string }>>`
    select sh.id, pc.name as cycle_name from shipments sh
    join pool_cycles pc on pc.id = sh.cycle_id
    where sh.status = 'planned'
    order by sh.created_at desc limit 1
  `;

  if (shipment && iredell) {
    console.log(`\n=== Tender "${shipment.cycle_name}" ===`);
    const tendered = await tenderShipment(iredell.id, shipment.id, "scripted");
    console.log(`  ${tendered.status}${tendered.tenderRef ? ` — ${tendered.tenderRef}` : ""}${tendered.error ? ` — ${tendered.error}` : ""}`);

    // Prove the idempotency key: a second tender must not re-offer the load.
    const again = await tenderShipment(iredell.id, shipment.id, "scripted");
    console.log(`  repeat attempt: ${again.status} — ${again.error ?? "no guard fired"}`);

    console.log("\n=== Tracking ===");
    const tracked = await pullTracking(iredell.id, shipment.id, "scripted");
    console.log(`  ${tracked.status}: ingested ${tracked.ingested} event(s)`);
    const twice = await pullTracking(iredell.id, shipment.id, "scripted");
    console.log(`  repeat pull: ingested ${twice.ingested} (deduplicated)`);

    console.log("\n=== Invoice reconciliation ===");
    const reconciled = await reconcileInvoices(iredell.id, "scripted");
    console.log(
      `  ${reconciled.status}: ${reconciled.received} invoice(s), ${reconciled.variances} variance(s)`,
    );
    const invoices = await sql<
      Array<{ invoice_ref: string; total_cents: number; allocated_cents: number; variance_cents: number; status: string; note: string | null }>
    >`select invoice_ref, total_cents, allocated_cents, variance_cents, status, note
      from freight_invoices order by received_at desc`;
    for (const i of invoices) {
      console.log(
        `    ${i.invoice_ref} [${i.status}] billed $${(i.total_cents / 100).toFixed(2)}, allocated $${(i.allocated_cents / 100).toFixed(2)}, variance ${i.variance_cents >= 0 ? "+" : ""}$${(i.variance_cents / 100).toFixed(2)}${i.note ? ` — ${i.note}` : ""}`,
      );
    }
  }

  console.log("\n=== Staged catalog changes ===");
  const changes = await sql<
    Array<{ sku: string; change_type: string; status: string; affected_open_cycles: number; committed_cases: number; impact_cents: number }>
  >`select sku, change_type, status, affected_open_cycles, committed_cases, impact_cents
    from catalog_changes where status = 'pending' order by abs(impact_cents) desc`;
  for (const c of changes) {
    console.log(
      `  ${c.sku} ${c.change_type}${c.affected_open_cycles > 0 ? ` — ${c.affected_open_cycles} open cycle(s), ${c.committed_cases} cases, impact ${c.impact_cents >= 0 ? "+" : ""}$${(c.impact_cents / 100).toFixed(2)}` : ""}`,
    );
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
