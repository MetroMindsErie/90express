/**
 * Autonomous replenishment planner.
 *
 * Deliberately deterministic. Every proposal comes out of arithmetic a member
 * can check by hand, and every run emits a numbered reasoning trace. A member
 * handing a budget to software will not keep doing it if the software cannot
 * explain itself, and a language model is not needed to decide that a
 * restaurant burning six cases of oil a week with four on hand needs oil.
 *
 * Where an LLM belongs later: reading supplier emails and PDF price sheets,
 * handling substitutions, and negotiating. Not the reorder arithmetic.
 */
import { unitPriceFor, type Product } from "./pricing";

export type InventoryItem = {
  productId: string;
  onHandCases: number;
  avgWeeklyCases: number;
  parCases: number;
  safetyDays: number;
};

export type AgentPolicy = {
  enabled: boolean;
  /** Ceiling the agent may commit in one cycle. */
  cycleBudgetCents: number;
  /** A proposal at or under this value may be approved without a human. */
  autoApproveUnderCents: number;
  allowedCategories: string[];
};

export type AgentProposal = {
  productId: string;
  cases: number;
  estUnitCents: number;
  estTotalCents: number;
  daysToDepletion: number;
  reason: string;
  /** True when policy lets the agent commit this without asking. */
  autoApprove: boolean;
};

export type AgentStep = { sequence: number; label: string; detail: string };

export type AgentPlan = {
  proposals: AgentProposal[];
  steps: AgentStep[];
  estTotalCents: number;
  skipped: Array<{ productId: string; reason: string }>;
};

export type AgentContext = {
  businessName: string;
  /** Delivery date of the cycle being planned for. */
  deliveryDate: Date;
  now: Date;
  policy: AgentPolicy;
  inventory: InventoryItem[];
  products: Map<string, Product>;
  /**
   * Cases already committed by other members in this zone for this cycle,
   * per product. Used to price the proposal at the pooled quantity rather
   * than the member's own quantity.
   */
  zoneDemand: Map<string, number>;
  /** Cases this member has already committed in this cycle. */
  existingCommitments: Map<string, number>;
};

const MS_PER_DAY = 86_400_000;

export function daysBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

/**
 * Days of stock left at the observed burn rate. Infinity when a product has
 * no recorded usage, which keeps a zero-usage item from being reordered.
 */
export function daysToDepletion(item: InventoryItem): number {
  const daily = item.avgWeeklyCases / 7;
  if (daily <= 0) return Number.POSITIVE_INFINITY;
  return item.onHandCases / daily;
}

export function planReplenishment(ctx: AgentContext): AgentPlan {
  const steps: AgentStep[] = [];
  const proposals: AgentProposal[] = [];
  const skipped: Array<{ productId: string; reason: string }> = [];
  let sequence = 0;
  const step = (label: string, detail: string) =>
    steps.push({ sequence: ++sequence, label, detail });

  const daysUntilDelivery = Math.max(0, daysBetween(ctx.now, ctx.deliveryDate));

  step(
    "Read the cycle window",
    `Next consolidated delivery lands in ${daysUntilDelivery.toFixed(1)} days. Any item that runs out before then plus its safety buffer needs to be on this load.`,
  );

  if (!ctx.policy.enabled) {
    step(
      "Halt — automation off",
      `Autonomous procurement is disabled for ${ctx.businessName}. No proposals generated.`,
    );
    return { proposals, steps, estTotalCents: 0, skipped };
  }

  step(
    "Check inventory positions",
    `Reviewing ${ctx.inventory.length} tracked item${ctx.inventory.length === 1 ? "" : "s"} against par levels and observed weekly usage.`,
  );

  // Rank by urgency so the budget, if it binds, buys the most urgent stock.
  const ranked = [...ctx.inventory]
    .map((item) => ({ item, days: daysToDepletion(item) }))
    .sort((a, b) => a.days - b.days);

  let budgetUsedCents = 0;

  for (const { item, days } of ranked) {
    const product = ctx.products.get(item.productId);
    if (!product) {
      skipped.push({ productId: item.productId, reason: "Product not in this cycle's supplier catalog." });
      continue;
    }

    if (
      ctx.policy.allowedCategories.length > 0 &&
      !ctx.policy.allowedCategories.includes(product.category)
    ) {
      skipped.push({
        productId: item.productId,
        reason: `Category "${product.category}" is outside the agent's mandate.`,
      });
      step(
        `Skip ${product.name}`,
        `Category "${product.category}" is not on the allowed list, so this one stays a human decision.`,
      );
      continue;
    }

    const coverNeededDays = daysUntilDelivery + item.safetyDays;
    if (days > coverNeededDays) {
      skipped.push({
        productId: item.productId,
        reason: `${days.toFixed(1)} days of cover, more than the ${coverNeededDays.toFixed(1)} days needed. Not due this cycle.`,
      });
      continue;
    }

    // Stock left when the truck actually arrives.
    const dailyUse = item.avgWeeklyCases / 7;
    const projectedAtDelivery = Math.max(0, item.onHandCases - dailyUse * daysUntilDelivery);
    const alreadyCommitted = ctx.existingCommitments.get(item.productId) ?? 0;
    const gap = item.parCases - projectedAtDelivery - alreadyCommitted;

    if (gap <= 0) {
      skipped.push({
        productId: item.productId,
        reason: alreadyCommitted > 0
          ? `${alreadyCommitted} case(s) already committed this cycle covers the gap.`
          : "Projected stock at delivery already meets par.",
      });
      continue;
    }

    const cases = Math.ceil(gap);

    // Price at the pooled quantity: the member's own cases plus the rest of
    // the zone's demand. This is the number that makes pooling worth joining.
    const pooledCases = (ctx.zoneDemand.get(item.productId) ?? 0) + cases;
    const estUnitCents = unitPriceFor(product, pooledCases);
    const soloUnitCents = unitPriceFor(product, cases);
    const estTotalCents = estUnitCents * cases;

    if (
      ctx.policy.cycleBudgetCents > 0 &&
      budgetUsedCents + estTotalCents > ctx.policy.cycleBudgetCents
    ) {
      const remaining = ctx.policy.cycleBudgetCents - budgetUsedCents;
      skipped.push({
        productId: item.productId,
        reason: `Would need $${(estTotalCents / 100).toFixed(2)} with $${(remaining / 100).toFixed(2)} of cycle budget left.`,
      });
      step(
        `Hold ${product.name}`,
        `Needs ${cases} case(s) at about $${(estTotalCents / 100).toFixed(2)}, but only $${(remaining / 100).toFixed(2)} of the cycle budget remains. Flagging for manual review instead of exceeding the ceiling.`,
      );
      continue;
    }

    budgetUsedCents += estTotalCents;
    const autoApprove =
      ctx.policy.autoApproveUnderCents > 0 &&
      estTotalCents <= ctx.policy.autoApproveUnderCents;

    const savingsNote =
      soloUnitCents > estUnitCents
        ? ` Pooled zone demand of ${pooledCases} cases prices at $${(estUnitCents / 100).toFixed(2)}/case against $${(soloUnitCents / 100).toFixed(2)} buying ${cases} alone.`
        : ` No volume break reached yet at ${pooledCases} pooled cases; priced at $${(estUnitCents / 100).toFixed(2)}/case.`;

    const reason =
      `${item.onHandCases} case(s) on hand burning ${item.avgWeeklyCases}/week runs out in ${days.toFixed(1)} days. ` +
      `Projected ${projectedAtDelivery.toFixed(1)} case(s) left at delivery against a par of ${item.parCases}. ` +
      `Ordering ${cases} case(s).${savingsNote}`;

    proposals.push({
      productId: item.productId,
      cases,
      estUnitCents,
      estTotalCents,
      daysToDepletion: Number.isFinite(days) ? Math.round(days * 100) / 100 : 9999,
      reason,
      autoApprove,
    });

    step(
      `Propose ${cases} case(s) of ${product.name}`,
      reason + (autoApprove
        ? " Inside the auto-approval limit, so the agent commits it."
        : " Above the auto-approval limit, so it waits for the owner."),
    );
  }

  if (proposals.length === 0) {
    step(
      "No action needed",
      "Nothing crosses its reorder point before the next delivery window.",
    );
  } else {
    step(
      "Summarise",
      `${proposals.length} proposal(s) worth about $${(budgetUsedCents / 100).toFixed(2)}. ` +
        `${proposals.filter((p) => p.autoApprove).length} auto-approved, ` +
        `${proposals.filter((p) => !p.autoApprove).length} awaiting approval.`,
    );
  }

  return { proposals, steps, estTotalCents: budgetUsedCents, skipped };
}
