-- 90 Express — Consumer Road Share (CRS) core schema
-- Portable Postgres. Runs on local Postgres 14+ and on Supabase unchanged.
-- Money is stored as integer cents. Distances in integer miles. Weights in pounds.

begin;

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- MODULE: ZoneMap — geographic purchasing zones along a corridor
-- ---------------------------------------------------------------------------
create table zones (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,              -- 'I77-MOORESVILLE'
  name            text not null,
  corridor        text not null default 'I-77',
  center_lat      double precision not null,
  center_lng      double precision not null,
  radius_miles    integer not null default 20,
  -- 0=Sunday .. 6=Saturday. Standing delivery day for consolidated loads.
  delivery_dow    integer not null check (delivery_dow between 0 and 6),
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- MODULE: Business Network — members of the collective
-- ---------------------------------------------------------------------------
create type membership_tier as enum ('starter', 'standard', 'premium');
create type business_status as enum ('pending', 'active', 'suspended');

create table businesses (
  id                 uuid primary key default gen_random_uuid(),
  zone_id            uuid not null references zones(id) on delete restrict,
  legal_name         text not null,
  dba                text,
  segment            text not null,                 -- 'full_service_restaurant', 'pizzeria', ...
  contact_name       text not null,
  contact_email      text not null unique,
  phone              text,
  street             text not null,
  city               text not null,
  state              text not null default 'NC',
  postal_code        text not null,
  lat                double precision not null,
  lng                double precision not null,
  -- Receiving constraints matter for routing and are priced into freight.
  dock_type          text not null default 'liftgate' check (dock_type in ('dock','liftgate','ground')),
  receiving_open     time not null default '07:00',
  receiving_close    time not null default '15:00',
  membership_tier    membership_tier not null default 'standard',
  status             business_status not null default 'active',
  joined_at          timestamptz not null default now()
);
create index on businesses (zone_id);

-- ---------------------------------------------------------------------------
-- MODULE: Supplier Network — wholesalers and their catalogs
-- ---------------------------------------------------------------------------
create table suppliers (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  origin_city          text not null,
  origin_state         text not null,
  origin_lat           double precision not null,
  origin_lng           double precision not null,
  lead_time_days       integer not null default 3,
  -- Supplier will not release a negotiated collective order below this value.
  min_order_cents      integer not null default 0,
  -- Supplier agrees to invoice each buyer separately at the collective price.
  invoices_members_separately boolean not null default true,
  terms                text not null default 'Net 15',
  active               boolean not null default true,
  created_at           timestamptz not null default now()
);

create table products (
  id                uuid primary key default gen_random_uuid(),
  supplier_id       uuid not null references suppliers(id) on delete cascade,
  sku               text not null,
  name              text not null,
  category          text not null,
  -- A "case" is the orderable unit throughout the system.
  unit_label        text not null default 'case',
  pack_description  text not null,                 -- '6/1 gal'
  cases_per_pallet  integer not null check (cases_per_pallet > 0),
  case_weight_lb    numeric(8,2) not null check (case_weight_lb > 0),
  -- Published single-buyer price. Pool pricing comes from price_tiers.
  list_price_cents  integer not null check (list_price_cents > 0),
  temp_class        text not null default 'dry' check (temp_class in ('dry','chill','frozen')),
  active            boolean not null default true,
  unique (supplier_id, sku)
);
create index on products (supplier_id);
create index on products (category);

-- Volume break ladder. The row with the greatest min_cases <= qty wins.
create table price_tiers (
  id               uuid primary key default gen_random_uuid(),
  product_id       uuid not null references products(id) on delete cascade,
  min_cases        integer not null check (min_cases > 0),
  unit_price_cents integer not null check (unit_price_cents > 0),
  unique (product_id, min_cases)
);
create index on price_tiers (product_id, min_cases desc);

-- ---------------------------------------------------------------------------
-- MODULE: Freight — contracted carriers
-- ---------------------------------------------------------------------------
create table carriers (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  mc_number              text,
  equipment              text not null default 'dry_van' check (equipment in ('dry_van','reefer','flatbed')),
  capacity_pallets       integer not null check (capacity_pallets > 0),
  max_weight_lb          integer not null default 45000,
  linehaul_rate_cents    integer not null,          -- per mile, truckload
  min_charge_cents       integer not null default 0,
  stop_charge_cents      integer not null default 0, -- per delivery stop after the first
  liftgate_fee_cents     integer not null default 0,
  active                 boolean not null default true
);

-- ---------------------------------------------------------------------------
-- MODULE: CRS Marketplace — collective purchasing cycles
-- ---------------------------------------------------------------------------
-- open        accepting commitments
-- locked      window closed, aggregate demand frozen, out for negotiation
-- negotiated  supplier returned collective pricing, awaiting member approval
-- confirmed   approvals in, PO released, load tendered
-- shipped     carrier picked up
-- delivered   all stops complete
-- failed      minimums not met or supplier declined; commitments released
create type cycle_status as enum
  ('open','locked','negotiated','confirmed','shipped','delivered','failed');

create table pool_cycles (
  id                 uuid primary key default gen_random_uuid(),
  zone_id            uuid not null references zones(id) on delete restrict,
  supplier_id        uuid not null references suppliers(id) on delete restrict,
  name               text not null,
  status             cycle_status not null default 'open',
  opens_at           timestamptz not null,
  closes_at          timestamptz not null,
  delivery_date      date not null,
  -- Minimum collective order value for this specific cycle. Defaults from supplier.
  min_order_cents    integer not null default 0,
  -- Revenue policy, captured per cycle so historical settlements stay reproducible.
  procurement_fee_bps      integer not null default 250,  -- 2.50% of goods subtotal
  freight_coord_fee_cents  integer not null default 2500,  -- per delivering stop
  notes              text,
  locked_at          timestamptz,
  confirmed_at       timestamptz,
  created_at         timestamptz not null default now(),
  check (closes_at > opens_at)
);
create index on pool_cycles (zone_id, status);
create index on pool_cycles (closes_at);

-- A business's line item in a cycle. Ownership of goods stays with the business.
create type commitment_status as enum ('draft','committed','approved','declined','cancelled');

create table commitments (
  id              uuid primary key default gen_random_uuid(),
  cycle_id        uuid not null references pool_cycles(id) on delete cascade,
  business_id     uuid not null references businesses(id) on delete cascade,
  product_id      uuid not null references products(id) on delete restrict,
  cases           integer not null check (cases > 0),
  status          commitment_status not null default 'committed',
  -- Set when the member (or their agent, within policy) approves the
  -- negotiated allocation. This is the binding act.
  approved_at     timestamptz,
  approved_by     text,
  -- Provenance: did a human or an agent create this line?
  source          text not null default 'manual' check (source in ('manual','agent')),
  agent_run_id    uuid,
  created_at      timestamptz not null default now(),
  unique (cycle_id, business_id, product_id)
);
create index on commitments (cycle_id);
create index on commitments (business_id);

-- Immutable record of the price the supplier actually granted for a cycle.
-- Written at negotiation time so settlements never drift with catalog changes.
create table negotiated_prices (
  id                  uuid primary key default gen_random_uuid(),
  cycle_id            uuid not null references pool_cycles(id) on delete cascade,
  product_id          uuid not null references products(id) on delete restrict,
  total_cases         integer not null,
  -- What the ladder implied for the pooled quantity.
  tier_price_cents    integer not null,
  -- What the supplier actually agreed to (may beat or miss the ladder).
  granted_price_cents integer not null,
  recorded_at         timestamptz not null default now(),
  unique (cycle_id, product_id)
);

-- ---------------------------------------------------------------------------
-- MODULE: Freight Management — consolidated loads and allocated stops
-- ---------------------------------------------------------------------------
create type shipment_status as enum ('planned','tendered','accepted','in_transit','delivered','cancelled');

create table shipments (
  id                   uuid primary key default gen_random_uuid(),
  cycle_id             uuid not null unique references pool_cycles(id) on delete cascade,
  carrier_id           uuid references carriers(id) on delete set null,
  status               shipment_status not null default 'planned',
  pickup_date          date not null,
  total_pallets        integer not null default 0,
  total_weight_lb      numeric(10,2) not null default 0,
  route_miles          integer not null default 0,
  linehaul_cents       integer not null default 0,
  accessorial_cents    integer not null default 0,
  -- How linehaul was divided. Stored for auditability of every settlement.
  allocation_method    text not null default 'pallet_share_plus_stop',
  tendered_at          timestamptz,
  created_at           timestamptz not null default now()
);

create type stop_status as enum ('planned','out_for_delivery','delivered','exception');

create table shipment_stops (
  id                  uuid primary key default gen_random_uuid(),
  shipment_id         uuid not null references shipments(id) on delete cascade,
  business_id         uuid not null references businesses(id) on delete restrict,
  sequence            integer not null,
  pallets             integer not null default 0,
  weight_lb           numeric(10,2) not null default 0,
  miles_from_prev     integer not null default 0,
  eta                 timestamptz,
  status              stop_status not null default 'planned',
  delivered_at        timestamptz,
  -- Allocated freight cost owed by this business for this load.
  freight_cents       integer not null default 0,
  pod_signed_by       text,
  exception_note      text,
  unique (shipment_id, business_id),
  unique (shipment_id, sequence)
);
create index on shipment_stops (business_id);

create table tracking_events (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references shipments(id) on delete cascade,
  stop_id       uuid references shipment_stops(id) on delete cascade,
  code          text not null,                       -- 'tendered','picked_up','arrived','delivered'
  message       text not null,
  occurred_at   timestamptz not null default now()
);
create index on tracking_events (shipment_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Settlement — the per-business bill for a cycle. 90 Express never takes
-- title to goods: goods_cents is owed to the supplier, freight to the carrier,
-- and only the fee columns are 90 Express revenue.
-- ---------------------------------------------------------------------------
create table settlements (
  id                      uuid primary key default gen_random_uuid(),
  cycle_id                uuid not null references pool_cycles(id) on delete cascade,
  business_id             uuid not null references businesses(id) on delete cascade,
  goods_cents             integer not null,
  freight_cents           integer not null,
  procurement_fee_cents   integer not null,
  freight_coord_fee_cents integer not null,
  -- Counterfactual: what this order would have cost the business alone.
  solo_goods_cents        integer not null,
  solo_freight_cents      integer not null,
  net_savings_cents       integer not null,
  issued_at               timestamptz not null default now(),
  unique (cycle_id, business_id)
);

-- ---------------------------------------------------------------------------
-- Inventory + autonomous replenishment
-- ---------------------------------------------------------------------------
create table inventory_items (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references businesses(id) on delete cascade,
  product_id         uuid not null references products(id) on delete cascade,
  on_hand_cases      numeric(10,2) not null default 0,
  -- Observed consumption. In production this is derived from POS/usage history.
  avg_weekly_cases   numeric(10,2) not null check (avg_weekly_cases >= 0),
  par_cases          numeric(10,2) not null,         -- target level after replenishment
  safety_days        integer not null default 5,
  counted_at         timestamptz not null default now(),
  unique (business_id, product_id)
);
create index on inventory_items (business_id);

create table agent_policies (
  id                       uuid primary key default gen_random_uuid(),
  business_id              uuid not null unique references businesses(id) on delete cascade,
  enabled                  boolean not null default false,
  -- Hard ceiling the agent may commit per cycle without a human.
  cycle_budget_cents       integer not null default 0,
  -- Below this line the agent may approve outright; above it, a human approves.
  auto_approve_under_cents integer not null default 0,
  -- Categories the agent is allowed to buy.
  allowed_categories       text[] not null default '{}',
  updated_at               timestamptz not null default now()
);

create type agent_run_status as enum ('running','completed','failed');

create table agent_runs (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  cycle_id      uuid references pool_cycles(id) on delete set null,
  status        agent_run_status not null default 'running',
  trigger       text not null default 'scheduled',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  error         text
);
create index on agent_runs (business_id, started_at desc);

-- Human-readable reasoning trace. Every proposal must be explainable.
create table agent_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references agent_runs(id) on delete cascade,
  sequence    integer not null,
  label       text not null,
  detail      text not null,
  unique (run_id, sequence)
);

create type proposal_status as enum ('pending','auto_approved','approved','rejected','expired');

create table agent_proposals (
  id                  uuid primary key default gen_random_uuid(),
  run_id              uuid not null references agent_runs(id) on delete cascade,
  business_id         uuid not null references businesses(id) on delete cascade,
  cycle_id            uuid not null references pool_cycles(id) on delete cascade,
  product_id          uuid not null references products(id) on delete restrict,
  cases               integer not null check (cases > 0),
  -- Snapshot of the economics at proposal time.
  est_unit_cents      integer not null,
  est_total_cents     integer not null,
  days_to_depletion   numeric(6,2) not null,
  reason              text not null,
  status              proposal_status not null default 'pending',
  decided_at          timestamptz,
  decided_by          text,
  commitment_id       uuid references commitments(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index on agent_proposals (business_id, status);

-- ---------------------------------------------------------------------------
-- Membership billing (90 Express recurring revenue)
-- ---------------------------------------------------------------------------
create table membership_plans (
  tier              membership_tier primary key,
  monthly_cents     integer not null,
  agent_addon_cents integer not null default 0,
  description       text not null
);

commit;
