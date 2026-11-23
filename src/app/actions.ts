"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { planReplenishment } from "@/lib/crs/agent";
import type { Product } from "@/lib/crs/pricing";
import { sql } from "@/lib/db/client";
import {
  getAgentPolicy,
  getCurrentBusiness,
  getCycle,
  getCycleCommitments,
  getInventory,
  loadProducts,
} from "@/lib/db/queries";

const uuid = z.string().uuid();

/**
 * Confirm the signed-in user may act for this business.
 *
 * A member may only act for their own. An operator may act for the member
 * they have selected, which the header shows on screen. Every action below
 * goes through this rather than trusting the business id in the form.
 */
async function authorizeBusiness(businessId: string) {
  const user = await requireUser();
  const acting = await getCurrentBusiness();
  if (acting.id !== businessId) {
    throw new Error(
      "You are not acting for that business. Switch to it first.",
    );
  }
  return { user, business: acting };
}

const commitSchema = z.object({
  cycleId: uuid,
  businessId: uuid,
  productId: uuid,
  cases: z.coerce.number().int().min(0).max(100_000),
});

/**
 * Add or change a member's line on an open cycle.
 *
 * Only an open cycle accepts changes. Once the window closes the aggregate
 * demand is what the supplier was quoted on, and a late edit would make the
 * negotiated price a fiction.
 */
export async function commitCases(formData: FormData) {
  const input = commitSchema.parse({
    cycleId: formData.get("cycleId"),
    businessId: formData.get("businessId"),
    productId: formData.get("productId"),
    cases: formData.get("cases"),
  });

  await authorizeBusiness(input.businessId);

  const cycle = await getCycle(input.cycleId);
  if (!cycle) throw new Error("Cycle not found.");
  if (cycle.status !== "open") {
    throw new Error(
      `This cycle is ${cycle.status}; its demand is locked and cannot be changed.`,
    );
  }

  // A zone is the delivery grouping, not just a label: every member on a cycle
  // becomes a stop on that cycle's truck. Letting a member from another zone
  // commit would add a stop outside the route the load was planned around and
  // change the freight cost for everyone already on it.
  const [member] = await sql<Array<{ zone_id: string }>>`
    select zone_id from businesses where id = ${input.businessId}
  `;
  if (!member) throw new Error("Business not found.");
  if (member.zone_id !== cycle.zone_id) {
    throw new Error(
      `This cycle serves ${cycle.zone_name}. A member can only join pools in its own zone, because every member on a cycle becomes a stop on that cycle's load.`,
    );
  }

  if (input.cases === 0) {
    await sql`
      delete from commitments
      where cycle_id = ${input.cycleId}
        and business_id = ${input.businessId}
        and product_id = ${input.productId}
    `;
  } else {
    await sql`
      insert into commitments (cycle_id, business_id, product_id, cases, status, source)
      values (${input.cycleId}, ${input.businessId}, ${input.productId}, ${input.cases},
              'committed', 'manual')
      on conflict (cycle_id, business_id, product_id)
      do update set cases = excluded.cases, status = 'committed', source = 'manual'
    `;
  }

  revalidatePath(`/pools/${input.cycleId}`);
  revalidatePath("/pools");
  revalidatePath("/");
}

const decideSchema = z.object({
  proposalId: uuid,
  decision: z.enum(["approved", "rejected"]),
});

/**
 * Act on an agent proposal.
 *
 * Approving writes the commitment onto the cycle tagged as agent-sourced, so
 * the member's own order history always shows what the automation did and why.
 */
export async function decideProposal(formData: FormData) {
  const { proposalId, decision } = decideSchema.parse({
    proposalId: formData.get("proposalId"),
    decision: formData.get("decision"),
  });

  const [proposal] = await sql<
    Array<{
      id: string;
      business_id: string;
      cycle_id: string;
      product_id: string;
      cases: number;
      status: string;
      cycle_status: string;
      contact_name: string;
    }>
  >`
    select ap.id, ap.business_id, ap.cycle_id, ap.product_id, ap.cases, ap.status,
           pc.status as cycle_status, b.contact_name
    from agent_proposals ap
    join pool_cycles pc on pc.id = ap.cycle_id
    join businesses b on b.id = ap.business_id
    where ap.id = ${proposalId}
  `;
  if (!proposal) throw new Error("Proposal not found.");

  await authorizeBusiness(proposal.business_id);

  if (proposal.status !== "pending") {
    throw new Error("This proposal has already been decided.");
  }

  if (decision === "rejected") {
    await sql`
      update agent_proposals
      set status = 'rejected', decided_at = now(), decided_by = ${proposal.contact_name}
      where id = ${proposalId}
    `;
  } else {
    if (proposal.cycle_status !== "open") {
      throw new Error(
        `The ${proposal.cycle_status} cycle no longer accepts commitments. Re-run the agent against the next open cycle.`,
      );
    }
    const [row] = await sql<Array<{ id: string }>>`
      insert into commitments (cycle_id, business_id, product_id, cases, status, source, agent_run_id)
      select ap.cycle_id, ap.business_id, ap.product_id, ap.cases, 'committed', 'agent', ap.run_id
      from agent_proposals ap where ap.id = ${proposalId}
      on conflict (cycle_id, business_id, product_id)
      do update set cases = commitments.cases + excluded.cases, source = 'agent'
      returning id
    `;
    await sql`
      update agent_proposals
      set status = 'approved', decided_at = now(), decided_by = ${proposal.contact_name},
          commitment_id = ${row.id}
      where id = ${proposalId}
    `;
  }

  revalidatePath("/agent");
  revalidatePath(`/pools/${proposal.cycle_id}`);
  revalidatePath("/");
}

const policySchema = z.object({
  businessId: uuid,
  enabled: z.coerce.boolean(),
  cycleBudgetDollars: z.coerce.number().min(0).max(1_000_000),
  autoApproveUnderDollars: z.coerce.number().min(0).max(1_000_000),
});

export async function updateAgentPolicy(formData: FormData) {
  const input = policySchema.parse({
    businessId: formData.get("businessId"),
    enabled: formData.get("enabled") === "on",
    cycleBudgetDollars: formData.get("cycleBudget"),
    autoApproveUnderDollars: formData.get("autoApproveUnder"),
  });

  await authorizeBusiness(input.businessId);

  const categories = formData.getAll("categories").map(String);

  await sql`
    insert into agent_policies (business_id, enabled, cycle_budget_cents,
                                auto_approve_under_cents, allowed_categories, updated_at)
    values (${input.businessId}, ${input.enabled},
            ${Math.round(input.cycleBudgetDollars * 100)},
            ${Math.round(input.autoApproveUnderDollars * 100)},
            ${categories}, now())
    on conflict (business_id) do update set
      enabled = excluded.enabled,
      cycle_budget_cents = excluded.cycle_budget_cents,
      auto_approve_under_cents = excluded.auto_approve_under_cents,
      allowed_categories = excluded.allowed_categories,
      updated_at = now()
  `;

  revalidatePath("/agent");
}

/**
 * Run the replenishment agent for a member against an open cycle.
 *
 * Writes a run, its numbered reasoning trace and its proposals. Proposals
 * inside the auto-approval limit commit immediately; the rest wait for the
 * owner. Nothing here is hidden from the member afterwards.
 */
export async function runAgent(formData: FormData) {
  const businessId = uuid.parse(formData.get("businessId"));
  const cycleId = uuid.parse(formData.get("cycleId"));

  await authorizeBusiness(businessId);

  const [business] = await sql<Array<{ name: string; contact_name: string }>>`
    select coalesce(dba, legal_name) as name, contact_name from businesses where id = ${businessId}
  `;
  if (!business) throw new Error("Business not found.");

  const cycle = await getCycle(cycleId);
  if (!cycle) throw new Error("Cycle not found.");
  if (cycle.status !== "open") throw new Error("That cycle is no longer open.");

  const policy = await getAgentPolicy(businessId);
  if (!policy) throw new Error("No agent policy configured for this business.");

  const [inventory, catalog, commitments] = await Promise.all([
    getInventory(businessId),
    loadProducts(cycle.supplier_id),
    getCycleCommitments(cycleId),
  ]);

  const zoneDemand = new Map<string, number>();
  const own = new Map<string, number>();
  for (const c of commitments) {
    if (c.business_id === businessId) {
      own.set(c.product_id, (own.get(c.product_id) ?? 0) + c.cases);
    } else {
      zoneDemand.set(c.product_id, (zoneDemand.get(c.product_id) ?? 0) + c.cases);
    }
  }

  const plan = planReplenishment({
    businessName: business.name,
    deliveryDate: new Date(cycle.delivery_date),
    now: new Date(),
    policy: {
      enabled: policy.enabled,
      cycleBudgetCents: policy.cycle_budget_cents,
      autoApproveUnderCents: policy.auto_approve_under_cents,
      allowedCategories: policy.allowed_categories,
    },
    inventory: inventory.map((i) => ({
      productId: i.product_id,
      onHandCases: Number(i.on_hand_cases),
      avgWeeklyCases: Number(i.avg_weekly_cases),
      parCases: Number(i.par_cases),
      safetyDays: i.safety_days,
    })),
    products: catalog as Map<string, Product>,
    zoneDemand,
    existingCommitments: own,
  });

  const [run] = await sql<Array<{ id: string }>>`
    insert into agent_runs (business_id, cycle_id, status, trigger, finished_at)
    values (${businessId}, ${cycleId}, 'completed', 'manual', now())
    returning id
  `;

  for (const step of plan.steps) {
    await sql`
      insert into agent_steps (run_id, sequence, label, detail)
      values (${run.id}, ${step.sequence}, ${step.label}, ${step.detail})
    `;
  }

  for (const p of plan.proposals) {
    let commitmentId: string | null = null;
    if (p.autoApprove) {
      const [row] = await sql<Array<{ id: string }>>`
        insert into commitments (cycle_id, business_id, product_id, cases, status, source, agent_run_id)
        values (${cycleId}, ${businessId}, ${p.productId}, ${p.cases}, 'committed', 'agent', ${run.id})
        on conflict (cycle_id, business_id, product_id)
        do update set cases = commitments.cases + excluded.cases, source = 'agent'
        returning id
      `;
      commitmentId = row.id;
    }
    await sql`
      insert into agent_proposals (run_id, business_id, cycle_id, product_id, cases,
                                   est_unit_cents, est_total_cents, days_to_depletion,
                                   reason, status, decided_at, decided_by, commitment_id)
      values (${run.id}, ${businessId}, ${cycleId}, ${p.productId}, ${p.cases},
              ${p.estUnitCents}, ${p.estTotalCents}, ${p.daysToDepletion}, ${p.reason},
              ${p.autoApprove ? "auto_approved" : "pending"},
              ${p.autoApprove ? new Date() : null},
              ${p.autoApprove ? "90 Express agent" : null},
              ${commitmentId})
    `;
  }

  revalidatePath("/agent");
  revalidatePath(`/pools/${cycleId}`);
  revalidatePath("/");
}
