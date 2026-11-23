/**
 * Reads for the integrations console.
 *
 * Partner-supplied text (invoice notes, decline reasons, product names) is
 * stored and displayed as data. It is never treated as instruction and never
 * interpolated anywhere it could become one.
 */
import { sql } from "./client";

export type ProviderSummary = {
  id: string;
  partner: "supplier" | "carrier";
  name: string;
  adapter: "manual" | "csv" | "http";
  partner_ref: string;
  base_url: string | null;
  auth_env_var: string | null;
  source_path: string | null;
  enabled: boolean;
  sync_interval_minutes: number | null;
  last_run_at: Date | null;
  partner_name: string;
  last_status: string | null;
  pending_changes: number;
  failed_runs_7d: number;
};

export async function getProviders() {
  return sql<ProviderSummary[]>`
    select p.id, p.partner, p.name, p.adapter, p.partner_ref, p.base_url,
           p.auth_env_var, p.source_path, p.enabled, p.sync_interval_minutes,
           p.last_run_at,
           coalesce(s.name, c.name, '—') as partner_name,
           (select r.status::text from integration_runs r
             where r.provider_id = p.id order by r.started_at desc limit 1) as last_status,
           (select count(*)::int from catalog_changes cc
             where cc.supplier_id = p.supplier_id and cc.status = 'pending') as pending_changes,
           (select count(*)::int from integration_runs r
             where r.provider_id = p.id and r.status = 'failed'
               and r.started_at > now() - interval '7 days') as failed_runs_7d
    from integration_providers p
    left join suppliers s on s.id = p.supplier_id
    left join carriers c on c.id = p.carrier_id
    order by p.partner, p.name
  `;
}

export async function getRuns(limit = 25) {
  return sql<
    Array<{
      id: string;
      provider_id: string;
      provider_name: string;
      partner: string;
      operation: string;
      status: string;
      trigger: string;
      started_at: Date;
      finished_at: Date | null;
      items_seen: number;
      items_changed: number;
      error: string | null;
      event_count: number;
    }>
  >`
    select r.id, r.provider_id, p.name as provider_name, p.partner, r.operation,
           r.status, r.trigger, r.started_at, r.finished_at, r.items_seen,
           r.items_changed, r.error,
           (select count(*)::int from integration_run_events e where e.run_id = r.id) as event_count
    from integration_runs r
    join integration_providers p on p.id = r.provider_id
    order by r.started_at desc
    limit ${limit}
  `;
}

export async function getRunEvents(runId: string) {
  return sql<Array<{ sequence: number; level: string; message: string }>>`
    select sequence, level, message from integration_run_events
    where run_id = ${runId} order by sequence
  `;
}

export async function getPendingChanges() {
  return sql<
    Array<{
      id: string;
      supplier_id: string;
      supplier_name: string;
      product_id: string | null;
      sku: string;
      product_name: string;
      change_type: string;
      old_value: Record<string, unknown> | null;
      new_value: Record<string, unknown>;
      affected_open_cycles: number;
      committed_cases: number;
      impact_cents: number;
      created_at: Date;
    }>
  >`
    select cc.id, cc.supplier_id, s.name as supplier_name, cc.product_id, cc.sku,
           cc.product_name, cc.change_type, cc.old_value, cc.new_value,
           cc.affected_open_cycles, cc.committed_cases, cc.impact_cents, cc.created_at
    from catalog_changes cc
    join suppliers s on s.id = cc.supplier_id
    where cc.status = 'pending'
    order by cc.affected_open_cycles desc, abs(cc.impact_cents) desc, cc.sku
  `;
}

export async function getDecidedChanges(limit = 20) {
  return sql<
    Array<{
      id: string;
      sku: string;
      product_name: string;
      change_type: string;
      status: string;
      decided_at: Date | null;
      decided_by: string | null;
      impact_cents: number;
    }>
  >`
    select id, sku, product_name, change_type, status, decided_at, decided_by, impact_cents
    from catalog_changes
    where status in ('applied','rejected')
    order by decided_at desc nulls last
    limit ${limit}
  `;
}

/**
 * Latest consolidated quote per cycle, against the contract-rate estimate the
 * planner produced. Drift here is the reason to rate rather than assume.
 */
export async function getQuoteComparison() {
  return sql<
    Array<{
      cycle_id: string;
      cycle_name: string;
      zone_name: string;
      carrier_name: string;
      quote_ref: string | null;
      total_cents: number;
      benchmark_cents: number | null;
      transit_days: number | null;
      valid_until: Date | null;
      created_at: Date;
      solo_quotes: number;
    }>
  >`
    select distinct on (q.cycle_id)
           q.cycle_id, pc.name as cycle_name, z.name as zone_name, c.name as carrier_name,
           q.quote_ref, q.total_cents, q.benchmark_cents, q.transit_days,
           q.valid_until, q.created_at,
           (select count(*)::int from carrier_quotes sq
             where sq.cycle_id = q.cycle_id and sq.purpose = 'member_solo') as solo_quotes
    from carrier_quotes q
    join pool_cycles pc on pc.id = q.cycle_id
    join zones z on z.id = pc.zone_id
    join carriers c on c.id = q.carrier_id
    where q.purpose = 'consolidated'
    order by q.cycle_id, q.created_at desc
  `;
}

export async function getTenders() {
  return sql<
    Array<{
      id: string;
      shipment_id: string;
      cycle_name: string;
      carrier_name: string;
      status: string;
      tender_ref: string | null;
      offered_cents: number;
      offered_at: Date;
      decline_reason: string | null;
    }>
  >`
    select t.id, t.shipment_id, pc.name as cycle_name, c.name as carrier_name,
           t.status, t.tender_ref, t.offered_cents, t.offered_at, t.decline_reason
    from carrier_tenders t
    join shipments sh on sh.id = t.shipment_id
    join pool_cycles pc on pc.id = sh.cycle_id
    join carriers c on c.id = t.carrier_id
    order by t.offered_at desc
  `;
}

export async function getInvoices() {
  return sql<
    Array<{
      id: string;
      shipment_id: string;
      cycle_name: string;
      carrier_name: string;
      invoice_ref: string;
      invoice_date: Date;
      total_cents: number;
      allocated_cents: number;
      variance_cents: number;
      status: string;
      note: string | null;
    }>
  >`
    select i.id, i.shipment_id, pc.name as cycle_name, c.name as carrier_name,
           i.invoice_ref, i.invoice_date, i.total_cents, i.allocated_cents,
           i.variance_cents, i.status, i.note
    from freight_invoices i
    join shipments sh on sh.id = i.shipment_id
    join pool_cycles pc on pc.id = sh.cycle_id
    join carriers c on c.id = i.carrier_id
    order by abs(i.variance_cents) desc, i.received_at desc
  `;
}

/** Cycles an operator can rate or tender right now. */
export async function getActionableCycles() {
  return sql<
    Array<{
      id: string;
      name: string;
      zone_name: string;
      status: string;
      shipment_id: string | null;
      shipment_status: string | null;
      commitments: number;
    }>
  >`
    select pc.id, pc.name, z.name as zone_name, pc.status,
           sh.id as shipment_id, sh.status::text as shipment_status,
           (select count(*)::int from commitments c
             where c.cycle_id = pc.id and c.status <> 'cancelled') as commitments
    from pool_cycles pc
    join zones z on z.id = pc.zone_id
    left join shipments sh on sh.cycle_id = pc.id
    where pc.status in ('open','locked','negotiated','confirmed','shipped')
    order by pc.closes_at
  `;
}

export async function getIntegrationStats() {
  const [row] = await sql<
    Array<{
      providers: number;
      automated: number;
      pending_changes: number;
      at_risk_changes: number;
      open_variance_cents: number;
      variance_count: number;
      quoted_cycles: number;
      failed_runs_7d: number;
    }>
  >`
    select
      (select count(*)::int from integration_providers where enabled) as providers,
      (select count(*)::int from integration_providers where enabled and adapter <> 'manual') as automated,
      (select count(*)::int from catalog_changes where status = 'pending') as pending_changes,
      (select count(*)::int from catalog_changes
        where status = 'pending' and affected_open_cycles > 0) as at_risk_changes,
      (select coalesce(sum(variance_cents), 0)::int from freight_invoices
        where status = 'variance') as open_variance_cents,
      (select count(*)::int from freight_invoices where status = 'variance') as variance_count,
      (select count(distinct cycle_id)::int from carrier_quotes
        where purpose = 'consolidated') as quoted_cycles,
      (select count(*)::int from integration_runs
        where status = 'failed' and started_at > now() - interval '7 days') as failed_runs_7d
  `;
  return row;
}
