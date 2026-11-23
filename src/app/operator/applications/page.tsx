import Link from "next/link";

import {
  approveApplication,
  declineApplication,
  markReviewing,
} from "@/lib/onboarding/actions";
import { requireOperator } from "@/lib/auth/session";
import { formatCents } from "@/lib/crs/money";
import type { SavingsEstimate } from "@/lib/onboarding/estimate";
import {
  getApplications,
  getOnboardingStats,
  getWaitlistByZone,
} from "@/lib/onboarding/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  fmtDate,
  Money,
  PageHead,
  Stat,
  StatusBadge,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ invited?: string }>;
}) {
  await requireOperator("/operator/applications");
  const { invited } = await searchParams;

  const [applications, stats, waitlist] = await Promise.all([
    getApplications(),
    getOnboardingStats(),
    getWaitlistByZone(),
  ]);

  const open = applications.filter((a) =>
    ["submitted", "reviewing"].includes(a.status),
  );
  const waiting = applications.filter((a) => a.status === "waitlisted");
  const closed = applications.filter((a) =>
    ["approved", "declined", "withdrawn"].includes(a.status),
  );

  return (
    <>
      <PageHead
        eyebrow="Operator view"
        title="Applications"
        sub="Every applicant was shown an estimate computed against the zone's real committed volume. That number is on the application, so a member can be held to what they were told."
      />

      {invited ? (
        <Card className="mb-6 border-guide/50">
          <div className="px-4 py-3">
            <p className="text-sm font-semibold text-guide">
              Member provisioned. Send them this invite link.
            </p>
            <p className="mt-1 text-xs text-mid">
              Nothing emails automatically yet, so this is the only copy — it is
              stored hashed and cannot be shown again. It expires in 14 days.
            </p>
            <code className="num mt-2 block overflow-x-auto rounded border border-ink-600 bg-ink-850 px-3 py-2 text-xs text-hi">
              /invite/{invited}
            </code>
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Awaiting review"
          value={stats.submitted}
          tone={stats.submitted > 0 ? "signal" : "neutral"}
        />
        <Stat
          label="Waitlisted"
          value={stats.waitlisted}
          tone="route"
          sub="Outside every active zone"
        />
        <Stat
          label="Approved, 30 days"
          value={stats.approved_30d}
          tone="guide"
          sub={`${stats.declined_30d} declined`}
        />
        <Stat
          label="Pipeline value"
          value={formatCents(stats.pipeline_monthly_cents)}
          sub="Monthly member savings we have estimated for open applicants"
        />
      </div>

      {waitlist.length > 0 ? (
        <Card className="mt-6">
          <CardHead
            title="Waitlist by zone"
            sub="Where demand is building. A planned zone opens when enough operators near it are waiting — this table is that signal."
          />
          <Table>
            <thead>
              <tr>
                <Th>Nearest zone</Th>
                <Th>Status</Th>
                <Th right>Waiting</Th>
                <Th>Towns</Th>
              </tr>
            </thead>
            <tbody>
              {waitlist.map((w) => (
                <tr key={w.zone_id} className="hover:bg-ink-850">
                  <Td className="font-medium text-hi">{w.zone_name}</Td>
                  <Td>
                    {w.active ? (
                      <Badge tone="guide">active</Badge>
                    ) : (
                      <Badge tone="route">planned</Badge>
                    )}
                  </Td>
                  <Td right className="num font-semibold text-hi">{w.waiting}</Td>
                  <Td className="text-xs text-mid">{w.cities}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      ) : null}

      <section className="mt-8">
        <h2 className="eyebrow mb-3">
          Awaiting review{open.length > 0 ? ` (${open.length})` : ""}
        </h2>
        {open.length === 0 ? (
          <Card>
            <Empty>Nothing waiting.</Empty>
          </Card>
        ) : (
          <div className="space-y-4">
            {open.map((a) => (
              <ApplicationCard key={a.id} application={a} canApprove />
            ))}
          </div>
        )}
      </section>

      {waiting.length > 0 ? (
        <section className="mt-8">
          <h2 className="eyebrow mb-3">Waitlisted ({waiting.length})</h2>
          <div className="space-y-4">
            {waiting.map((a) => (
              <ApplicationCard key={a.id} application={a} canApprove={false} />
            ))}
          </div>
        </section>
      ) : null}

      {closed.length > 0 ? (
        <section className="mt-8">
          <h2 className="eyebrow mb-3">Decided</h2>
          <Card>
            <Table>
              <thead>
                <tr>
                  <Th>Business</Th>
                  <Th>Zone</Th>
                  <Th>Outcome</Th>
                  <Th>Reviewed</Th>
                  <Th right>Estimated / month</Th>
                </tr>
              </thead>
              <tbody>
                {closed.map((a) => {
                  const estimate = a.estimate as SavingsEstimate | null;
                  return (
                    <tr key={a.id} className="hover:bg-ink-850">
                      <Td>
                        <p className="text-sm text-hi">{a.dba ?? a.legal_name}</p>
                        <p className="text-xs text-low">
                          {a.city}, {a.state}
                        </p>
                      </Td>
                      <Td className="text-xs text-mid">{a.zone_name ?? "—"}</Td>
                      <Td>
                        <StatusBadge status={a.status} />
                        {a.decline_reason ? (
                          <p className="mt-1 max-w-xs text-xs text-low">
                            {a.decline_reason}
                          </p>
                        ) : null}
                      </Td>
                      <Td className="text-xs text-mid">
                        {a.reviewed_at ? fmtDate(a.reviewed_at) : "—"}
                        {a.reviewed_by ? (
                          <span className="block text-low">{a.reviewed_by}</span>
                        ) : null}
                      </Td>
                      <Td right>
                        {estimate ? (
                          <Money cents={estimate.netPerMonthCents} signed />
                        ) : (
                          <span className="text-low">—</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          </Card>
        </section>
      ) : null}
    </>
  );
}

function ApplicationCard({
  application,
  canApprove,
}: {
  application: Awaited<ReturnType<typeof getApplications>>[number];
  canApprove: boolean;
}) {
  const estimate = application.estimate as SavingsEstimate | null;

  return (
    <Card>
      <CardHead
        title={application.dba ?? application.legal_name}
        sub={
          <>
            {titleCase(application.segment)} · {application.street},{" "}
            {application.city}, {application.state} {application.postal_code} ·{" "}
            {titleCase(application.dock_type)} receiving ·{" "}
            {application.product_count} product
            {application.product_count === 1 ? "" : "s"} declared · applied{" "}
            {fmtDate(application.created_at)}
          </>
        }
        right={<StatusBadge status={application.status} />}
      />

      <div className="grid gap-px bg-ink-700 sm:grid-cols-4">
        <Figure
          label="Zone"
          value={application.zone_name ?? application.nearest_zone_name ?? "—"}
          sub={
            application.distance_miles !== null
              ? `${application.distance_miles} mi from centre`
              : undefined
          }
        />
        <Figure
          label="Requested plan"
          value={titleCase(application.requested_tier)}
        />
        <Figure
          label="Estimated net / month"
          value={estimate ? formatCents(estimate.netPerMonthCents) : "—"}
          tone={
            estimate
              ? estimate.netPerMonthCents > 0
                ? "guide"
                : "signal"
              : undefined
          }
        />
        <Figure
          label="Of which goods"
          value={estimate ? formatCents(estimate.goodsSavingsCents) : "—"}
          sub={
            estimate
              ? `${formatCents(estimate.freightSavingsCents)} delivery, per cycle`
              : undefined
          }
        />
      </div>

      {estimate && estimate.caveats.length > 0 ? (
        <div className="border-b border-ink-700 px-4 py-3">
          <p className="eyebrow mb-1.5">What the applicant was told</p>
          <ul className="space-y-1">
            {estimate.caveats.map((c) => (
              <li key={c.kind} className="text-xs leading-relaxed text-mid">
                · {c.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {application.notes ? (
        <div className="border-b border-ink-700 px-4 py-3">
          <p className="eyebrow mb-1">Their note</p>
          <p className="text-sm text-mid">{application.notes}</p>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <p className="mr-auto text-xs text-low">
          {application.contact_name} · {application.contact_email}
          {application.phone ? ` · ${application.phone}` : ""}
        </p>

        {application.status === "submitted" ? (
          <form action={markReviewing}>
            <input type="hidden" name="applicationId" value={application.id} />
            <button
              type="submit"
              className="rounded border border-ink-600 px-3 py-1.5 text-xs font-semibold text-hi transition-colors hover:border-signal hover:text-signal"
            >
              Mark in review
            </button>
          </form>
        ) : null}

        {canApprove ? (
          <form action={approveApplication}>
            <input type="hidden" name="applicationId" value={application.id} />
            <button
              type="submit"
              className="rounded bg-signal px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-signal/90"
            >
              Approve and provision
            </button>
          </form>
        ) : (
          <span className="text-xs text-low">
            Outside an active zone — open a zone to approve.
          </span>
        )}

        <form action={declineApplication} className="flex items-center gap-1.5">
          <input type="hidden" name="applicationId" value={application.id} />
          <label htmlFor={`reason-${application.id}`} className="sr-only">
            Reason for declining
          </label>
          <input
            id={`reason-${application.id}`}
            name="reason"
            placeholder="Reason, shown to them"
            required
            minLength={3}
            maxLength={500}
            className="w-56 rounded border border-ink-600 bg-ink-850 px-2 py-1.5 text-xs text-hi"
          />
          <button
            type="submit"
            className="rounded border border-ink-600 px-3 py-1.5 text-xs font-semibold text-mid transition-colors hover:border-alert hover:text-alert"
          >
            Decline
          </button>
        </form>
      </div>

      {application.business_id ? (
        <div className="border-t border-ink-700 px-4 py-2">
          <Link
            href="/network"
            className="text-xs text-mid underline hover:text-signal"
          >
            Provisioned — see them in the network
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

function Figure({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "guide" | "signal";
}) {
  const toneClass =
    tone === "guide" ? "text-guide" : tone === "signal" ? "text-signal" : "text-hi";
  return (
    <div className="bg-ink-900 px-4 py-2.5">
      <p className="eyebrow">{label}</p>
      <p className={`num mt-1 text-sm font-semibold ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-low">{sub}</p> : null}
    </div>
  );
}
