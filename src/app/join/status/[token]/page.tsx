import Link from "next/link";
import { notFound } from "next/navigation";

import { hashToken } from "@/lib/auth/crypto";
import { formatCents } from "@/lib/crs/money";
import {
  getApplicationByTokenHash,
  getApplicationProducts,
} from "@/lib/onboarding/queries";
import type { SavingsEstimate } from "@/lib/onboarding/estimate";
import {
  Badge,
  Card,
  CardHead,
  fmtDate,
  Money,
  Stat,
  Table,
  Td,
  Th,
  titleCase,
} from "@/components/ui";

export const dynamic = "force-dynamic";

/** The status link is a bearer token; keep it out of search results. */
export const metadata = { robots: { index: false, follow: false } };

export default async function ApplicationStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const application = await getApplicationByTokenHash(hashToken(token));
  if (!application) notFound();

  const products = await getApplicationProducts(application.id);
  const estimate = application.estimate as SavingsEstimate | null;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <p className="eyebrow mb-2">Application · {fmtDate(application.created_at)}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-hi">
          {application.dba ?? application.legal_name}
        </h1>
        <p className="mt-2 text-sm text-mid">
          {titleCase(application.segment)} · {application.city},{" "}
          {application.state} {application.postal_code}
        </p>
        <div className="mt-3">
          <StatusLine application={application} />
        </div>
      </header>

      {estimate ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Estimated net, per month"
              value={formatCents(estimate.netPerMonthCents)}
              tone={estimate.netPerMonthCents > 0 ? "guide" : "signal"}
              sub={`About ${formatCents(estimate.netPerCycleCents)} per cycle, after our fee`}
            />
            <Stat
              label="On goods"
              value={formatCents(estimate.goodsSavingsCents)}
              tone={estimate.goodsSavingsCents > 0 ? "guide" : "neutral"}
              sub="Per cycle, from reaching the zone's volume break"
            />
            <Stat
              label="On delivery"
              value={formatCents(estimate.freightSavingsCents)}
              tone={estimate.freightSavingsCents > 0 ? "guide" : "signal"}
              sub={`Your ${estimate.palletsPerCycle} pallet(s) on a ${estimate.stopsOnLoad}-stop load`}
            />
            <Stat
              label="Our fee"
              value={formatCents(estimate.feesCents)}
              sub="A share of what we save you, never more than we saved"
            />
          </div>

          {estimate.caveats.length > 0 ? (
            <Card className="mt-6 border-signal/40">
              <CardHead
                title="What this number depends on"
                sub="Read this part. It is the part that decides whether joining is actually worth it for you."
              />
              <ul className="divide-y divide-ink-800">
                {estimate.caveats.map((c) => (
                  <li key={c.kind} className="px-4 py-3 text-sm leading-relaxed text-mid">
                    {c.message}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          <Card className="mt-6">
            <CardHead
              title="Line by line"
              sub="Your price buying alone, against the price the zone's pooled volume reaches with you in it."
            />
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th right>Cases / cycle</Th>
                  <Th right>Zone already buys</Th>
                  <Th right>You alone</Th>
                  <Th right>Pooled</Th>
                  <Th right>Saved</Th>
                </tr>
              </thead>
              <tbody>
                {estimate.lines.map((l) => (
                  <tr key={l.productId} className="hover:bg-ink-850">
                    <Td>
                      <p className="text-sm text-hi">{l.name}</p>
                      <p className="text-xs text-low">{l.sku}</p>
                    </Td>
                    <Td right className="num text-mid">{l.casesPerCycle}</Td>
                    <Td right className="num text-low">{l.zoneCasesBefore}</Td>
                    <Td right className="num text-mid">
                      {formatCents(l.soloUnitCents)}
                    </Td>
                    <Td right className="num font-semibold text-hi">
                      {formatCents(l.pooledUnitCents)}
                    </Td>
                    <Td right>
                      <Money cents={l.savingsCents} signed />
                    </Td>
                  </tr>
                ))}
                <tr className="bg-ink-850">
                  <Td className="eyebrow">Per cycle</Td>
                  <Td right />
                  <Td right />
                  <Td right className="num text-mid">
                    {formatCents(estimate.goodsSoloCents)}
                  </Td>
                  <Td right className="num text-hi">
                    {formatCents(estimate.goodsPooledCents)}
                  </Td>
                  <Td right>
                    <Money cents={estimate.goodsSavingsCents} signed />
                  </Td>
                </tr>
              </tbody>
            </Table>
          </Card>

          <Card className="mt-6">
            <CardHead title="Delivery" />
            <dl className="space-y-2 px-4 py-4 text-sm">
              <Row
                label="Shipping this yourself (estimated)"
                value={formatCents(estimate.freightSoloCents)}
              />
              <Row
                label="Your share of the consolidated load"
                value={formatCents(estimate.freightPooledCents)}
              />
              <div className="my-2 border-t border-ink-700" />
              <div className="flex items-baseline justify-between">
                <dt className="font-semibold text-hi">Difference</dt>
                <dd>
                  <Money cents={estimate.freightSavingsCents} signed className="font-semibold" />
                </dd>
              </div>
            </dl>
          </Card>
        </>
      ) : (
        <Card>
          <CardHead
            title="No estimate yet"
            sub={
              application.zone_id
                ? "This zone has no pooled volume to compare against yet, so any number we gave you would be invented."
                : "You are outside our active zones today, so there is no zone volume to price you against."
            }
          />
        </Card>
      )}

      <Card className="mt-6">
        <CardHead title="What you told us you buy" />
        <Table>
          <thead>
            <tr>
              <Th>Product</Th>
              <Th>Supplier</Th>
              <Th right>Cases / month</Th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.product_id}>
                <Td>
                  <span className="text-sm text-hi">{p.name}</span>
                  <span className="ml-2 text-xs text-low">{p.sku}</span>
                </Td>
                <Td className="text-xs text-mid">{p.supplier_name}</Td>
                <Td right className="num text-mid">{p.monthly_cases}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>

      <p className="mt-8 text-xs leading-relaxed text-low">
        Keep this link — it is the only way back to this page, and it is not
        indexed or shared. Questions before you hear from us? Reply to the
        address we contacted you from.{" "}
        <Link href="/join" className="underline hover:text-signal">
          Start another application
        </Link>
        .
      </p>
    </div>
  );
}

function StatusLine({
  application,
}: {
  application: Awaited<ReturnType<typeof getApplicationByTokenHash>>;
}) {
  if (!application) return null;
  switch (application.status) {
    case "submitted":
      return (
        <p className="text-sm text-mid">
          <Badge tone="signal">submitted</Badge>{" "}
          Matched to <strong className="text-hi">{application.zone_name}</strong>
          {application.distance_miles !== null
            ? ` — ${application.distance_miles} miles from the zone centre.`
            : "."}{" "}
          We review applications in the order they arrive.
        </p>
      );
    case "reviewing":
      return (
        <p className="text-sm text-mid">
          <Badge tone="signal">in review</Badge> Someone is looking at this now.
        </p>
      );
    case "waitlisted":
      return (
        <p className="text-sm text-mid">
          <Badge tone="route">waitlisted</Badge> You are outside our active
          zones — the nearest is{" "}
          <strong className="text-hi">{application.nearest_zone_name}</strong>
          {application.distance_miles !== null
            ? `, ${application.distance_miles} miles away`
            : ""}
          . A zone opens when enough operators near it are waiting, so your
          application is itself the thing that moves it along.
        </p>
      );
    case "approved":
      return (
        <p className="text-sm text-mid">
          <Badge tone="guide">approved</Badge> Welcome. Check your email for the
          link to set a password, then accept the member agreement to activate.
        </p>
      );
    case "declined":
      return (
        <p className="text-sm text-mid">
          <Badge tone="alert">declined</Badge>{" "}
          {application.decline_reason ?? "We were not able to take this on."}
        </p>
      );
    default:
      return (
        <p className="text-sm text-mid">
          <Badge>{application.status}</Badge>
        </p>
      );
  }
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-mid">{label}</dt>
      <dd className="num text-mid">{value}</dd>
    </div>
  );
}
