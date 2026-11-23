import Link from "next/link";

import { decideProposal, runAgent, updateAgentPolicy } from "@/app/actions";
import { formatCents } from "@/lib/crs/money";
import {
  getAgentPolicy,
  getAgentRuns,
  getAgentSteps,
  getCurrentBusiness,
  getCycles,
  getProposals,
} from "@/lib/db/queries";
import {
  Badge,
  Card,
  CardHead,
  Empty,
  fmtDateTime,

  PageHead,
  relDays,
  Stat,
  StatusBadge,
  titleCase,
} from "@/components/ui";

export const dynamic = "force-dynamic";

const CATEGORIES = [
  "disposables",
  "paper",
  "sanitation",
  "dry_goods",
  "oils_fats",
  "produce",
  "protein",
  "dairy",
];

export default async function AgentPage() {
  const business = await getCurrentBusiness();
  const [policy, proposals, runs, cycles] = await Promise.all([
    getAgentPolicy(business.id),
    getProposals(business.id),
    getAgentRuns(business.id),
    getCycles(),
  ]);

  const openCycles = cycles.filter(
    (c) => c.status === "open" && c.zone_id === business.zone_id,
  );
  const pending = proposals.filter((p) => p.status === "pending");
  const auto = proposals.filter((p) => p.status === "auto_approved");
  const latestRun = runs[0];
  const steps = latestRun ? await getAgentSteps(latestRun.id) : [];

  return (
    <>
      <PageHead
        eyebrow={business.dba ?? business.legal_name}
        title="Autonomous replenishment"
        sub="The agent watches consumption against each item's par level, checks what the rest of the zone is already buying, and prepares the order. It commits only inside the limits set here, and every decision it makes is written down."
        right={
          policy?.enabled ? (
            <Badge tone="guide">Active</Badge>
          ) : (
            <Badge tone="neutral">Disabled</Badge>
          )
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Awaiting approval"
          value={pending.length}
          tone={pending.length > 0 ? "signal" : "neutral"}
          sub={
            pending.length > 0
              ? `${formatCents(pending.reduce((a, p) => a + p.est_total_cents, 0))} proposed`
              : "Nothing waiting"
          }
        />
        <Stat
          label="Auto-approved"
          value={auto.length}
          tone="guide"
          sub={`Under the ${formatCents(policy?.auto_approve_under_cents ?? 0)} per-order limit`}
        />
        <Stat
          label="Cycle budget"
          value={formatCents(policy?.cycle_budget_cents ?? 0)}
          sub="Hard ceiling the agent may commit per cycle"
        />
        <Stat
          label="Last run"
          value={latestRun ? relDays(latestRun.started_at) : "Never"}
          sub={
            latestRun
              ? `${latestRun.proposal_count} proposal${latestRun.proposal_count === 1 ? "" : "s"} · ${latestRun.trigger}`
              : "No runs recorded"
          }
        />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          <Card>
            <CardHead
              title="Proposals"
              sub="Each one states what it saw and why it acted. Approving writes the line onto the cycle, tagged as agent-sourced."
            />
            {proposals.length === 0 ? (
              <Empty>
                No proposals yet. Run the agent against an open cycle to generate some.
              </Empty>
            ) : (
              <ul className="divide-y divide-ink-800">
                {proposals.map((p) => (
                  <li key={p.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-hi">
                          {p.cases} × {p.product_name}
                          <span className="ml-2 text-xs font-normal text-low">
                            {p.product_sku}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-mid">
                          <Link
                            href={`/pools/${p.cycle_id}`}
                            className="hover:text-signal"
                          >
                            {p.cycle_name}
                          </Link>{" "}
                          · {formatCents(p.est_unit_cents)}/case ·{" "}
                          {p.days_to_depletion.toFixed(1)} days of cover
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="num text-sm font-semibold text-hi">
                          {formatCents(p.est_total_cents)}
                        </span>
                        <StatusBadge status={p.status} />
                      </div>
                    </div>

                    <p className="mt-2 text-sm leading-relaxed text-mid">{p.reason}</p>

                    {p.status === "pending" ? (
                      <div className="mt-3 flex gap-2">
                        <form action={decideProposal}>
                          <input type="hidden" name="proposalId" value={p.id} />
                          <input type="hidden" name="decision" value="approved" />
                          <button
                            type="submit"
                            className="rounded bg-signal px-3 py-1.5 text-xs font-semibold text-ink-950 transition-colors hover:bg-signal/90"
                          >
                            Approve and commit
                          </button>
                        </form>
                        <form action={decideProposal}>
                          <input type="hidden" name="proposalId" value={p.id} />
                          <input type="hidden" name="decision" value="rejected" />
                          <button
                            type="submit"
                            className="rounded border border-ink-600 px-3 py-1.5 text-xs font-semibold text-mid transition-colors hover:border-alert hover:text-alert"
                          >
                            Decline
                          </button>
                        </form>
                      </div>
                    ) : p.decided_by ? (
                      <p className="mt-2 text-xs text-low">
                        {titleCase(p.status)} by {p.decided_by}
                        {p.decided_at ? ` · ${fmtDateTime(p.decided_at)}` : ""}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {steps.length > 0 ? (
            <Card>
              <CardHead
                title="Reasoning trace"
                sub={`From the run on ${fmtDateTime(latestRun!.started_at)}${latestRun!.cycle_name ? ` against ${latestRun!.cycle_name}` : ""}. Deterministic arithmetic, not a model's guess — every figure can be checked by hand.`}
              />
              <ol className="divide-y divide-ink-800">
                {steps.map((s) => (
                  <li key={s.sequence} className="flex gap-3 px-4 py-3">
                    <span className="num mt-0.5 shrink-0 text-xs font-semibold text-low">
                      {String(s.sequence).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-hi">{s.label}</p>
                      <p className="mt-0.5 text-sm leading-relaxed text-mid">
                        {s.detail}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            </Card>
          ) : null}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHead
              title="Policy"
              sub="The limits the agent works inside. It never exceeds them; it flags instead."
            />
            <form action={updateAgentPolicy} className="space-y-4 px-4 py-4">
              <input type="hidden" name="businessId" value={business.id} />

              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={policy?.enabled ?? false}
                  className="mt-0.5 h-4 w-4 accent-[var(--signal)]"
                />
                <span>
                  <span className="block text-sm font-medium text-hi">
                    Autonomous procurement
                  </span>
                  <span className="block text-xs text-mid">
                    Let the agent prepare and commit orders within these limits.
                  </span>
                </span>
              </label>

              <div>
                <label
                  htmlFor="cycleBudget"
                  className="block text-sm font-medium text-hi"
                >
                  Cycle budget
                </label>
                <p className="mb-1.5 text-xs text-mid">
                  Most it may commit on one cycle. Past this it holds items and
                  flags them for you.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-low">$</span>
                  <input
                    id="cycleBudget"
                    name="cycleBudget"
                    type="number"
                    min={0}
                    step={25}
                    defaultValue={((policy?.cycle_budget_cents ?? 0) / 100).toFixed(0)}
                    className="num w-full rounded border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm text-hi"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="autoApproveUnder"
                  className="block text-sm font-medium text-hi"
                >
                  Approve without asking, under
                </label>
                <p className="mb-1.5 text-xs text-mid">
                  Orders at or below this land on the cycle directly. Anything
                  larger waits for you.
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-low">$</span>
                  <input
                    id="autoApproveUnder"
                    name="autoApproveUnder"
                    type="number"
                    min={0}
                    step={25}
                    defaultValue={(
                      (policy?.auto_approve_under_cents ?? 0) / 100
                    ).toFixed(0)}
                    className="num w-full rounded border border-ink-600 bg-ink-850 px-2 py-1.5 text-sm text-hi"
                  />
                </div>
              </div>

              <fieldset>
                <legend className="text-sm font-medium text-hi">
                  Categories it may buy
                </legend>
                <p className="mb-2 text-xs text-mid">
                  Anything outside this list stays a human decision.
                </p>
                <div className="grid grid-cols-2 gap-1.5">
                  {CATEGORIES.map((c) => (
                    <label key={c} className="flex items-center gap-2 text-xs text-mid">
                      <input
                        type="checkbox"
                        name="categories"
                        value={c}
                        defaultChecked={policy?.allowed_categories?.includes(c) ?? false}
                        className="h-3.5 w-3.5 accent-[var(--signal)]"
                      />
                      {titleCase(c)}
                    </label>
                  ))}
                </div>
              </fieldset>

              <button
                type="submit"
                className="w-full rounded border border-ink-600 px-3 py-2 text-sm font-semibold text-hi transition-colors hover:border-signal hover:text-signal"
              >
                Save policy
              </button>
            </form>
          </Card>

          <Card>
            <CardHead
              title="Run now"
              sub="Plan against an open cycle in your zone."
            />
            {openCycles.length === 0 ? (
              <Empty>No open cycle in {business.zone_name}.</Empty>
            ) : (
              <div className="space-y-2 px-4 py-4">
                {openCycles.map((c) => (
                  <form key={c.id} action={runAgent} className="flex items-center gap-2">
                    <input type="hidden" name="businessId" value={business.id} />
                    <input type="hidden" name="cycleId" value={c.id} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-hi">{c.name}</p>
                      <p className="text-xs text-low">
                        delivers {relDays(c.delivery_date)}
                      </p>
                    </div>
                    <button
                      type="submit"
                      className="shrink-0 rounded border border-ink-600 px-2.5 py-1.5 text-xs font-semibold text-hi transition-colors hover:border-signal hover:text-signal"
                    >
                      Run
                    </button>
                  </form>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHead title="Run history" />
            {runs.length === 0 ? (
              <Empty>No runs yet.</Empty>
            ) : (
              <ul className="divide-y divide-ink-800">
                {runs.map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-xs text-hi">
                        {r.cycle_name ?? "No cycle"}
                      </p>
                      <p className="text-xs text-low">
                        {fmtDateTime(r.started_at)} · {r.trigger}
                      </p>
                    </div>
                    <span className="num shrink-0 text-xs text-mid">
                      {r.proposal_count}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
