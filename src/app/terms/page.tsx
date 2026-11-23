import { redirect } from "next/navigation";

import { acceptTerms } from "@/lib/onboarding/actions";
import { requireUser } from "@/lib/auth/session";
import { getBusiness } from "@/lib/db/queries";
import { getCurrentTerms, getTermsAcceptance } from "@/lib/onboarding/queries";
import { Card, CardHead, fmtDate, PageHead } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "Member agreement — 90 Express" };

export default async function TermsPage() {
  const user = await requireUser("/terms");
  const terms = await getCurrentTerms();

  if (!terms) {
    return (
      <Card>
        <CardHead
          title="No member agreement published"
          sub="An operator needs to publish a terms version before members can accept one."
        />
      </Card>
    );
  }

  if (!user.businessId) {
    // Operators have nothing to accept; show the agreement read-only.
    return (
      <>
        <PageHead
          eyebrow={`Version ${terms.version} · effective ${fmtDate(terms.effective_from)}`}
          title="Member agreement"
          sub={terms.summary}
        />
        <Clauses body={terms.body} />
      </>
    );
  }

  const [business, existing] = await Promise.all([
    getBusiness(user.businessId),
    getTermsAcceptance(user.businessId),
  ]);

  if (existing?.version === terms.version) redirect("/");

  return (
    <div className="mx-auto max-w-3xl">
      <PageHead
        eyebrow={`Version ${terms.version} · effective ${fmtDate(terms.effective_from)}`}
        title="Member agreement"
        sub={terms.summary}
      />

      <Clauses body={terms.body} />

      <Card className="mt-6">
        <CardHead
          title="Accept"
          sub="Accepting activates the membership and records which version you agreed to."
        />
        <form action={acceptTerms} className="space-y-4 px-4 py-4">
          <input type="hidden" name="termsVersionId" value={terms.id} />
          <div>
            <label
              htmlFor="acceptedByName"
              className="mb-1.5 block text-sm font-medium text-hi"
            >
              Your full name
            </label>
            <input
              id="acceptedByName"
              name="acceptedByName"
              required
              minLength={2}
              defaultValue={user.displayName}
              className="w-full max-w-sm rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            />
            <p className="mt-1 text-xs text-low">
              Recorded against {business?.dba ?? business?.legal_name} with
              today&apos;s date and version {terms.version}.
            </p>
          </div>
          <button
            type="submit"
            className="rounded bg-signal px-5 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal/90"
          >
            Accept and activate
          </button>
        </form>
      </Card>
    </div>
  );
}

function Clauses({ body }: { body: Array<{ heading: string; text: string }> }) {
  return (
    <Card>
      <ol className="divide-y divide-ink-800">
        {body.map((clause, i) => (
          <li key={clause.heading} className="px-4 py-4">
            <h3 className="text-sm font-semibold text-hi">
              <span className="num mr-2 text-low">{i + 1}.</span>
              {clause.heading}
            </h3>
            <p className="mt-1.5 text-sm leading-relaxed text-mid">{clause.text}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
