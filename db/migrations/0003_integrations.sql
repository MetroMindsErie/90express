-- Supplier and carrier integrations.
--
-- Two jobs here, and they are different in kind:
--
--   Suppliers feed the catalog. A price sheet arriving from a distributor
--   must never silently re-price a live pool, so inbound catalog changes land
--   in catalog_changes as proposals and a human applies them. Prices already
--   negotiated on a cycle are frozen in negotiated_prices and are not touched
--   by any feed.
--
--   Carriers feed rates, tenders, tracking and invoices. A real rated quote
--   replaces the LTL_BENCHMARK estimate the savings figures currently rest on,
--   which is the single most valuable thing an integration buys this system.
--
-- Credentials are never stored here. A provider records the NAME of the
-- environment variable holding its token; the value stays in the environment.

begin;

create type partner_kind as enum ('supplier', 'carrier');
create type adapter_kind as enum ('manual', 'csv', 'http');

create table integration_providers (
  id             uuid primary key default gen_random_uuid(),
  partner        partner_kind not null,
  supplier_id    uuid references suppliers(id) on delete cascade,
  carrier_id     uuid references carriers(id) on delete cascade,
  name           text not null,
  adapter        adapter_kind not null,
  -- The partner's own identifier for us to address them by, as it appears in
  -- their API paths. Recorded explicitly: deriving it from a display name
  -- breaks the first time a partner is called "Catawba Cold Carriers".
  partner_ref    text not null default '',
  -- http adapters
  base_url       text,
  -- Name of the env var holding the bearer token. Never the token itself.
  auth_env_var   text,
  -- csv adapters: path to the price sheet, relative to the repo root.
  source_path    text,
  enabled        boolean not null default true,
  -- Minutes between scheduled syncs. Null means manual only.
  sync_interval_minutes integer,
  last_run_at    timestamptz,
  created_at     timestamptz not null default now(),
  -- Exactly one partner reference, matching the declared kind.
  constraint provider_target_matches_kind check (
    (partner = 'supplier' and supplier_id is not null and carrier_id is null) or
    (partner = 'carrier'  and carrier_id  is not null and supplier_id is null)
  ),
  constraint http_needs_base_url check (adapter <> 'http' or base_url is not null),
  constraint csv_needs_source check (adapter <> 'csv' or source_path is not null)
);
create index on integration_providers (partner, enabled);

create type run_status as enum ('running', 'succeeded', 'partial', 'failed');

create table integration_runs (
  id             uuid primary key default gen_random_uuid(),
  provider_id    uuid not null references integration_providers(id) on delete cascade,
  operation      text not null,            -- 'catalog_sync','rate','tender','track','invoice_sync'
  status         run_status not null default 'running',
  trigger        text not null default 'manual',
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  items_seen     integer not null default 0,
  items_changed  integer not null default 0,
  error          text,
  -- Guards against a retry repeating a side effect (a second tender, say).
  idempotency_key text unique
);
create index on integration_runs (provider_id, started_at desc);

create table integration_run_events (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references integration_runs(id) on delete cascade,
  sequence    integer not null,
  level       text not null default 'info' check (level in ('info','warn','error')),
  message     text not null,
  unique (run_id, sequence)
);

-- ---------------------------------------------------------------------------
-- Inbound catalog changes, staged for review
-- ---------------------------------------------------------------------------
create type catalog_change_type as enum
  ('price', 'tier', 'new_product', 'discontinued', 'pack');
create type catalog_change_status as enum
  ('pending', 'applied', 'rejected', 'superseded');

create table catalog_changes (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references integration_runs(id) on delete cascade,
  supplier_id   uuid not null references suppliers(id) on delete cascade,
  -- Null for a product the feed offers that is not in the catalog yet.
  product_id    uuid references products(id) on delete cascade,
  sku           text not null,
  product_name  text not null,
  change_type   catalog_change_type not null,
  old_value     jsonb,
  new_value     jsonb not null,
  -- Blast radius, computed when the change is staged.
  affected_open_cycles integer not null default 0,
  committed_cases      integer not null default 0,
  -- Signed: positive means the change costs members more.
  impact_cents         integer not null default 0,
  status        catalog_change_status not null default 'pending',
  decided_at    timestamptz,
  decided_by    text,
  created_at    timestamptz not null default now()
);
create index on catalog_changes (supplier_id, status);
create index on catalog_changes (run_id);

-- ---------------------------------------------------------------------------
-- Carrier rating
-- ---------------------------------------------------------------------------
-- consolidated : rate the pooled load for a cycle
-- member_solo  : rate one member's order shipped alone, which is the
--                counterfactual every savings figure is measured against
create type quote_purpose as enum ('consolidated', 'member_solo');

create table carrier_quotes (
  id                uuid primary key default gen_random_uuid(),
  run_id            uuid references integration_runs(id) on delete set null,
  provider_id       uuid references integration_providers(id) on delete set null,
  carrier_id        uuid not null references carriers(id) on delete cascade,
  cycle_id          uuid not null references pool_cycles(id) on delete cascade,
  purpose           quote_purpose not null,
  -- Set only for member_solo quotes.
  business_id       uuid references businesses(id) on delete cascade,
  quote_ref         text,
  linehaul_cents    integer not null,
  accessorial_cents integer not null default 0,
  total_cents       integer not null,
  transit_days      integer,
  valid_until       timestamptz,
  -- What the engine's benchmark said, recorded alongside so drift is visible.
  benchmark_cents   integer,
  raw               jsonb,
  created_at        timestamptz not null default now()
);
create index on carrier_quotes (cycle_id, purpose, created_at desc);
create index on carrier_quotes (cycle_id, business_id) where purpose = 'member_solo';

-- ---------------------------------------------------------------------------
-- Tendering
-- ---------------------------------------------------------------------------
create type tender_status as enum
  ('offered', 'accepted', 'declined', 'expired', 'cancelled');

create table carrier_tenders (
  id              uuid primary key default gen_random_uuid(),
  shipment_id     uuid not null references shipments(id) on delete cascade,
  carrier_id      uuid not null references carriers(id) on delete restrict,
  quote_id        uuid references carrier_quotes(id) on delete set null,
  run_id          uuid references integration_runs(id) on delete set null,
  status          tender_status not null default 'offered',
  tender_ref      text,
  offered_cents   integer not null,
  offered_at      timestamptz not null default now(),
  responded_at    timestamptz,
  decline_reason  text,
  -- One live tender per shipment and carrier; a retry cannot double-offer.
  idempotency_key text not null unique
);
create index on carrier_tenders (shipment_id, status);

-- ---------------------------------------------------------------------------
-- Freight invoice reconciliation
-- ---------------------------------------------------------------------------
-- A carrier billing more than it quoted is normal and must be caught before
-- it is passed on to members, who were already given an allocated figure.
create type invoice_status as enum ('received', 'matched', 'variance', 'disputed', 'approved');

create table freight_invoices (
  id                    uuid primary key default gen_random_uuid(),
  shipment_id           uuid not null references shipments(id) on delete cascade,
  carrier_id            uuid not null references carriers(id) on delete restrict,
  run_id                uuid references integration_runs(id) on delete set null,
  invoice_ref           text not null,
  invoice_date          date not null,
  linehaul_cents        integer not null,
  accessorial_cents     integer not null default 0,
  total_cents           integer not null,
  -- What members were billed for this load, from shipment_stops.
  allocated_cents       integer not null,
  -- invoice - allocated. Positive means the carrier billed more than we
  -- collected and 90 Express is short.
  variance_cents        integer not null,
  status                invoice_status not null default 'received',
  note                  text,
  raw                   jsonb,
  received_at           timestamptz not null default now(),
  unique (carrier_id, invoice_ref)
);
create index on freight_invoices (shipment_id);
create index on freight_invoices (status);

-- Tracking events gain provenance so a carrier feed cannot be confused with
-- something an operator typed, and so a repeated pull does not duplicate.
alter table tracking_events
  add column source text not null default 'manual' check (source in ('manual','carrier_feed')),
  add column external_ref text;

create unique index tracking_events_external_ref_idx
  on tracking_events (shipment_id, external_ref)
  where external_ref is not null;

commit;
