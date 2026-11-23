# 90 Express — Consumer Road Share

Collective purchasing and freight consolidation for independent operators on the
I-77 corridor between Charlotte and Statesville.

90 Express aggregates a zone's purchasing demand into one negotiated order with
a supplier, and the resulting goods onto one consolidated truck. **It does not
take title to the goods.** Members contract and pay suppliers directly; 90
Express earns a disclosed coordination fee and membership revenue. That keeps
inventory risk, working capital and product liability off the balance sheet
while the network is being proven.

This repository is a working pilot system, not a prototype: the pricing,
freight allocation and settlement arithmetic is real, tested, and is what the
screens display.

---

## Running it

Requires Node 20+ and a local Postgres.

```bash
npm install
```

```bash
createdb ninety_express
```

```bash
npm run db:migrate
```

```bash
npm run seed
```

```bash
npm run dev
```

To exercise the supplier and carrier integrations, run the mock partner
endpoints in a second shell and point the seeded providers at them:

```bash
npm run mock-partners
```

```bash
MOCK_PARTNER_TOKEN=dev-partner-token npm run integrations:run
```

Set `DATABASE_URL` in `.env.local` to point elsewhere (the schema runs on
Supabase unchanged). Run the engine test suite with:

```bash
npm test
```

Sign in at `/signin`. The account seed prints its credentials and refuses to
run in production:

- `operator@90express.test` — operator: the whole network, applications,
  integrations and unit economics
- `dana@brawleystreetkitchen.test` — a member with inventory, an active agent
  and a settled cycle
- password: `corridor-pilot-2026` (override with `SEED_PASSWORD`)

To walk the join funnel, apply at `/join` with a corridor ZIP, then review it
as the operator. See [`docs/ONBOARDING.md`](docs/ONBOARDING.md).

---

## The model

```
members commit demand  →  one negotiated supplier order  →  one consolidated load
      (they keep title)        (supplier invoices each)        (carrier bills, we allocate)
```

A **zone** is a set of members close enough that one truck can serve them in a
morning. A **pool cycle** is one zone buying from one supplier in one window.
Members commit case quantities while the window is open; at close, the pooled
quantity determines which of the supplier's volume breaks the order reaches, and
that price is negotiated and recorded. The goods move on one truck with several
drops, and the carrier's charge is divided across the members on it.

### Five modules

| Module | Where |
| --- | --- |
| Business Network | `/network` — zones, members, carriers, membership plans |
| Supplier Network | `/catalog` — wholesale catalogs and volume ladders |
| CRS Marketplace | `/pools` — collective ordering, demand board, settlement |
| ZoneMap | `/network` — corridor map, service radii, delivery days |
| Freight Management | `/freight` — loads, routed stops, allocation, tracking |

Plus `/inventory`, `/agent` (autonomous replenishment), `/integrations`
(supplier and carrier connections), `/operator/applications` (the join
funnel) and `/economics` (operator view of unit economics).

### Member onboarding

`apply → match a zone → honest estimate → review → invite → accept terms →
active`. Full detail in [`docs/ONBOARDING.md`](docs/ONBOARDING.md).

- **The estimate is the product.** An applicant declares what they buy and
  sees what joining is worth, computed by the settlement engine against the
  zone's real committed volume — one estimate per supplier the zone trades
  with, merged, because a member is a stop on each of those trucks.
- **It is built to say no.** It warns when the applicant's own volume already
  clears the same break, when the zone has too few stops for a truck to beat
  LTL, when their freight share would exceed their own LTL, and when the
  figure still rests on a benchmark. Telling someone up front costs one
  signup; letting them find out from their own invoices costs the member.
- **The estimate is snapshotted** onto the application, so the number a member
  joined on still exists when they ask about it — and the reviewing operator
  sees exactly what the applicant was shown.
- **The waitlist is a planning instrument.** An applicant outside every active
  zone is held against the nearest one, grouped by zone for the operator. That
  density is what decides which planned zone opens next.
- **Accounts** use Node's own crypto: scrypt at OWASP parameters, hashed
  session and invite tokens, constant-time verification, generic sign-in
  errors, per-account lockout. Members see only their own business; operators
  may view a member's console behind a banner that says so.

### Supplier and carrier integrations

Catalogs come in, rates and tenders go out. Full partner contract in
[`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md).

- **Three transports.** `csv` for a distributor that emails a price sheet,
  `http` for one with an API, `manual` for one with neither — still a provider,
  so a stale catalog is visible instead of invisible.
- **Catalog changes are proposals, never edits.** A feed cannot move a price
  under a live pool. Each change is staged with its blast radius: open cycles
  touched, cases already committed, and the cost to those members. An operator
  applies or rejects it.
- **Rated quotes replace the benchmark.** Rating a cycle prices the
  consolidated load *and* each member's order shipped alone. Those per-member
  quotes replace `LTL_BENCHMARK` in the counterfactual, and the settlement
  switches from "Buying alone (est.)" to "Buying alone (quoted)". This is the
  point of the whole integration layer — it removes the disclaimer that sat
  under every savings figure.
- **Tenders cannot double-offer.** The idempotency key is derived from the
  shipment and carrier, not random, and a load that has already left cannot be
  tendered.
- **Invoices are reconciled.** The carrier's bill is matched to the tender and
  compared with what members were actually billed. A variance waits for a human
  to absorb or dispute; it is never silently re-billed to members who were
  already given a number.

Partners receive opaque stop references — never member names, addresses or
contact details. Credentials are never stored in the database: a provider
records the *name* of the environment variable holding its token.

---

## Two findings that changed the design

Both came out of running the engine against seeded corridor data. They are
documented in full in [`docs/MODEL.md`](docs/MODEL.md) and visible live at
`/economics`.

**1. A percentage-of-spend fee bills the most to the member who gains the
least.** The fee scales with spend; the benefit scales with how far pooling
moves a member up the volume ladder. The largest buyer in a zone usually already
clears the break on its own volume, so it gains least and pays most — and it is
the member whose volume pulls everyone else past the break. On the seeded
cycles, a 2.5%-of-spend schedule bills **$2,757 against $3,475 of value
created** (a 134% capture rate on one cycle) and leaves 8 member-cycles worse
off than buying alone.

The system therefore supports two fee models and defaults to `savings_share`:
a share of *verified* savings, capped so a fee can never exceed what the pool
saved. Nothing saved, nothing charged.

**2. A zone needs a minimum number of stops before a truck is worth
tendering.** On a corridor this short both sides of the comparison sit at a
carrier minimum, so distance barely matters — what matters is how many members
share the truckload minimum. At the benchmark rates, consolidation loses to
separate LTL at 2 stops and wins from 3 upward, widening with each stop.

Worse, plain pallet-share allocation can bill the anchor member *more* than its
own LTL would cost. The platform allocates with `ltl_capped`: no member is
billed above its own LTL benchmark, and the excess is redistributed across
members still below theirs. When the caps together cannot cover the truck,
the load is reported as not worth tendering rather than quietly billed out —
one seeded cycle trips exactly this.

---

## Architecture

```
src/lib/crs/          the engine — pure, tested, no I/O
  pricing.ts          volume ladders, demand aggregation, per-member savings
  freight.ts          load building, cost allocation, LTL caps, benchmarks
  settlement.ts       per-member bills, fee models, participant screening
  agent.ts            autonomous replenishment planner + reasoning trace
  geo.ts              corridor distances and stop sequencing
  money.ts            integer-cent arithmetic and exact allocation
src/lib/auth/         scrypt hashing, sessions, role guards
src/lib/onboarding/   application funnel, zone matching, savings estimate
src/lib/integrations/ partner adapters — everything inbound is untrusted
  types.ts            contracts + zod schemas validated at the boundary
  adapters.ts         csv / http / manual supplier and carrier adapters
  diff.ts             catalog diffing, pure and tested
  sync.ts             sync, rate, tender, track, reconcile; run logging
src/lib/db/           plain-SQL data access; economics is computed, not stored
src/app/              Next.js App Router pages and server actions
db/migrations/        portable Postgres DDL (runs on Supabase unchanged)
db/seed.ts            I-77 pilot corridor; shipments computed by the engine
tools/mock-partners/  reference partner endpoints, used by the end-to-end run
```

Three rules the codebase holds to:

- **Money is integer cents.** `allocateCents` uses largest-remainder so split
  charges sum exactly to the carrier's invoice. Allocation disputes start with
  a lost penny.
- **Economics is computed, never trusted from storage.** Pool prices, freight
  allocation and settlements are derived from current rows by the engine, so a
  catalog change is reflected immediately and every figure on screen is
  reproducible. Only negotiated prices and issued settlements are frozen.
- **Estimates are labelled as estimates.** Every savings figure depends on a
  benchmark LTL rate (`LTL_BENCHMARK` in `freight.ts`), not a rated quote. The
  UI says so wherever such a figure appears.

### Autonomous replenishment

The agent is deterministic arithmetic, not a language model: days-of-cover
against par, projected stock at delivery, the zone's pooled quantity for
pricing, then budget and category checks. Every run emits a numbered reasoning
trace that a member can check by hand, visible at `/agent`. An owner sets a
cycle budget and an auto-approval limit; anything larger waits for them.

An LLM belongs in this system later — reading supplier price sheets and emails,
handling substitutions, negotiating — but not in the reorder arithmetic, where
being checkable matters more than being clever.

### Payments

Deliberately not built. Members pay suppliers directly today, which is what
makes the no-title structure work. Agent-authorised payment rails (Visa
Intelligent Commerce and similar) attach at the approval step in
`decideProposal` when eligibility and onboarding are confirmed — the agent is
designed independently of any one payment provider.

---

## Status

| Built | Not built |
| --- | --- |
| Pooled pricing, volume ladders, demand aggregation | Email (invites are handed over by the operator) |
| Freight consolidation, routing, cost allocation, LTL caps | EDI (X12 850/855/856/214/210) |
| Settlement, two fee models, participant screening | Payments and member invoicing |
| Autonomous replenishment with reasoning traces | Real routing distances (OSRM/PC\*MILER) |
| Corridor ZoneMap, freight tracking | Scheduled syncs (interval recorded, nothing runs it) |
| Supplier catalog sync with staged review | Supplier PO release wired to a button |
| Carrier rating, tendering, tracking, invoice reconciliation | Multi-supplier pooling in one cycle |
| Member onboarding, accounts, roles, member agreement | Password reset, 2FA, edge rate limiting |
| 147 tests across engine, integrations and onboarding | Notifications and mobile |

Seeded businesses, suppliers and carriers are fictional. Prices and volume
ladders are plausible food-service figures used to exercise the engine, not
quotes from any real distributor.

90 Express LLC — I-77 corridor pilot.
