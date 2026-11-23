import Link from "next/link";

import { ApplicationForm } from "./form";
import { corridorPostalCodes } from "@/lib/onboarding/corridor";
import { getSelectableProducts, getZoneCandidates } from "@/lib/onboarding/queries";
import { Card, CardHead } from "@/components/ui";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Join 90 Express — I-77 corridor",
  description:
    "Collective purchasing and consolidated delivery for independent operators between Charlotte and Statesville.",
};

export default async function JoinPage() {
  const [products, zones] = await Promise.all([
    getSelectableProducts(),
    getZoneCandidates(),
  ]);

  const activeZones = zones.filter((z) => z.active);
  const plannedZones = zones.filter((z) => !z.active);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-8">
        <p className="eyebrow mb-2">I-77 corridor · Charlotte to Statesville</p>
        <h1 className="text-3xl font-semibold tracking-tight text-hi">
          Buy with the operators around you
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-mid">
          90 Express pools what independent operators in a zone are already
          buying into one negotiated order, and delivers it on one truck. You
          keep title to your own goods and pay the supplier directly. We
          coordinate, and we charge a share of what we actually save you.
        </p>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-mid">
          Tell us what you buy and we will show you the real number, computed
          against what the zone is committing this cycle — including when the
          answer is that joining would not save you much.
        </p>
      </header>

      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHead title="Zones taking members now" />
          <ul className="divide-y divide-ink-800">
            {activeZones.map((z) => (
              <li key={z.id} className="px-4 py-2.5 text-sm text-hi">
                {z.name}
                <span className="ml-2 text-xs text-low">
                  {z.radiusMiles} mile radius
                </span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHead
            title="Planned"
            sub="Apply anyway — the waitlist is what decides which opens next."
          />
          <ul className="divide-y divide-ink-800">
            {plannedZones.length === 0 ? (
              <li className="px-4 py-2.5 text-sm text-low">
                Nothing planned beyond the active zones yet.
              </li>
            ) : (
              plannedZones.map((z) => (
                <li key={z.id} className="px-4 py-2.5 text-sm text-mid">
                  {z.name}
                </li>
              ))
            )}
          </ul>
        </Card>
      </div>

      <ApplicationForm
        products={products.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          category: p.category,
          pack: p.pack_description,
          supplier: p.supplier_name,
          listPriceCents: p.list_price_cents,
        }))}
        postalCodes={corridorPostalCodes()}
      />

      <p className="mt-8 text-xs leading-relaxed text-low">
        Already a member?{" "}
        <Link href="/signin" className="text-mid underline hover:text-signal">
          Sign in
        </Link>
        . Your address and volumes stay in this system — we do not send them to
        a geocoder or any other third party, and suppliers and carriers only
        ever receive an opaque reference for your stop.
      </p>
    </div>
  );
}
