import Link from "next/link";

import {
  decideCatalogChange,
  decideInvoice,
  runCatalogSync,
  runInvoiceSync,
  runRating,
  runTender,
  runTracking,
  setProviderEnabled,
} from "./actions";
import { formatCents } from "@/lib/crs/money";
import {
  getActionableCycles,
  getDecidedChanges,
  getIntegrationStats,
  getInvoices,
  getPendingChanges,
  getProviders,
  getQuoteComparison,
  getRunEvents,
  getRuns,
  getTenders,
} from "@/lib/db/integration-queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  EstimateNote,
  fmtDate,
  fmtDateTime,
  Money,
  PageHead,
  relDays,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

import { requireOperator } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const adapterTone = {
  http: "guide",
  csv: "route",
  manual: "neutral",
} as const;

export default async function IntegrationsPage() {
  await requireOperator();
  const [providers, runs, pending, decided, quotes, tenders, invoices, cycles, stats] =
    await Promise.all([
      getProviders(),
      getRuns(12),
      getPendingChanges(),
      getDecidedChanges(8),
      getQuoteComparison(),
      getTenders(),
      getInvoices(),
      getActionableCycles(),
      getIntegrationStats(),
    ]);

  const latestRun = runs[0];
  const latestEvents = latestRun ? await getRunEvents(latestRun.id) : [];

  const carrierProviders = providers.filter(
    (p) => p.partner === "carrier" && p.adapter !== "manual" && p.enabled,
  );
  const tenderable = cycles.filter(
    (c) => c.shipment_id && c.shipment_status === "planned",
  );
  const trackable = cycles.filter(
    (c) => c.shipment_id && ["tendered", "in_transit"].includes(c.shipment_status ?? ""),
  );

  return (
    <>
      <PageHead
        eyebrow="Operator view"
        title="Integrations"
        sub="Supplier catalogs in, carrier rates and tenders out. Inbound prices land as proposals rather than edits: a feed must not move a price under a live pool by itself."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Connected partners"
          value={`${stats.automated}/${stats.providers}`}
          sub="Automated feeds against total enabled providers"
        />
        <Stat
          label="Changes awaiting review"
          value={stats.pending_changes}
          tone={stats.at_risk_changes > 0 ? "signal" : "neutral"}
          sub={
            stats.at_risk_changes > 0
              ? `${stats.at_risk_changes} would move pricing on an open cycle`
              : "None touch an open cycle"
          }
        />
        <Stat
          label="Invoice variance"
          value={formatCents(stats.open_variance_cents)}
          tone={stats.variance_count > 0 ? "alert" : "guide"}
          sub={
            stats.variance_count > 0
              ? `${stats.variance_count} invoice(s) differ from what members were billed`
              : "Every invoice matches its allocation"
          }
        />
        <Stat
          label="Cycles with live quotes"
          value={stats.quoted_cycles}
          tone="route"
          sub={
            stats.failed_runs_7d > 0
              ? `${stats.failed_runs_7d} failed run(s) in the last 7 days`
              : "No failed runs this week"
          }
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="eyebrow mb-3">Providers</h2>
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Provider</Th>
                <Th>Partner</Th>
                <Th>Transport</Th>
                <Th>Credentials</Th>
                <Th>Last run</Th>
                <Th right>Actions</Th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id} className="hover:bg-ink-850">
                  <Td>
                    <p className="font-medium text-hi">{p.name}</p>
                    <p className="text-xs text-low">
                      {p.sync_interval_minutes
                        ? `every ${formatInterval(p.sync_interval_minutes)}`
                        : "manual only"}
                      {p.failed_runs_7d > 0 ? (
                        <span className="text-alert">
                          {" "}
                          · {p.failed_runs_7d} failure(s) this week
                        </span>
                      ) : null}
                    </p>
                  </Td>
                  <Td className="text-xs text-mid">{p.partner_name}</Td>
                  <Td>
                    <Badge tone={adapterTone[p.adapter]}>{p.adapter}</Badge>
                  </Td>
                  <Td className="text-xs text-mid">
                    {p.adapter === "http" ? (
                      <>
                        <span className="num">{p.base_url}</span>
                        <span className="block text-low">
                          token from{" "}
                          <span className="num">{p.auth_env_var ?? "none"}</span>
                        </span>
                      </>
                    ) : p.adapter === "csv" ? (
                      <span className="num text-low">{p.source_path}</span>
                    ) : (
                      <span className="text-low">phone / email</span>
                    )}
                  </Td>
                  <Td className="text-xs text-mid">
                    {p.last_run_at ? (
                      <>
                        {relDays(p.last_run_at)}
                        {p.last_status ? (
                          <span className="ml-2">
                            <StatusBadge status={p.last_status} />
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-low">never</span>
                    )}
                  </Td>
                  <Td right>
                    <div className="flex items-center justify-end gap-1.5">
                      {p.partner === "supplier" && p.adapter !== "manual" ? (
                        <form action={runCatalogSync}>
                          <input type="hidden" name="providerId" value={p.id} />
                          <SmallButton>Sync catalog</SmallButton>
                        </form>
                      ) : null}
                      {p.partner === "carrier" && p.adapter !== "manual" ? (
                        <form action={runInvoiceSync}>
                          <input type="hidden" name="providerId" value={p.id} />
                          <SmallButton>Pull invoices</SmallButton>
                        </form>
                      ) : null}
                      <form action={setProviderEnabled}>
                        <input type="hidden" name="providerId" value={p.id} />
                        <input
                          type="hidden"
                          name="enabled"
                          value={p.enabled ? "false" : "true"}
                        />
                        <SmallButton>{p.enabled ? "Disable" : "Enable"}</SmallButton>
                      </form>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="px-4 pb-4">
            <EstimateNote>
              Tokens are never stored here. A provider records the name of the
              environment variable holding its credential; the value stays in
              the environment.
            </EstimateNote>
          </div>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="eyebrow mb-3">
          Catalog changes awaiting review
          {pending.length > 0 ? ` (${pending.length})` : ""}
        </h2>
        <Card>
          {pending.length === 0 ? (
            <Empty>
              Nothing staged. Every supplier catalog matches what we hold.
            </Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Change</Th>
                  <Th>Detail</Th>
                  <Th right>Exposure</Th>
                  <Th right>Impact</Th>
                  <Th right>Decision</Th>
                </tr>
              </thead>
              <tbody>
                {pending.map((c) => {
                  // A discontinued SKU with cases already committed is the
                  // loudest case here: those members have no source.
                  const orphaned =
                    c.change_type === "discontinued" && c.committed_cases > 0;
                  return (
                    <tr key={c.id} className="hover:bg-ink-850">
                      <Td>
                        <p className="font-medium text-hi">{c.product_name}</p>
                        <p className="text-xs text-low">
                          {c.sku} · {c.supplier_name}
                        </p>
                      </Td>
                      <Td>
                        <Badge
                          tone={
                            c.change_type === "discontinued"
                              ? "alert"
                              : c.change_type === "new_product"
                                ? "guide"
                                : c.impact_cents > 0
                                  ? "signal"
                                  : "route"
                          }
                        >
                          {c.change_type.replace(/_/g, " ")}
                        </Badge>
                      </Td>
                      <Td className="max-w-md text-xs leading-relaxed text-mid">
                        {describe(c)}
                      </Td>
                      <Td right className="text-xs">
                        {c.affected_open_cycles > 0 ? (
                          <>
                            <span className="num text-hi">{c.committed_cases}</span>
                            <span className="text-low"> cases on </span>
                            <span className="num text-hi">
                              {c.affected_open_cycles}
                            </span>
                            <span className="text-low"> open cycle(s)</span>
                          </>
                        ) : (
                          <span className="text-low">no open exposure</span>
                        )}
                      </Td>
                      <Td right>
                        {orphaned ? (
                          <span className="text-xs font-semibold text-alert">
                            no source
                          </span>
                        ) : c.impact_cents !== 0 ? (
                          // Positive impact means members pay more, so it is
                          // shown as the cost it is.
                          <Money cents={-c.impact_cents} signed />
                        ) : (
                          <span className="text-low">—</span>
                        )}
                      </Td>
                      <Td right>
                        <div className="flex items-center justify-end gap-1.5">
                          <form action={decideCatalogChange}>
                            <input type="hidden" name="changeId" value={c.id} />
                            <input type="hidden" name="decision" value="apply" />
                            <SmallButton primary>Apply</SmallButton>
                          </form>
                          <form action={decideCatalogChange}>
                            <input type="hidden" name="changeId" value={c.id} />
                            <input type="hidden" name="decision" value="reject" />
                            <SmallButton>Reject</SmallButton>
                          </form>
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          {decided.length > 0 ? (
            <div className="border-t border-ink-700 px-4 py-3">
              <p className="eyebrow mb-2">Recently decided</p>
              <ul className="space-y-1 text-xs text-mid">
                {decided.map((d) => (
                  <li key={d.id}>
                    <span
                      className={
                        d.status === "applied" ? "text-guide" : "text-low"
                      }
                    >
                      {titleCase(d.status)}
                    </span>{" "}
                    {d.sku} {d.change_type.replace(/_/g, " ")}
                    {d.decided_by ? ` by ${d.decided_by}` : ""}
                    {d.decided_at ? ` · ${fmtDateTime(d.decided_at)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <Card>
          <CardHead
            title="Carrier rating"
            sub="A rated quote replaces the benchmark the savings figures rest on. Rate a cycle to turn its estimates into quoted numbers."
          />
          {carrierProviders.length === 0 ? (
            <Empty>No carrier with an API is enabled.</Empty>
          ) : (
            <div className="space-y-2 border-b border-ink-700 px-4 py-3">
              {cycles
                .filter((c) => c.commitments > 0)
                .slice(0, 5)
                .map((c) => (
                  <form
                    key={c.id}
                    action={runRating}
                    className="flex items-center gap-2"
                  >
                    <input
                      type="hidden"
                      name="providerId"
                      value={carrierProviders[0].id}
                    />
                    <input type="hidden" name="cycleId" value={c.id} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-hi">{c.name}</p>
                      <p className="text-xs text-low">
                        {c.zone_name} · {c.commitments} lines · {c.status}
                      </p>
                    </div>
                    <SmallButton>Rate with {shortName(carrierProviders[0].name)}</SmallButton>
                  </form>
                ))}
            </div>
          )}

          {quotes.length === 0 ? (
            <Empty>No quotes yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Cycle</Th>
                  <Th>Carrier</Th>
                  <Th right>Quoted</Th>
                  <Th right>Estimate</Th>
                  <Th right>Drift</Th>
                  <Th right>Solo</Th>
                </tr>
              </thead>
              <tbody>
                {quotes.map((q) => {
                  const drift =
                    q.benchmark_cents !== null
                      ? q.total_cents - q.benchmark_cents
                      : null;
                  return (
                    <tr key={q.cycle_id} className="hover:bg-ink-850">
                      <Td>
                        <Link
                          href={`/pools/${q.cycle_id}`}
                          className="text-sm text-hi hover:text-signal"
                        >
                          {q.cycle_name}
                        </Link>
                        <p className="text-xs text-low">
                          {q.quote_ref}
                          {q.valid_until
                            ? ` · valid to ${fmtDate(q.valid_until)}`
                            : ""}
                        </p>
                      </Td>
                      <Td className="text-xs text-mid">{q.carrier_name}</Td>
                      <Td right className="num font-semibold text-hi">
                        {formatCents(q.total_cents)}
                      </Td>
                      <Td right className="num text-low">
                        {q.benchmark_cents !== null
                          ? formatCents(q.benchmark_cents)
                          : "—"}
                      </Td>
                      <Td right>
                        {drift !== null ? (
                          // Over the estimate costs members money.
                          <Money cents={-drift} signed />
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td right className="num text-mid">
                        {q.solo_quotes}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
          <div className="px-4 pb-4">
            <EstimateNote>
              &ldquo;Solo&rdquo; counts the per-member quotes for the same goods
              shipped alone. Those replace the LTL benchmark in the settlement
              for that member, and the pool page says which figure it used.
            </EstimateNote>
          </div>
        </Card>

        <Card>
          <CardHead
            title="Tendering and tracking"
            sub="Tenders carry a derived idempotency key, so a retry cannot offer the same load twice."
          />
          {tenderable.length > 0 && carrierProviders.length > 0 ? (
            <div className="space-y-2 border-b border-ink-700 px-4 py-3">
              {tenderable.map((c) => (
                <form key={c.id} action={runTender} className="flex items-center gap-2">
                  <input type="hidden" name="providerId" value={carrierProviders[0].id} />
                  <input type="hidden" name="shipmentId" value={c.shipment_id!} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-hi">{c.name}</p>
                    <p className="text-xs text-low">load planned, not yet offered</p>
                  </div>
                  <SmallButton primary>Tender</SmallButton>
                </form>
              ))}
            </div>
          ) : null}

          {trackable.length > 0 && carrierProviders.length > 0 ? (
            <div className="space-y-2 border-b border-ink-700 px-4 py-3">
              {trackable.map((c) => (
                <form key={c.id} action={runTracking} className="flex items-center gap-2">
                  <input type="hidden" name="providerId" value={carrierProviders[0].id} />
                  <input type="hidden" name="shipmentId" value={c.shipment_id!} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-hi">{c.name}</p>
                    <p className="text-xs text-low">
                      {c.shipment_status?.replace(/_/g, " ")} — pull carrier status
                    </p>
                  </div>
                  <SmallButton>Pull tracking</SmallButton>
                </form>
              ))}
            </div>
          ) : null}

          {tenders.length === 0 ? (
            <Empty>Nothing tendered yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Load</Th>
                  <Th>Carrier</Th>
                  <Th>Reference</Th>
                  <Th right>Offered</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {tenders.map((t) => (
                  <tr key={t.id} className="hover:bg-ink-850">
                    <Td>
                      <p className="text-sm text-hi">{t.cycle_name}</p>
                      <p className="text-xs text-low">{fmtDateTime(t.offered_at)}</p>
                      {t.decline_reason ? (
                        <p className="mt-0.5 text-xs text-alert">
                          {t.decline_reason}
                        </p>
                      ) : null}
                    </Td>
                    <Td className="text-xs text-mid">{t.carrier_name}</Td>
                    <Td className="num text-xs text-mid">{t.tender_ref ?? "—"}</Td>
                    <Td right className="num text-mid">
                      {t.offered_cents > 0 ? formatCents(t.offered_cents) : "—"}
                    </Td>
                    <Td right>
                      <StatusBadge status={t.status} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-8">
        <h2 className="eyebrow mb-3">Freight invoice reconciliation</h2>
        <Card>
          {invoices.length === 0 ? (
            <Empty>No carrier invoices received.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Load</Th>
                  <Th right>Carrier billed</Th>
                  <Th right>Members billed</Th>
                  <Th right>Variance</Th>
                  <Th>Carrier note</Th>
                  <Th right>Decision</Th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="hover:bg-ink-850">
                    <Td>
                      <p className="num text-sm text-hi">{i.invoice_ref}</p>
                      <p className="text-xs text-low">{fmtDate(i.invoice_date)}</p>
                    </Td>
                    <Td className="text-xs text-mid">
                      {i.cycle_name}
                      <span className="block text-low">{i.carrier_name}</span>
                    </Td>
                    <Td right className="num text-mid">
                      {formatCents(i.total_cents)}
                    </Td>
                    <Td right className="num text-mid">
                      {formatCents(i.allocated_cents)}
                    </Td>
                    <Td right>
                      {/* Positive variance means 90 Express is short. */}
                      <Money cents={-i.variance_cents} signed />
                    </Td>
                    <Td className="max-w-xs text-xs text-low">{i.note ?? "—"}</Td>
                    <Td right>
                      {i.status === "variance" ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <form action={decideInvoice}>
                            <input type="hidden" name="invoiceId" value={i.id} />
                            <input type="hidden" name="decision" value="approve" />
                            <SmallButton>Absorb</SmallButton>
                          </form>
                          <form action={decideInvoice}>
                            <input type="hidden" name="invoiceId" value={i.id} />
                            <input type="hidden" name="decision" value="dispute" />
                            <SmallButton primary>Dispute</SmallButton>
                          </form>
                        </div>
                      ) : (
                        <StatusBadge status={i.status} />
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <div className="px-4 pb-4">
            <EstimateNote>
              Variance is the carrier&apos;s invoice against what members were
              already billed for that load. A shortfall is 90 Express&apos;s to
              absorb or dispute — it is not re-billed to members who were given
              a figure at settlement.
            </EstimateNote>
          </div>
        </Card>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className="mt-8 grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHead title="Run history" sub="Every partner exchange, with what it changed." />
          {runs.length === 0 ? (
            <Empty>No runs yet.</Empty>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Provider</Th>
                  <Th>Operation</Th>
                  <Th>Started</Th>
                  <Th right>Seen</Th>
                  <Th right>Changed</Th>
                  <Th right>Status</Th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-850">
                    <Td className="text-sm text-hi">{r.provider_name}</Td>
                    <Td className="text-xs text-mid">
                      {r.operation.replace(/_/g, " ")}
                      <span className="block text-low">{r.trigger}</span>
                    </Td>
                    <Td className="text-xs text-mid">{fmtDateTime(r.started_at)}</Td>
                    <Td right className="num text-mid">{r.items_seen}</Td>
                    <Td right className="num text-mid">{r.items_changed}</Td>
                    <Td right>
                      <StatusBadge status={r.status} />
                      {r.error ? (
                        <p className="mt-1 max-w-xs text-xs text-alert">{r.error}</p>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHead
            title="Latest run log"
            sub={
              latestRun
                ? `${latestRun.provider_name} — ${latestRun.operation.replace(/_/g, " ")}, ${fmtDateTime(latestRun.started_at)}`
                : "No runs yet"
            }
          />
          {latestEvents.length === 0 ? (
            <Empty>No events.</Empty>
          ) : (
            <ol className="divide-y divide-ink-800">
              {latestEvents.map((e) => (
                <li key={e.sequence} className="flex gap-3 px-4 py-2.5">
                  <span className="num mt-0.5 shrink-0 text-xs text-low">
                    {String(e.sequence).padStart(2, "0")}
                  </span>
                  <p
                    className={`text-xs leading-relaxed ${
                      e.level === "error"
                        ? "text-alert"
                        : e.level === "warn"
                          ? "text-signal"
                          : "text-mid"
                    }`}
                  >
                    {e.message}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>
      </section>
    </>
  );
}

function SmallButton({
  children,
  primary,
}: {
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="submit"
      className={`whitespace-nowrap rounded px-2.5 py-1 text-xs font-semibold transition-colors ${
        primary
          ? "bg-signal text-ink-950 hover:bg-signal/90"
          : "border border-ink-600 text-hi hover:border-signal hover:text-signal"
      }`}
    >
      {children}
    </button>
  );
}

function shortName(name: string): string {
  return name.split(" ")[0];
}

function formatInterval(minutes: number): string {
  if (minutes >= 10_080) return `${Math.round(minutes / 10_080)}w`;
  if (minutes >= 1_440) return `${Math.round(minutes / 1_440)}d`;
  if (minutes >= 60) return `${Math.round(minutes / 60)}h`;
  return `${minutes}m`;
}

/** Plain-language description of a staged change. Partner text is data. */
function describe(c: {
  change_type: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown>;
  committed_cases: number;
}): string {
  const money = (v: unknown) => formatCents(Number(v));
  switch (c.change_type) {
    case "price": {
      const o = Number(c.old_value?.listPriceCents ?? 0);
      const n = Number(c.new_value.listPriceCents);
      const pct = o > 0 ? ((n - o) / o) * 100 : 0;
      return `List price ${money(o)} → ${money(n)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%).`;
    }
    case "tier": {
      const oldTiers = (c.old_value?.tiers ?? []) as Array<{
        minCases: number;
        unitPriceCents: number;
      }>;
      const newTiers = (c.new_value.tiers ?? []) as Array<{
        minCases: number;
        unitPriceCents: number;
      }>;
      const fmt = (t: typeof newTiers) =>
        t.map((x) => `${x.minCases}+ ${money(x.unitPriceCents)}`).join(", ");
      return `Ladder ${fmt(oldTiers) || "none"} → ${fmt(newTiers) || "none"}.`;
    }
    case "pack": {
      return `Pack-out ${String(c.old_value?.packDescription)} at ${String(c.old_value?.casesPerPallet)}/pallet → ${String(c.new_value.packDescription)} at ${String(c.new_value.casesPerPallet)}/pallet. Changes pallet counts, so it moves every member's freight share on this load.`;
    }
    case "new_product":
      return `Offered by the supplier at ${money(c.new_value.listPriceCents)} per ${String(c.new_value.packDescription)}. Not currently in our catalog.`;
    case "discontinued":
      return c.committed_cases > 0
        ? `No longer offered, and ${c.committed_cases} case(s) are already committed on an open cycle with no replacement source.`
        : "No longer offered. Applying deactivates it; settled cycles keep their history.";
    default:
      return "";
  }
}
