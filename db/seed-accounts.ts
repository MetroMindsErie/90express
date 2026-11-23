/**
 * Accounts and the member agreement.
 *
 * Run after `npm run seed`. Creates one operator and a member account for
 * every seeded business, plus the first terms version.
 *
 * Development only. It refuses to run against NODE_ENV=production, because it
 * sets a known password on every account.
 */
import "dotenv/config";
import postgres from "postgres";

import { hashPassword } from "../src/lib/auth/crypto";

if (process.env.NODE_ENV === "production") {
  console.error("Refusing to seed accounts in production.");
  process.exit(1);
}

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://localhost:5432/ninety_express",
  { max: 4 },
);

/** Known, documented, development-only. Never a production credential. */
const DEV_PASSWORD = process.env.SEED_PASSWORD ?? "corridor-pilot-2026";

const TERMS = {
  version: "2026.1",
  effectiveFrom: "2026-11-01",
  summary:
    "What a commitment binds you to, what happens when a pool misses its minimum, how freight is divided, and what 90 Express charges.",
  body: [
    {
      heading: "90 Express does not sell you goods",
      text: "90 Express aggregates demand and coordinates delivery. You contract with the supplier and pay the supplier directly; title to the goods passes from them to you and never to 90 Express. 90 Express is your purchasing and freight coordinator, not your distributor.",
    },
    {
      heading: "A commitment binds once the window closes",
      text: "You may add, change or remove your line at any time while a cycle is open. At the close of the window your committed quantity is what the supplier is quoted on, and it becomes binding. Withdrawing after close requires the agreement of the other members on the cycle, because their price depends on your volume.",
    },
    {
      heading: "If a pool misses its minimum, it fails and nothing is owed",
      text: "A supplier releases a collective order only above its stated minimum. If the zone does not reach it before the window closes, the cycle fails, every commitment on it is released, and no member owes anything for that cycle. You are told the shortfall while the window is still open.",
    },
    {
      heading: "Freight is divided by trailer space, and capped at your own cost",
      text: "The carrier's linehaul is divided by each member's share of pallet positions; stop charges are split evenly; a liftgate is charged only to the stop that needs one. No member is ever billed more than that member's own LTL cost for the same shipment. Where no split can keep every member whole, the load is not tendered as one.",
    },
    {
      heading: "We charge a share of what we save you",
      text: "90 Express takes an agreed share of verified savings on each cycle, measured against what the same order would have cost you buying and shipping it alone. The fee is capped at the savings delivered: if a cycle saves you nothing, you owe no coordination fee on it. Membership is billed separately and is not contingent on savings.",
    },
    {
      heading: "Savings figures are stated with their basis",
      text: "Every savings figure names what it is measured against. Where a carrier has rated your shipment, the comparison uses that quote. Where none has, it uses a published benchmark rate and is labelled an estimate. We will not present an estimate as a quotation.",
    },
    {
      heading: "Autonomous ordering acts only inside limits you set",
      text: "If you enable the procurement agent, it may commit orders only within the per-cycle budget, per-order approval limit and product categories you configure. Every action it takes is recorded with the reasoning behind it and is visible to you. You can disable it at any time; doing so does not release commitments already made.",
    },
    {
      heading: "What suppliers and carriers are told about you",
      text: "Suppliers receive your order and the information needed to invoice you. Carriers receive an opaque reference, delivery coordinates and your receiving constraints — not your name, your volumes or your pricing. Your purchasing data is not sold, and is not shared with other members except as aggregate zone volume.",
    },
    {
      heading: "Either side can leave",
      text: "You may end your membership with 30 days' notice, effective after any cycle you are already committed to has settled. 90 Express may end a membership with the same notice. Settled cycles, invoices and acceptance records are retained as business records.",
    },
  ],
};

async function main() {
  console.log("Seeding accounts and terms...");

  await sql`delete from sessions`;
  await sql`delete from terms_acceptances`;
  await sql`delete from users`;
  await sql`delete from terms_versions`;

  const hash = await hashPassword(DEV_PASSWORD);

  const [terms] = await sql<Array<{ id: string }>>`
    insert into terms_versions (version, effective_from, summary, body)
    values (${TERMS.version}, ${TERMS.effectiveFrom}, ${TERMS.summary},
            ${sql.json(TERMS.body as never)})
    returning id
  `;
  console.log(`  terms version ${TERMS.version} with ${TERMS.body.length} clauses`);

  await sql`
    insert into users (email, password_hash, role, display_name)
    values ('operator@90express.test', ${hash}, 'operator', 'Jordan Easter')
  `;
  console.log("  operator: operator@90express.test");

  const businesses = await sql<
    Array<{ id: string; contact_email: string; contact_name: string; name: string }>
  >`
    select id, contact_email, contact_name, coalesce(dba, legal_name) as name
    from businesses order by joined_at
  `;

  for (const b of businesses) {
    await sql`
      insert into users (email, password_hash, role, business_id, display_name)
      values (${b.contact_email}, ${hash}, 'member', ${b.id}, ${b.contact_name})
      on conflict do nothing
    `;
    // Seeded members are already trading, so they have accepted the agreement.
    await sql`
      insert into terms_acceptances (business_id, terms_version_id, accepted_by_name)
      values (${b.id}, ${terms.id}, ${b.contact_name})
      on conflict do nothing
    `;
  }

  console.log(`  ${businesses.length} member accounts, all with the agreement accepted`);
  console.log(`\nSign in with any of:`);
  console.log(`  operator@90express.test  (operator — sees the whole network)`);
  console.log(`  ${businesses[0]?.contact_email}  (member — ${businesses[0]?.name})`);
  console.log(`  password: ${DEV_PASSWORD}`);
  console.log(`\nDevelopment only. Do not use this seed against a real deployment.`);

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
