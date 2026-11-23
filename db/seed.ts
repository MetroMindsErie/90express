/**
 * Seed the I-77 pilot corridor.
 *
 * Every business, supplier and carrier here is fictional. Prices and volume
 * ladders are plausible food-service figures used to exercise the engine, not
 * quotes from any real distributor.
 *
 * Shipments and settlements are computed by the real engine in src/lib/crs
 * rather than hand-written, so the seeded history is internally consistent
 * with what the app will produce for a live cycle.
 */
import "dotenv/config";
import postgres from "postgres";

import { planLoad, type Carrier } from "../src/lib/crs/freight";
import { planReplenishment } from "../src/lib/crs/agent";
import { buildPoolLines, type Product } from "../src/lib/crs/pricing";
import { screenParticipants, settleCycle } from "../src/lib/crs/settlement";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgres://localhost:5432/ninety_express",
  { max: 4 },
);

const DAY = 86_400_000;
const today = new Date();
today.setHours(12, 0, 0, 0);
const days = (n: number) => new Date(today.getTime() + n * DAY);
const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const ZONES = [
  {
    code: "I77-LKN",
    name: "Lake Norman / Mooresville",
    center_lat: 35.5849,
    center_lng: -80.8101,
    radius_miles: 15,
    delivery_dow: 2,
    active: true,
  },
  {
    code: "I77-STATESVILLE",
    name: "Statesville",
    center_lat: 35.7826,
    center_lng: -80.8873,
    radius_miles: 18,
    delivery_dow: 3,
    active: true,
  },
  {
    code: "I77-NORTHMECK",
    name: "Huntersville / Cornelius / Davidson",
    center_lat: 35.45,
    center_lng: -80.85,
    radius_miles: 12,
    delivery_dow: 2,
    active: true,
  },
  {
    code: "I77-CLTNORTH",
    name: "North Charlotte",
    center_lat: 35.29,
    center_lng: -80.85,
    radius_miles: 12,
    delivery_dow: 4,
    active: true,
  },
  {
    code: "I77-ROCKHILL",
    name: "Rock Hill (planned)",
    center_lat: 34.9249,
    center_lng: -81.0251,
    radius_miles: 15,
    delivery_dow: 5,
    active: false,
  },
];

const SUPPLIERS = [
  {
    key: "piedmont",
    name: "Piedmont Broadline Foods",
    origin_city: "Charlotte",
    origin_state: "NC",
    origin_lat: 35.205,
    origin_lng: -80.88,
    lead_time_days: 3,
    min_order_cents: 750_000,
    invoices_members_separately: true,
    terms: "Net 15",
  },
  {
    key: "catawba",
    name: "Catawba Paper & Packaging",
    origin_city: "Concord",
    origin_state: "NC",
    origin_lat: 35.4088,
    origin_lng: -80.5795,
    lead_time_days: 2,
    min_order_cents: 450_000,
    invoices_members_separately: true,
    terms: "Net 30",
  },
  {
    key: "yadkin",
    name: "Yadkin Valley Produce Co.",
    origin_city: "Statesville",
    origin_state: "NC",
    origin_lat: 35.77,
    origin_lng: -80.9,
    lead_time_days: 1,
    min_order_cents: 250_000,
    invoices_members_separately: true,
    terms: "Net 7",
  },
];

type SeedProduct = {
  supplier: string;
  sku: string;
  name: string;
  category: string;
  pack_description: string;
  cases_per_pallet: number;
  case_weight_lb: number;
  list_price_cents: number;
  temp_class: "dry" | "chill" | "frozen";
  tiers: Array<[number, number]>;
};

const PRODUCTS: SeedProduct[] = [
  // --- Piedmont Broadline Foods ---
  { supplier: "piedmont", sku: "OIL-35", name: "Fryer Oil, 35 lb", category: "oils_fats", pack_description: "1/35 lb jug", cases_per_pallet: 48, case_weight_lb: 36, list_price_cents: 3000, temp_class: "dry", tiers: [[50, 2850], [250, 2600], [1000, 2400]] },
  { supplier: "piedmont", sku: "FLR-50", name: "All-Purpose Flour, 50 lb", category: "dry_goods", pack_description: "1/50 lb bag", cases_per_pallet: 40, case_weight_lb: 50, list_price_cents: 2200, temp_class: "dry", tiers: [[40, 2080], [200, 1900], [800, 1750]] },
  { supplier: "piedmont", sku: "RIC-25", name: "Long Grain Rice, 25 lb", category: "dry_goods", pack_description: "1/25 lb bag", cases_per_pallet: 56, case_weight_lb: 25, list_price_cents: 1950, temp_class: "dry", tiers: [[50, 1850], [250, 1700], [900, 1580]] },
  { supplier: "piedmont", sku: "SAU-TOM", name: "Tomato Sauce, #10", category: "dry_goods", pack_description: "6/#10 cans", cases_per_pallet: 72, case_weight_lb: 38, list_price_cents: 2750, temp_class: "dry", tiers: [[50, 2600], [250, 2400], [1000, 2240]] },
  { supplier: "piedmont", sku: "CHK-40", name: "Breaded Chicken Tenders", category: "protein", pack_description: "4/10 lb", cases_per_pallet: 45, case_weight_lb: 42, list_price_cents: 8900, temp_class: "frozen", tiers: [[30, 8500], [150, 8050], [600, 7600]] },
  { supplier: "piedmont", sku: "BEF-80", name: "Ground Beef 80/20", category: "protein", pack_description: "4/10 lb chub", cases_per_pallet: 50, case_weight_lb: 42, list_price_cents: 12400, temp_class: "chill", tiers: [[25, 11900], [120, 11200], [500, 10600]] },
  { supplier: "piedmont", sku: "CHS-SHRD", name: "Shredded Mozzarella", category: "dairy", pack_description: "4/5 lb", cases_per_pallet: 60, case_weight_lb: 21, list_price_cents: 6400, temp_class: "chill", tiers: [[40, 6150], [200, 5800], [700, 5500]] },

  // --- Catawba Paper & Packaging ---
  { supplier: "catawba", sku: "CUP-16", name: "16 oz Cold Cups", category: "disposables", pack_description: "20/50 ct", cases_per_pallet: 36, case_weight_lb: 22, list_price_cents: 5400, temp_class: "dry", tiers: [[40, 5100], [200, 4750], [800, 4500]] },
  { supplier: "catawba", sku: "LID-16", name: "16 oz Cup Lids", category: "disposables", pack_description: "20/50 ct", cases_per_pallet: 40, case_weight_lb: 14, list_price_cents: 2900, temp_class: "dry", tiers: [[40, 2750], [200, 2550], [800, 2400]] },
  { supplier: "catawba", sku: "CTN-9", name: '9" Hinged Clamshell', category: "disposables", pack_description: "200 ct", cases_per_pallet: 32, case_weight_lb: 18, list_price_cents: 4600, temp_class: "dry", tiers: [[30, 4350], [150, 4050], [600, 3800]] },
  { supplier: "catawba", sku: "BAG-TO", name: "To-Go Bags, Kraft", category: "disposables", pack_description: "500 ct", cases_per_pallet: 44, case_weight_lb: 24, list_price_cents: 3300, temp_class: "dry", tiers: [[40, 3120], [200, 2900], [800, 2720]] },
  { supplier: "catawba", sku: "NAP-DIN", name: "Dinner Napkins", category: "paper", pack_description: "6/1000 ct", cases_per_pallet: 42, case_weight_lb: 26, list_price_cents: 3850, temp_class: "dry", tiers: [[40, 3650], [200, 3400], [800, 3200]] },
  { supplier: "catawba", sku: "TWL-ROLL", name: "Roll Towels", category: "paper", pack_description: "12/700 ft", cases_per_pallet: 36, case_weight_lb: 31, list_price_cents: 4200, temp_class: "dry", tiers: [[40, 3980], [200, 3700], [800, 3480]] },
  { supplier: "catawba", sku: "GLV-NIT", name: "Nitrile Gloves, Powder-Free", category: "sanitation", pack_description: "10/100 ct", cases_per_pallet: 48, case_weight_lb: 12, list_price_cents: 7200, temp_class: "dry", tiers: [[25, 6900], [120, 6400], [500, 6000]] },
  { supplier: "catawba", sku: "SAN-QT", name: "Quat Sanitizer Concentrate", category: "sanitation", pack_description: "4/1 gal", cases_per_pallet: 60, case_weight_lb: 34, list_price_cents: 4900, temp_class: "dry", tiers: [[25, 4700], [120, 4400], [500, 4150]] },

  // --- Yadkin Valley Produce Co. ---
  { supplier: "yadkin", sku: "PRD-ONI", name: "Yellow Onions, 50 lb", category: "produce", pack_description: "1/50 lb sack", cases_per_pallet: 45, case_weight_lb: 50, list_price_cents: 2650, temp_class: "dry", tiers: [[30, 2500], [150, 2300], [600, 2150]] },
  { supplier: "yadkin", sku: "PRD-POT", name: "Russet Potatoes, 50 lb", category: "produce", pack_description: "1/50 lb sack", cases_per_pallet: 45, case_weight_lb: 50, list_price_cents: 2380, temp_class: "dry", tiers: [[30, 2250], [150, 2080], [600, 1950]] },
  { supplier: "yadkin", sku: "PRD-LET", name: "Iceberg Lettuce", category: "produce", pack_description: "24 ct", cases_per_pallet: 40, case_weight_lb: 42, list_price_cents: 3450, temp_class: "chill", tiers: [[25, 3280], [120, 3050], [500, 2880]] },
  { supplier: "yadkin", sku: "PRD-TOM", name: "Roma Tomatoes, 25 lb", category: "produce", pack_description: "1/25 lb", cases_per_pallet: 50, case_weight_lb: 25, list_price_cents: 2890, temp_class: "chill", tiers: [[25, 2750], [120, 2560], [500, 2400]] },
];

const CARRIERS = [
  { key: "iredell", name: "Iredell Freight Lines", mc_number: "MC-884213", equipment: "dry_van", capacity_pallets: 26, max_weight_lb: 45000, linehaul_rate_cents: 289, min_charge_cents: 45000, stop_charge_cents: 7500, liftgate_fee_cents: 4500 },
  { key: "catawbacold", name: "Catawba Cold Carriers", mc_number: "MC-771904", equipment: "reefer", capacity_pallets: 24, max_weight_lb: 42000, linehaul_rate_cents: 352, min_charge_cents: 58000, stop_charge_cents: 8500, liftgate_fee_cents: 5000 },
  { key: "queencity", name: "Queen City Drayage", mc_number: "MC-690552", equipment: "dry_van", capacity_pallets: 26, max_weight_lb: 45000, linehaul_rate_cents: 275, min_charge_cents: 42000, stop_charge_cents: 7000, liftgate_fee_cents: 4000 },
];

type SeedBusiness = {
  key: string;
  zone: string;
  legal_name: string;
  dba: string;
  segment: string;
  contact_name: string;
  contact_email: string;
  phone: string;
  street: string;
  city: string;
  state: string;
  postal_code: string;
  lat: number;
  lng: number;
  dock_type: "dock" | "liftgate" | "ground";
  membership_tier: "starter" | "standard" | "premium";
};

const BUSINESSES: SeedBusiness[] = [
  { key: "brawley", zone: "I77-LKN", legal_name: "Brawley Street Kitchen LLC", dba: "Brawley Street Kitchen", segment: "full_service_restaurant", contact_name: "Dana Whitfield", contact_email: "dana@brawleystreetkitchen.test", phone: "704-555-0118", street: "214 N Brawley Ave", city: "Mooresville", state: "NC", postal_code: "28115", lat: 35.5862, lng: -80.8135, dock_type: "liftgate", membership_tier: "premium" },
  { key: "pitrow", zone: "I77-LKN", legal_name: "Pit Row Barbecue LLC", dba: "Pit Row BBQ", segment: "bbq", contact_name: "Marcus Ellery", contact_email: "marcus@pitrowbbq.test", phone: "704-555-0142", street: "1890 Rinehardt Rd", city: "Mooresville", state: "NC", postal_code: "28115", lat: 35.5731, lng: -80.8402, dock_type: "ground", membership_tier: "standard" },
  { key: "fairview", zone: "I77-LKN", legal_name: "Fairview Diner Inc.", dba: "Fairview Diner", segment: "diner", contact_name: "Rosa Lindqvist", contact_email: "rosa@fairviewdiner.test", phone: "704-555-0177", street: "655 Fairview Rd", city: "Mooresville", state: "NC", postal_code: "28117", lat: 35.5984, lng: -80.8549, dock_type: "ground", membership_tier: "starter" },
  { key: "pizzaworks", zone: "I77-LKN", legal_name: "Mooresville Pizza Works LLC", dba: "Mooresville Pizza Works", segment: "pizzeria", contact_name: "Tony Abara", contact_email: "tony@mvpizzaworks.test", phone: "704-555-0193", street: "132 Oak Ridge Farm Hwy", city: "Mooresville", state: "NC", postal_code: "28115", lat: 35.5608, lng: -80.8217, dock_type: "dock", membership_tier: "standard" },
  { key: "catawbacater", zone: "I77-LKN", legal_name: "Catawba Catering Co. LLC", dba: "Catawba Catering Co.", segment: "caterer", contact_name: "Priya Raghunathan", contact_email: "priya@catawbacatering.test", phone: "704-555-0206", street: "118 S Main St", city: "Troutman", state: "NC", postal_code: "28166", lat: 35.7013, lng: -80.8871, dock_type: "liftgate", membership_tier: "premium" },

  { key: "signalhill", zone: "I77-STATESVILLE", legal_name: "Signal Hill Grill LLC", dba: "Signal Hill Grill", segment: "full_service_restaurant", contact_name: "Beth Carrow", contact_email: "beth@signalhillgrill.test", phone: "704-555-0231", street: "1522 E Broad St", city: "Statesville", state: "NC", postal_code: "28625", lat: 35.7891, lng: -80.8559, dock_type: "dock", membership_tier: "premium" },
  { key: "depotcafe", zone: "I77-STATESVILLE", legal_name: "Depot Street Cafe LLC", dba: "Depot Street Cafe", segment: "cafe", contact_name: "Ollie Brandt", contact_email: "ollie@depotstreetcafe.test", phone: "704-555-0248", street: "207 Depot St", city: "Statesville", state: "NC", postal_code: "28677", lat: 35.7819, lng: -80.8871, dock_type: "ground", membership_tier: "starter" },
  { key: "winghouse", zone: "I77-STATESVILLE", legal_name: "Iredell Wing House LLC", dba: "Iredell Wing House", segment: "quick_service", contact_name: "Shawn Devoe", contact_email: "shawn@iredellwinghouse.test", phone: "704-555-0259", street: "1944 Turnersburg Hwy", city: "Statesville", state: "NC", postal_code: "28625", lat: 35.8201, lng: -80.8743, dock_type: "liftgate", membership_tier: "standard" },

  { key: "birkdale", zone: "I77-NORTHMECK", legal_name: "Birkdale Bistro LLC", dba: "Birkdale Bistro", segment: "full_service_restaurant", contact_name: "Claire Nwosu", contact_email: "claire@birkdalebistro.test", phone: "704-555-0264", street: "8850 Townley Rd", city: "Huntersville", state: "NC", postal_code: "28078", lat: 35.4139, lng: -80.8691, dock_type: "liftgate", membership_tier: "premium" },
  { key: "fishcamp", zone: "I77-NORTHMECK", legal_name: "Cornelius Fish Camp Inc.", dba: "Cornelius Fish Camp", segment: "seafood", contact_name: "Hal Prentiss", contact_email: "hal@corneliusfishcamp.test", phone: "704-555-0271", street: "20500 Catawba Ave", city: "Cornelius", state: "NC", postal_code: "28031", lat: 35.4872, lng: -80.8713, dock_type: "dock", membership_tier: "standard" },
  { key: "bagelbar", zone: "I77-NORTHMECK", legal_name: "Davidson Bagel Bar LLC", dba: "Davidson Bagel Bar", segment: "cafe", contact_name: "Nina Okafor", contact_email: "nina@davidsonbagelbar.test", phone: "704-555-0288", street: "435 S Main St", city: "Davidson", state: "NC", postal_code: "28036", lat: 35.4961, lng: -80.8479, dock_type: "ground", membership_tier: "starter" },
  { key: "tacoshop", zone: "I77-NORTHMECK", legal_name: "Huntersville Taco Shop LLC", dba: "Huntersville Taco Shop", segment: "quick_service", contact_name: "Esteban Ruiz", contact_email: "esteban@hvtacoshop.test", phone: "704-555-0295", street: "16405 Statesville Rd", city: "Huntersville", state: "NC", postal_code: "28078", lat: 35.4015, lng: -80.8605, dock_type: "liftgate", membership_tier: "standard" },

  { key: "noodlebar", zone: "I77-CLTNORTH", legal_name: "NoDa Noodle Bar LLC", dba: "NoDa Noodle Bar", segment: "full_service_restaurant", contact_name: "Mei Tran", contact_email: "mei@nodanoodlebar.test", phone: "704-555-0303", street: "3116 N Davidson St", city: "Charlotte", state: "NC", postal_code: "28205", lat: 35.2491, lng: -80.8045, dock_type: "ground", membership_tier: "standard" },
  { key: "soulkitchen", zone: "I77-CLTNORTH", legal_name: "Sugar Creek Soul Kitchen LLC", dba: "Sugar Creek Soul Kitchen", segment: "quick_service", contact_name: "Andre Latimer", contact_email: "andre@sugarcreeksoul.test", phone: "704-555-0314", street: "4420 Sugar Creek Rd", city: "Charlotte", state: "NC", postal_code: "28269", lat: 35.2913, lng: -80.8098, dock_type: "liftgate", membership_tier: "premium" },
];

const MEMBERSHIP_PLANS = [
  { tier: "starter", monthly_cents: 4900, agent_addon_cents: 7900, description: "One zone, collective ordering, consolidated delivery. Manual ordering only." },
  { tier: "standard", monthly_cents: 9900, agent_addon_cents: 9900, description: "All corridor zones, priority allocation when a pool oversubscribes, freight tracking." },
  { tier: "premium", monthly_cents: 19900, agent_addon_cents: 0, description: "Everything in Standard plus autonomous replenishment, multi-supplier pooling and settlement export." },
];

// ---------------------------------------------------------------------------

async function main() {
  console.log("Resetting seeded tables...");
  await sql`
    truncate
      agent_steps, agent_proposals, agent_runs, agent_policies,
      inventory_items, settlements, tracking_events, shipment_stops,
      shipments, negotiated_prices, commitments, pool_cycles,
      price_tiers, products, carriers, suppliers, businesses, zones,
      membership_plans
    restart identity cascade
  `;

  // --- zones ---
  const zoneId = new Map<string, string>();
  for (const z of ZONES) {
    const [row] = await sql<Array<{ id: string }>>`
      insert into zones (code, name, center_lat, center_lng, radius_miles, delivery_dow, active)
      values (${z.code}, ${z.name}, ${z.center_lat}, ${z.center_lng}, ${z.radius_miles},
              ${z.delivery_dow}, ${z.active})
      returning id
    `;
    zoneId.set(z.code, row.id);
  }
  console.log(`  ${zoneId.size} zones`);

  // --- membership plans ---
  for (const p of MEMBERSHIP_PLANS) {
    await sql`
      insert into membership_plans (tier, monthly_cents, agent_addon_cents, description)
      values (${p.tier}, ${p.monthly_cents}, ${p.agent_addon_cents}, ${p.description})
    `;
  }

  // --- suppliers ---
  const supplierId = new Map<string, string>();
  for (const s of SUPPLIERS) {
    const [row] = await sql`
      insert into suppliers (name, origin_city, origin_state, origin_lat, origin_lng,
                             lead_time_days, min_order_cents, invoices_members_separately, terms)
      values (${s.name}, ${s.origin_city}, ${s.origin_state}, ${s.origin_lat}, ${s.origin_lng},
              ${s.lead_time_days}, ${s.min_order_cents}, ${s.invoices_members_separately}, ${s.terms})
      returning id
    `;
    supplierId.set(s.key, row.id as string);
  }
  console.log(`  ${supplierId.size} suppliers`);

  // --- products + tiers ---
  const productId = new Map<string, string>();
  const engineProducts = new Map<string, Product>();
  for (const p of PRODUCTS) {
    const [row] = await sql`
      insert into products (supplier_id, sku, name, category, pack_description,
                            cases_per_pallet, case_weight_lb, list_price_cents, temp_class)
      values (${supplierId.get(p.supplier)!}, ${p.sku}, ${p.name}, ${p.category}, ${p.pack_description},
              ${p.cases_per_pallet}, ${p.case_weight_lb}, ${p.list_price_cents}, ${p.temp_class})
      returning id
    `;
    const id = row.id as string;
    productId.set(p.sku, id);
    for (const [minCases, unit] of p.tiers) {
      await sql`
        insert into price_tiers (product_id, min_cases, unit_price_cents)
        values (${id}, ${minCases}, ${unit})
      `;
    }
    engineProducts.set(p.sku, {
      id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      packDescription: p.pack_description,
      casesPerPallet: p.cases_per_pallet,
      caseWeightLb: p.case_weight_lb,
      listPriceCents: p.list_price_cents,
      tiers: p.tiers.map(([minCases, unitPriceCents]) => ({ minCases, unitPriceCents })),
    });
  }
  console.log(`  ${productId.size} products`);

  // --- carriers ---
  const carrierId = new Map<string, string>();
  const engineCarriers = new Map<string, Carrier>();
  for (const c of CARRIERS) {
    const [row] = await sql`
      insert into carriers (name, mc_number, equipment, capacity_pallets, max_weight_lb,
                            linehaul_rate_cents, min_charge_cents, stop_charge_cents, liftgate_fee_cents)
      values (${c.name}, ${c.mc_number}, ${c.equipment}, ${c.capacity_pallets}, ${c.max_weight_lb},
              ${c.linehaul_rate_cents}, ${c.min_charge_cents}, ${c.stop_charge_cents}, ${c.liftgate_fee_cents})
      returning id
    `;
    carrierId.set(c.key, row.id as string);
    engineCarriers.set(c.key, {
      id: row.id as string,
      name: c.name,
      equipment: c.equipment,
      capacityPallets: c.capacity_pallets,
      maxWeightLb: c.max_weight_lb,
      linehaulRateCents: c.linehaul_rate_cents,
      minChargeCents: c.min_charge_cents,
      stopChargeCents: c.stop_charge_cents,
      liftgateFeeCents: c.liftgate_fee_cents,
    });
  }

  // --- businesses ---
  const businessId = new Map<string, string>();
  const businessMeta = new Map<string, SeedBusiness>();
  // Deterministic join dates: the first entry is the earliest member, which is
  // the one the app opens on when no business has been chosen.
  for (const [index, b] of BUSINESSES.entries()) {
    const [row] = await sql`
      insert into businesses (zone_id, legal_name, dba, segment, contact_name, contact_email,
                              phone, street, city, state, postal_code, lat, lng,
                              dock_type, membership_tier, joined_at)
      values (${zoneId.get(b.zone)!}, ${b.legal_name}, ${b.dba}, ${b.segment}, ${b.contact_name},
              ${b.contact_email}, ${b.phone}, ${b.street}, ${b.city}, ${b.state}, ${b.postal_code},
              ${b.lat}, ${b.lng}, ${b.dock_type}, ${b.membership_tier}, ${days(-240 + index * 11)})
      returning id
    `;
    businessId.set(b.key, row.id as string);
    businessMeta.set(b.key, b);
  }
  console.log(`  ${businessId.size} businesses`);

  // -------------------------------------------------------------------------
  // Pool cycles
  // -------------------------------------------------------------------------
  type CycleSpec = {
    key: string;
    zone: string;
    supplier: string;
    name: string;
    status: string;
    opens: Date;
    closes: Date;
    delivery: Date;
    minOrder: number;
    feeModel: "spend_bps" | "savings_share";
    feeBps: number;
    freightFee: number;
    savingsShareBps: number;
    carrier?: string;
    notes?: string;
    commitments: Array<{ business: string; sku: string; cases: number; approved?: boolean; source?: "manual" | "agent" }>;
  };

  const CYCLES: CycleSpec[] = [
    {
      key: "lkn-paper-open",
      zone: "I77-LKN",
      supplier: "catawba",
      name: "Lake Norman — Paper & Disposables",
      status: "open",
      opens: days(-4),
      closes: days(3),
      delivery: days(6),
      minOrder: 450_000,
      feeModel: "savings_share",
      feeBps: 250,
      freightFee: 2500,
      savingsShareBps: 2000,
      notes: "Standing fortnightly disposables pool. Needs 2 more participants to clear the 200-case break on 16 oz cups.",
      commitments: [
        { business: "brawley", sku: "CUP-16", cases: 44 },
        { business: "brawley", sku: "LID-16", cases: 40 },
        { business: "brawley", sku: "NAP-DIN", cases: 22 },
        { business: "pitrow", sku: "CUP-16", cases: 60 },
        { business: "pitrow", sku: "CTN-9", cases: 48 },
        { business: "pitrow", sku: "BAG-TO", cases: 30 },
        { business: "fairview", sku: "CUP-16", cases: 18 },
        { business: "fairview", sku: "NAP-DIN", cases: 14 },
        { business: "pizzaworks", sku: "CTN-9", cases: 55 },
        { business: "pizzaworks", sku: "BAG-TO", cases: 26 },
        { business: "pizzaworks", sku: "TWL-ROLL", cases: 20 },
        { business: "catawbacater", sku: "CUP-16", cases: 52 },
        { business: "catawbacater", sku: "LID-16", cases: 48 },
        { business: "catawbacater", sku: "GLV-NIT", cases: 30 },
        { business: "catawbacater", sku: "SAN-QT", cases: 24 },
      ],
    },
    {
      key: "nm-produce-open",
      zone: "I77-NORTHMECK",
      supplier: "yadkin",
      name: "North Meck — Weekly Produce",
      status: "open",
      opens: days(-2),
      closes: days(1),
      delivery: days(3),
      minOrder: 250_000,
      feeModel: "savings_share",
      feeBps: 200,
      freightFee: 2000,
      savingsShareBps: 2000,
      notes: "Closes tomorrow at 5pm. Short lead time: Yadkin ships next morning.",
      commitments: [
        { business: "birkdale", sku: "PRD-ONI", cases: 26 },
        { business: "birkdale", sku: "PRD-LET", cases: 30 },
        { business: "birkdale", sku: "PRD-TOM", cases: 22 },
        { business: "fishcamp", sku: "PRD-POT", cases: 44 },
        { business: "fishcamp", sku: "PRD-ONI", cases: 20 },
        { business: "bagelbar", sku: "PRD-TOM", cases: 12 },
        { business: "tacoshop", sku: "PRD-ONI", cases: 34 },
        { business: "tacoshop", sku: "PRD-TOM", cases: 28 },
        { business: "tacoshop", sku: "PRD-LET", cases: 26 },
      ],
    },
    {
      key: "stv-broadline-negotiated",
      zone: "I77-STATESVILLE",
      supplier: "piedmont",
      name: "Statesville — Broadline Center-of-Plate",
      status: "negotiated",
      opens: days(-9),
      closes: days(-1),
      delivery: days(4),
      minOrder: 750_000,
      feeModel: "savings_share",
      feeBps: 250,
      freightFee: 2500,
      savingsShareBps: 2000,
      carrier: "catawbacold",
      notes: "Piedmont came back 1.9% under the published 250-case break on fryer oil. Member approvals due in 48 hours.",
      commitments: [
        { business: "signalhill", sku: "OIL-35", cases: 90, approved: true },
        { business: "signalhill", sku: "CHK-40", cases: 40, approved: true },
        { business: "signalhill", sku: "BEF-80", cases: 30, approved: true },
        { business: "depotcafe", sku: "OIL-35", cases: 34 },
        { business: "depotcafe", sku: "FLR-50", cases: 46 },
        { business: "winghouse", sku: "OIL-35", cases: 140, approved: true },
        { business: "winghouse", sku: "CHK-40", cases: 85 },
        { business: "winghouse", sku: "SAU-TOM", cases: 30 },
      ],
    },
    {
      key: "lkn-broadline-transit",
      zone: "I77-LKN",
      supplier: "piedmont",
      name: "Lake Norman — Broadline Dry & Chill",
      status: "shipped",
      opens: days(-14),
      closes: days(-6),
      delivery: days(1),
      minOrder: 750_000,
      feeModel: "savings_share",
      feeBps: 250,
      freightFee: 2500,
      savingsShareBps: 2000,
      carrier: "iredell",
      commitments: [
        { business: "brawley", sku: "OIL-35", cases: 60, approved: true },
        { business: "brawley", sku: "FLR-50", cases: 40, approved: true },
        { business: "brawley", sku: "CHS-SHRD", cases: 24, approved: true },
        { business: "pizzaworks", sku: "CHS-SHRD", cases: 96, approved: true },
        { business: "pizzaworks", sku: "SAU-TOM", cases: 70, approved: true },
        { business: "pizzaworks", sku: "FLR-50", cases: 110, approved: true },
        { business: "pitrow", sku: "OIL-35", cases: 48, approved: true },
        { business: "pitrow", sku: "RIC-25", cases: 36, approved: true },
        { business: "catawbacater", sku: "OIL-35", cases: 72, approved: true },
        { business: "catawbacater", sku: "RIC-25", cases: 60, approved: true },
        { business: "catawbacater", sku: "SAU-TOM", cases: 44, approved: true },
      ],
    },
    {
      key: "nm-broadline-delivered",
      zone: "I77-NORTHMECK",
      supplier: "piedmont",
      name: "North Meck — Broadline Dry & Chill",
      status: "delivered",
      opens: days(-34),
      closes: days(-26),
      delivery: days(-19),
      minOrder: 750_000,
      // This cycle ran before the fee model changed. Left on the old
      // percentage-of-spend schedule on purpose, so the app shows the
      // before-and-after on genuinely settled numbers.
      feeModel: "spend_bps",
      feeBps: 250,
      freightFee: 2500,
      savingsShareBps: 2000,
      carrier: "iredell",
      commitments: [
        { business: "birkdale", sku: "OIL-35", cases: 80, approved: true },
        { business: "birkdale", sku: "BEF-80", cases: 34, approved: true },
        { business: "birkdale", sku: "CHS-SHRD", cases: 30, approved: true },
        { business: "fishcamp", sku: "OIL-35", cases: 120, approved: true },
        { business: "fishcamp", sku: "FLR-50", cases: 64, approved: true },
        { business: "bagelbar", sku: "FLR-50", cases: 58, approved: true },
        { business: "bagelbar", sku: "OIL-35", cases: 22, approved: true },
        { business: "tacoshop", sku: "OIL-35", cases: 66, approved: true },
        { business: "tacoshop", sku: "CHS-SHRD", cases: 52, approved: true },
        { business: "tacoshop", sku: "RIC-25", cases: 48, approved: true },
      ],
    },
  ];

  const cycleId = new Map<string, string>();

  for (const c of CYCLES) {
    const [row] = await sql`
      insert into pool_cycles (zone_id, supplier_id, name, status, opens_at, closes_at,
                               delivery_date, min_order_cents, procurement_fee_bps,
                               freight_coord_fee_cents, fee_model, savings_share_bps,
                               notes, locked_at, confirmed_at)
      values (${zoneId.get(c.zone)!}, ${supplierId.get(c.supplier)!}, ${c.name}, ${c.status},
              ${c.opens}, ${c.closes}, ${dateOnly(c.delivery)}, ${c.minOrder}, ${c.feeBps},
              ${c.freightFee}, ${c.feeModel}, ${c.savingsShareBps}, ${c.notes ?? null},
              ${c.status === "open" ? null : c.closes},
              ${["confirmed", "shipped", "delivered"].includes(c.status) ? days(-5) : null})
      returning id
    `;
    const id = row.id as string;
    cycleId.set(c.key, id);

    for (const line of c.commitments) {
      const approved = line.approved ?? false;
      await sql`
        insert into commitments (cycle_id, business_id, product_id, cases, status,
                                 approved_at, approved_by, source)
        values (${id}, ${businessId.get(line.business)!}, ${productId.get(line.sku)!}, ${line.cases},
                ${approved ? "approved" : "committed"},
                ${approved ? c.closes : null},
                ${approved ? businessMeta.get(line.business)!.contact_name : null},
                ${line.source ?? "manual"})
      `;
    }

    // --- negotiated prices, shipment, settlement for advanced cycles ---
    if (!["negotiated", "confirmed", "shipped", "delivered"].includes(c.status)) continue;

    const products = [...new Set(c.commitments.map((l) => l.sku))].map(
      (sku) => engineProducts.get(sku)!,
    );
    const commitments = c.commitments.map((l) => ({
      businessId: businessId.get(l.business)!,
      productId: productId.get(l.sku)!,
      cases: l.cases,
    }));

    // Supplier concession: a small discount beneath the ladder price, which is
    // what a negotiation is actually for.
    const provisional = buildPoolLines(products, commitments);
    const granted = new Map<string, number>();
    for (const line of provisional) {
      const concession = c.key === "stv-broadline-negotiated" ? 0.981 : 0.992;
      const grantedPrice = Math.round(line.poolUnitCents * concession);
      granted.set(line.product.id, grantedPrice);
      await sql`
        insert into negotiated_prices (cycle_id, product_id, total_cases, tier_price_cents, granted_price_cents, recorded_at)
        values (${id}, ${line.product.id}, ${line.totalCases}, ${line.poolUnitCents}, ${grantedPrice}, ${c.closes})
      `;
    }

    if (!c.carrier) continue;

    const lines = buildPoolLines(products, commitments, granted);
    const supplier = SUPPLIERS.find((s) => s.key === c.supplier)!;
    const origin = { lat: supplier.origin_lat, lng: supplier.origin_lng };

    const participantKeys = [...new Set(c.commitments.map((l) => l.business))];
    const stopInputs = participantKeys.map((key) => {
      const b = businessMeta.get(key)!;
      return {
        businessId: businessId.get(key)!,
        point: { lat: b.lat, lng: b.lng },
        dockType: b.dock_type,
        items: c.commitments
          .filter((l) => l.business === key)
          .map((l) => ({ product: engineProducts.get(l.sku)!, cases: l.cases })),
      };
    });

    // Platform default: cap each member at its own LTL cost, so no member
    // pays more inside the pool than it would shipping alone.
    const load = planLoad(origin, engineCarriers.get(c.carrier)!, stopInputs, "ltl_capped");
    for (const w of load.warnings) {
      console.log(`    ! ${c.name}: ${w}`);
    }

    const shipmentStatus =
      c.status === "delivered" ? "delivered" : c.status === "shipped" ? "in_transit" : "planned";

    const [shipment] = await sql`
      insert into shipments (cycle_id, carrier_id, status, pickup_date, total_pallets,
                             total_weight_lb, route_miles, linehaul_cents, accessorial_cents,
                             allocation_method, tendered_at)
      values (${id}, ${carrierId.get(c.carrier)!}, ${shipmentStatus},
              ${dateOnly(days(c.status === "delivered" ? -20 : c.status === "shipped" ? 0 : 3))},
              ${load.totalPallets}, ${load.totalWeightLb}, ${load.routeMiles},
              ${load.linehaulCents}, ${load.accessorialCents}, ${load.allocationMethod},
              ${c.status === "planned" ? null : days(c.status === "delivered" ? -21 : -1)})
      returning id
    `;
    const shipmentId = shipment.id as string;

    const stopIds = new Map<string, string>();
    for (const stop of load.stops) {
      const deliveredAt =
        c.status === "delivered" ? days(-19 + stop.sequence * 0.05) : null;
      const stopStatus =
        c.status === "delivered"
          ? "delivered"
          : c.status === "shipped"
            ? stop.sequence === 1
              ? "delivered"
              : "out_for_delivery"
            : "planned";
      const etaBase = c.status === "delivered" ? days(-19) : c.delivery;
      const eta = new Date(etaBase.getTime());
      eta.setHours(7 + stop.sequence * 2, 30, 0, 0);

      const [srow] = await sql`
        insert into shipment_stops (shipment_id, business_id, sequence, pallets, weight_lb,
                                    miles_from_prev, eta, status, delivered_at, freight_cents, pod_signed_by)
        values (${shipmentId}, ${stop.businessId}, ${stop.sequence}, ${stop.pallets}, ${stop.weightLb},
                ${stop.milesFromPrev}, ${eta}, ${stopStatus},
                ${stopStatus === "delivered" ? (deliveredAt ?? days(0)) : null},
                ${stop.freightCents},
                ${stopStatus === "delivered" ? "Receiving" : null})
        returning id
      `;
      stopIds.set(stop.businessId, srow.id as string);
    }

    // Tracking events
    const events: Array<[string | null, string, string, Date]> = [
      [null, "tendered", `Load tendered to ${engineCarriers.get(c.carrier)!.name}.`, days(c.status === "delivered" ? -21 : -1)],
    ];
    if (c.status !== "planned") {
      events.push([
        null,
        "picked_up",
        `Picked up at ${supplier.name}, ${load.totalPallets} pallets, ${Math.round(load.totalWeightLb).toLocaleString()} lb.`,
        days(c.status === "delivered" ? -20 : 0),
      ]);
    }
    for (const stop of load.stops) {
      const isDelivered =
        c.status === "delivered" || (c.status === "shipped" && stop.sequence === 1);
      if (isDelivered) {
        events.push([
          stopIds.get(stop.businessId)!,
          "delivered",
          `Stop ${stop.sequence} delivered — ${stop.pallets} pallet(s) signed for.`,
          days(c.status === "delivered" ? -19 + stop.sequence * 0.05 : 0),
        ]);
      } else if (c.status === "shipped") {
        events.push([
          stopIds.get(stop.businessId)!,
          "out_for_delivery",
          `Stop ${stop.sequence} out for delivery.`,
          days(0),
        ]);
      }
    }
    for (const [stopId, code, message, occurredAt] of events) {
      await sql`
        insert into tracking_events (shipment_id, stop_id, code, message, occurred_at)
        values (${shipmentId}, ${stopId}, ${code}, ${message}, ${occurredAt})
      `;
    }

    // Settlements, once the load is on the road or complete.
    if (c.status === "shipped" || c.status === "delivered") {
      const settlement = settleCycle({
        lines,
        load,
        supplierOrigin: origin,
        businesses: participantKeys.map((key) => {
          const b = businessMeta.get(key)!;
          return {
            id: businessId.get(key)!,
            point: { lat: b.lat, lng: b.lng },
            dockType: b.dock_type,
          };
        }),
        fees:
          c.feeModel === "spend_bps"
            ? {
                kind: "spend_bps",
                procurementFeeBps: c.feeBps,
                freightCoordFeeCents: c.freightFee,
              }
            : { kind: "savings_share", shareBps: c.savingsShareBps },
      });

      for (const s of settlement.businesses) {
        await sql`
          insert into settlements (cycle_id, business_id, goods_cents, freight_cents,
                                   procurement_fee_cents, freight_coord_fee_cents,
                                   savings_share_fee_cents, fee_model,
                                   solo_goods_cents, solo_freight_cents,
                                   gross_savings_cents, net_savings_cents, issued_at)
          values (${id}, ${s.businessId}, ${s.goodsCents}, ${s.freightCents},
                  ${s.procurementFeeCents}, ${s.freightCoordFeeCents},
                  ${s.savingsShareFeeCents}, ${c.feeModel},
                  ${s.soloGoodsCents}, ${s.soloFreightCents},
                  ${s.grossSavingsCents}, ${s.netSavingsCents},
                  ${days(c.status === "delivered" ? -18 : 0)})
        `;
      }
      console.log(
        `  cycle "${c.name}" [${c.feeModel}]: ${settlement.businesses.length} settlements, ` +
          `$${(settlement.netSavingsCents / 100).toFixed(2)} member savings, ` +
          `$${(settlement.feeRevenueCents / 100).toFixed(2)} fee revenue`,
      );
      for (const screen of screenParticipants(settlement)) {
        if (!screen.ok) {
          const key = participantKeys.find((k) => businessId.get(k) === screen.businessId)!;
          console.log(`    ! ${businessMeta.get(key)!.dba} [${screen.cause}] ${screen.finding}`);
        }
      }
    }
  }
  console.log(`  ${cycleId.size} pool cycles`);

  // -------------------------------------------------------------------------
  // Inventory + agent policies
  // -------------------------------------------------------------------------
  type Inv = [string, string, number, number, number, number]; // business, sku, onHand, weekly, par, safetyDays
  const INVENTORY: Inv[] = [
    // Brawley Street Kitchen — the demo member. Mixed urgency on purpose.
    ["brawley", "CUP-16", 9, 22, 48, 5],
    ["brawley", "LID-16", 12, 20, 44, 5],
    ["brawley", "NAP-DIN", 16, 9, 24, 5],
    ["brawley", "TWL-ROLL", 4, 7, 20, 5],
    ["brawley", "GLV-NIT", 3, 5, 14, 5],
    ["brawley", "SAN-QT", 11, 3, 12, 5],
    ["brawley", "OIL-35", 38, 14, 60, 6],
    ["brawley", "FLR-50", 31, 9, 40, 6],
    ["brawley", "CHS-SHRD", 18, 11, 28, 4],
    ["brawley", "BAG-TO", 7, 11, 28, 5],

    ["pitrow", "CUP-16", 21, 26, 60, 5],
    ["pitrow", "CTN-9", 14, 24, 52, 5],
    ["pitrow", "OIL-35", 12, 16, 48, 6],
    ["pitrow", "BAG-TO", 6, 13, 30, 5],

    ["catawbacater", "GLV-NIT", 8, 12, 32, 4],
    ["catawbacater", "SAN-QT", 9, 10, 26, 4],
    ["catawbacater", "CUP-16", 17, 24, 56, 5],
    ["catawbacater", "LID-16", 15, 23, 52, 5],

    ["birkdale", "PRD-LET", 5, 14, 30, 3],
    ["birkdale", "PRD-TOM", 4, 11, 24, 3],
    ["birkdale", "PRD-ONI", 9, 12, 28, 3],
    ["birkdale", "OIL-35", 44, 15, 80, 6],

    ["tacoshop", "PRD-ONI", 7, 16, 36, 3],
    ["tacoshop", "PRD-TOM", 6, 13, 30, 3],
    ["tacoshop", "PRD-LET", 8, 12, 28, 3],

    ["signalhill", "OIL-35", 22, 20, 90, 6],
    ["signalhill", "CHK-40", 11, 9, 40, 6],
  ];

  for (const [bkey, sku, onHand, weekly, par, safety] of INVENTORY) {
    await sql`
      insert into inventory_items (business_id, product_id, on_hand_cases, avg_weekly_cases, par_cases, safety_days, counted_at)
      values (${businessId.get(bkey)!}, ${productId.get(sku)!}, ${onHand}, ${weekly}, ${par}, ${safety}, ${days(-1)})
    `;
  }
  console.log(`  ${INVENTORY.length} inventory positions`);

  const POLICIES = [
    { business: "brawley", enabled: true, budget: 400_000, auto: 60_000, categories: ["disposables", "paper", "sanitation", "dry_goods", "oils_fats"] },
    { business: "catawbacater", enabled: true, budget: 600_000, auto: 100_000, categories: ["disposables", "paper", "sanitation"] },
    { business: "birkdale", enabled: true, budget: 350_000, auto: 50_000, categories: ["produce", "oils_fats"] },
    { business: "pitrow", enabled: false, budget: 200_000, auto: 25_000, categories: ["disposables"] },
    { business: "signalhill", enabled: false, budget: 500_000, auto: 75_000, categories: ["oils_fats", "protein"] },
    { business: "tacoshop", enabled: false, budget: 150_000, auto: 20_000, categories: ["produce"] },
  ];
  for (const p of POLICIES) {
    await sql`
      insert into agent_policies (business_id, enabled, cycle_budget_cents, auto_approve_under_cents, allowed_categories)
      values (${businessId.get(p.business)!}, ${p.enabled}, ${p.budget}, ${p.auto}, ${p.categories})
    `;
  }

  // -------------------------------------------------------------------------
  // One real agent run, so the proposal inbox has genuine traces in it.
  // -------------------------------------------------------------------------
  for (const [bkey, cycleKey] of [
    ["brawley", "lkn-paper-open"],
    ["birkdale", "nm-produce-open"],
  ] as const) {
    const policy = POLICIES.find((p) => p.business === bkey)!;
    const cycleSpec = CYCLES.find((c) => c.key === cycleKey)!;
    const supplierKey = cycleSpec.supplier;

    const catalog = new Map<string, Product>();
    for (const p of PRODUCTS) {
      if (p.supplier === supplierKey) catalog.set(productId.get(p.sku)!, engineProducts.get(p.sku)!);
    }

    const inventory = INVENTORY.filter(([b]) => b === bkey).map(
      ([, sku, onHand, weekly, par, safety]) => ({
        productId: productId.get(sku)!,
        onHandCases: onHand,
        avgWeeklyCases: weekly,
        parCases: par,
        safetyDays: safety,
      }),
    );

    // Demand already on the cycle from everyone else in the zone.
    const zoneDemand = new Map<string, number>();
    const own = new Map<string, number>();
    for (const line of cycleSpec.commitments) {
      const pid = productId.get(line.sku)!;
      if (line.business === bkey) own.set(pid, (own.get(pid) ?? 0) + line.cases);
      else zoneDemand.set(pid, (zoneDemand.get(pid) ?? 0) + line.cases);
    }

    const plan = planReplenishment({
      businessName: businessMeta.get(bkey)!.dba,
      deliveryDate: cycleSpec.delivery,
      now: today,
      policy: {
        enabled: policy.enabled,
        cycleBudgetCents: policy.budget,
        autoApproveUnderCents: policy.auto,
        allowedCategories: policy.categories,
      },
      inventory,
      products: catalog,
      zoneDemand,
      existingCommitments: own,
    });

    const [run] = await sql`
      insert into agent_runs (business_id, cycle_id, status, trigger, started_at, finished_at)
      values (${businessId.get(bkey)!}, ${cycleId.get(cycleKey)!}, 'completed', 'scheduled',
              ${days(-0.2)}, ${days(-0.19)})
      returning id
    `;
    const runId = run.id as string;

    for (const step of plan.steps) {
      await sql`
        insert into agent_steps (run_id, sequence, label, detail)
        values (${runId}, ${step.sequence}, ${step.label}, ${step.detail})
      `;
    }

    for (const p of plan.proposals) {
      let commitmentRowId: string | null = null;
      if (p.autoApprove) {
        // The agent commits inside policy; the line lands on the cycle tagged
        // as agent-sourced so the member can always see what it did.
        const [existing] = await sql`
          select id, cases from commitments
          where cycle_id = ${cycleId.get(cycleKey)!}
            and business_id = ${businessId.get(bkey)!}
            and product_id = ${p.productId}
        `;
        if (existing) {
          await sql`
            update commitments set cases = cases + ${p.cases}, source = 'agent'
            where id = ${existing.id}
          `;
          commitmentRowId = existing.id as string;
        } else {
          const [crow] = await sql`
            insert into commitments (cycle_id, business_id, product_id, cases, status, source, agent_run_id)
            values (${cycleId.get(cycleKey)!}, ${businessId.get(bkey)!}, ${p.productId}, ${p.cases},
                    'committed', 'agent', ${runId})
            returning id
          `;
          commitmentRowId = crow.id as string;
        }
      }

      await sql`
        insert into agent_proposals (run_id, business_id, cycle_id, product_id, cases,
                                     est_unit_cents, est_total_cents, days_to_depletion,
                                     reason, status, decided_at, decided_by, commitment_id, created_at)
        values (${runId}, ${businessId.get(bkey)!}, ${cycleId.get(cycleKey)!}, ${p.productId}, ${p.cases},
                ${p.estUnitCents}, ${p.estTotalCents}, ${p.daysToDepletion}, ${p.reason},
                ${p.autoApprove ? "auto_approved" : "pending"},
                ${p.autoApprove ? days(-0.19) : null},
                ${p.autoApprove ? "90 Express agent" : null},
                ${commitmentRowId}, ${days(-0.19)})
      `;
    }

    console.log(
      `  agent run for ${businessMeta.get(bkey)!.dba}: ${plan.proposals.length} proposal(s), ` +
        `${plan.steps.length} reasoning steps`,
    );
  }

  console.log("\nSeed complete.");
  const [{ count }] = await sql`select count(*)::int as count from commitments`;
  console.log(`  ${count} commitments across all cycles`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
