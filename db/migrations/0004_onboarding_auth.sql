-- Member onboarding and authentication.
--
-- Replaces the cookie-based "acting as" switcher with real accounts, and adds
-- the funnel that turns a prospective operator into an active member:
--
--   apply → match a zone → show an honest savings estimate → operator review
--         → provision business + invite → accept terms → active
--
-- Two things this schema is deliberate about:
--
--   The savings estimate shown to an applicant is snapshotted on the
--   application. If someone joins because we told them they would save $340 a
--   cycle, the number we showed them has to still be there when they ask.
--
--   Terms acceptance records a version. The commercial terms that matter --
--   what a commitment binds, what happens when a pool misses its minimum, the
--   fee model -- will change, and "which version did this member agree to" has
--   to be answerable years later.

begin;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------
create type user_role as enum ('member', 'operator');

create table users (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  -- Null until the invite is accepted. A user with no hash cannot sign in.
  password_hash    text,
  role             user_role not null default 'member',
  -- Operators have no business; members always do.
  business_id      uuid references businesses(id) on delete cascade,
  display_name     text not null,
  -- Invite tokens are stored hashed, like session tokens. A leaked database
  -- must not hand someone a working invite link.
  invite_token_hash text,
  invite_expires_at timestamptz,
  -- Crude but effective throttling; see verifyPassword.
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  last_login_at    timestamptz,
  created_at       timestamptz not null default now(),
  constraint member_has_business check (role <> 'member' or business_id is not null),
  constraint operator_has_no_business check (role <> 'operator' or business_id is null)
);

-- Email is the login identifier, matched case-insensitively.
create unique index users_email_lower_idx on users (lower(email));
create index on users (business_id);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  -- The cookie holds the token; this holds its SHA-256. Reading this table
  -- does not let anyone assume a session.
  token_hash   text not null unique,
  user_id      uuid not null references users(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index on sessions (user_id);
create index on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Terms
-- ---------------------------------------------------------------------------
create table terms_versions (
  id             uuid primary key default gen_random_uuid(),
  version        text not null unique,
  effective_from date not null,
  summary        text not null,
  -- The clauses that decide what a member is actually agreeing to.
  body           jsonb not null,
  created_at     timestamptz not null default now()
);

create table terms_acceptances (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  terms_version_id uuid not null references terms_versions(id) on delete restrict,
  user_id          uuid references users(id) on delete set null,
  accepted_by_name text not null,
  accepted_at      timestamptz not null default now(),
  unique (business_id, terms_version_id)
);

-- ---------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------
-- waitlisted : outside every active zone. Held against the nearest planned
--              zone, because waitlist density is the signal for where the
--              next zone opens.
create type application_status as enum
  ('submitted', 'reviewing', 'waitlisted', 'approved', 'declined', 'withdrawn');

create table member_applications (
  id              uuid primary key default gen_random_uuid(),
  legal_name      text not null,
  dba             text,
  segment         text not null,
  contact_name    text not null,
  contact_email   text not null,
  phone           text,
  street          text not null,
  city            text not null,
  state           text not null default 'NC',
  postal_code     text not null,
  -- Derived from the postal code against the corridor table. No external
  -- geocoder: an applicant's address does not leave this system.
  lat             double precision,
  lng             double precision,
  zone_id         uuid references zones(id) on delete set null,
  -- Set when no active zone covers them; the nearest zone, active or planned.
  nearest_zone_id uuid references zones(id) on delete set null,
  distance_miles  numeric(6,1),
  dock_type       text not null default 'liftgate'
                  check (dock_type in ('dock','liftgate','ground')),
  receiving_open  time not null default '07:00',
  receiving_close time not null default '15:00',
  requested_tier  membership_tier not null default 'standard',
  status          application_status not null default 'submitted',
  -- What we showed the applicant, as computed at submission.
  estimate        jsonb,
  notes           text,
  reviewed_by     text,
  reviewed_at     timestamptz,
  decline_reason  text,
  -- Set once approved and provisioned.
  business_id     uuid references businesses(id) on delete set null,
  -- Lets an applicant return to their status page without an account.
  status_token_hash text not null,
  created_at      timestamptz not null default now()
);
create unique index member_applications_email_open_idx
  on member_applications (lower(contact_email))
  where status in ('submitted', 'reviewing', 'waitlisted');
create index on member_applications (status, created_at desc);
create index on member_applications (zone_id);
create unique index on member_applications (status_token_hash);

-- The products an applicant expects to buy, which is what makes the savings
-- estimate specific rather than a brochure number.
create table application_products (
  id             uuid primary key default gen_random_uuid(),
  application_id uuid not null references member_applications(id) on delete cascade,
  product_id     uuid not null references products(id) on delete cascade,
  monthly_cases  numeric(10,2) not null check (monthly_cases > 0),
  unique (application_id, product_id)
);

commit;
