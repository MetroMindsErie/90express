/**
 * Register integration providers against the seeded suppliers and carriers.
 *
 * Run after `npm run seed`. Idempotent: re-running updates the rows in place
 * rather than duplicating providers.
 *
 * The three adapter kinds are all represented on purpose, because a real
 * corridor will have all three: a distributor with an API, one that emails a
 * spreadsheet, and one that still wants a phone call.
 */
import "dotenv/config";
import postgres from "postgres";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://localhost:5432/ninety_express",
  { max: 4 },
);

const MOCK_BASE = process.env.MOCK_PARTNERS_URL ?? "http://localhost:4010";

type SupplierProvider = {
  supplierName: string;
  name: string;
  partnerRef: string;
  adapter: "http" | "csv" | "manual";
  baseUrl?: string;
  authEnvVar?: string;
  sourcePath?: string;
  intervalMinutes?: number | null;
};

const SUPPLIER_PROVIDERS: SupplierProvider[] = [
  {
    supplierName: "Piedmont Broadline Foods",
    name: "Piedmont Broadline — order API",
    partnerRef: "piedmont",
    adapter: "http",
    baseUrl: MOCK_BASE,
    authEnvVar: "MOCK_PARTNER_TOKEN",
    intervalMinutes: 720,
  },
  {
    // The common case: a distributor that emails a spreadsheet every Monday.
    supplierName: "Catawba Paper & Packaging",
    name: "Catawba Paper — weekly price sheet",
    partnerRef: "catawba",
    adapter: "csv",
    sourcePath: "db/fixtures/catawba-price-sheet.csv",
    intervalMinutes: 10_080,
  },
  {
    supplierName: "Yadkin Valley Produce Co.",
    name: "Yadkin Valley — grower API",
    partnerRef: "yadkin",
    adapter: "http",
    baseUrl: MOCK_BASE,
    authEnvVar: "MOCK_PARTNER_TOKEN",
    intervalMinutes: 1_440,
  },
];

type CarrierProvider = {
  carrierName: string;
  name: string;
  partnerRef: string;
  adapter: "http" | "manual";
  baseUrl?: string;
  authEnvVar?: string;
  intervalMinutes?: number | null;
};

const CARRIER_PROVIDERS: CarrierProvider[] = [
  {
    carrierName: "Iredell Freight Lines",
    name: "Iredell Freight — TMS",
    partnerRef: "iredell",
    adapter: "http",
    baseUrl: MOCK_BASE,
    authEnvVar: "MOCK_PARTNER_TOKEN",
    intervalMinutes: 60,
  },
  {
    carrierName: "Catawba Cold Carriers",
    name: "Catawba Cold — TMS",
    partnerRef: "catawbacold",
    adapter: "http",
    baseUrl: MOCK_BASE,
    authEnvVar: "MOCK_PARTNER_TOKEN",
    intervalMinutes: 60,
  },
  {
    // No API. Still a provider, so a stale rate card is visible next to the
    // carriers that do have one instead of being an invisible gap.
    carrierName: "Queen City Drayage",
    name: "Queen City — phone and email",
    partnerRef: "queencity",
    adapter: "manual",
    intervalMinutes: null,
  },
];

async function main() {
  console.log("Registering integration providers...");

  for (const p of SUPPLIER_PROVIDERS) {
    const [supplier] = await sql<Array<{ id: string }>>`
      select id from suppliers where name = ${p.supplierName}
    `;
    if (!supplier) {
      console.log(`  ! supplier "${p.supplierName}" not found, skipping`);
      continue;
    }
    await sql`
      insert into integration_providers
        (partner, supplier_id, name, adapter, partner_ref, base_url, auth_env_var,
         source_path, sync_interval_minutes)
      values ('supplier', ${supplier.id}, ${p.name}, ${p.adapter}, ${p.partnerRef},
              ${p.baseUrl ?? null}, ${p.authEnvVar ?? null}, ${p.sourcePath ?? null},
              ${p.intervalMinutes ?? null})
      on conflict do nothing
    `;
    console.log(`  supplier: ${p.name} [${p.adapter}]`);
  }

  for (const p of CARRIER_PROVIDERS) {
    const [carrier] = await sql<Array<{ id: string }>>`
      select id from carriers where name = ${p.carrierName}
    `;
    if (!carrier) {
      console.log(`  ! carrier "${p.carrierName}" not found, skipping`);
      continue;
    }
    await sql`
      insert into integration_providers
        (partner, carrier_id, name, adapter, partner_ref, base_url, auth_env_var,
         sync_interval_minutes)
      values ('carrier', ${carrier.id}, ${p.name}, ${p.adapter}, ${p.partnerRef},
              ${p.baseUrl ?? null}, ${p.authEnvVar ?? null}, ${p.intervalMinutes ?? null})
      on conflict do nothing
    `;
    console.log(`  carrier:  ${p.name} [${p.adapter}]`);
  }

  const [{ count }] = await sql<Array<{ count: number }>>`
    select count(*)::int as count from integration_providers
  `;
  console.log(`\n${count} providers registered.`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
