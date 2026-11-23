# Connecting a supplier or a carrier

This is the document to hand a distributor's IT contact or a carrier's
dispatcher. It describes exactly what 90 Express needs from them, in order of
how little work it is.

Reference implementation: [`tools/mock-partners/server.ts`](../tools/mock-partners/server.ts).
Run `npm run mock-partners` and point a provider at `http://localhost:4010` to
see every exchange working before a real partner is involved.

---

## Three ways in, and none of them require an API

| Transport | What the partner does | What we get |
| --- | --- | --- |
| `csv` | Emails or drops a price sheet | Catalog and volume ladders |
| `http` | Exposes a small JSON API | Catalog, quotes, orders, rates, tenders, tracking, invoices |
| `manual` | Nothing | A provider record, so a stale catalog is visible rather than invisible |

Most independent distributors are `csv` on day one. That is fine: the pooled
pricing engine only needs the ladder, and a weekly spreadsheet carries it.

**Credentials are never stored in the database.** A provider row records the
*name* of the environment variable holding its token (`auth_env_var`); the
value lives in the environment. Nothing in the app can print a token.

---

## Option 1 — a price sheet (`csv`)

One row per orderable case, these columns, header names matched by name so the
column order can change without breaking anything:

```
sku,name,category,pack_description,cases_per_pallet,case_weight_lb,list_price,temp_class,discontinued,tier_1_min,tier_1_price,tier_2_min,tier_2_price,tier_3_min,tier_3_price
```

- `list_price` is the single-buyer price. `$28.50`, `28.50` and `1,234.56` all parse.
- `tier_n_min` / `tier_n_price` are the volume breaks, up to six pairs. **These
  are the whole point** — pooling only beats individual buying where a ladder
  exists.
- `temp_class` is `dry`, `chill` or `frozen`.
- `discontinued` is `Y` to withdraw a SKU. A SKU simply absent from the sheet
  is also treated as withdrawn.
- Quoted fields, embedded commas, doubled quotes (`"9"" Clamshell"`), CRLF line
  endings and the BOM Excel adds are all handled.

Example: [`db/fixtures/catawba-price-sheet.csv`](../db/fixtures/catawba-price-sheet.csv).

A row that fails validation names the row number and SKU and stops the sync.
Nothing partially imports.

---

## Option 2 — a JSON API (`http`)

All money is **integer cents**. All requests carry
`Authorization: Bearer <token>`. Responses are validated before anything is
stored; a payload that fails validation is rejected whole.

### Supplier

**`GET /supplier/{ref}/catalog`**

```json
{
  "items": [{
    "sku": "OIL-35",
    "name": "Fryer Oil, 35 lb",
    "category": "oils_fats",
    "packDescription": "1/35 lb jug",
    "casesPerPallet": 48,
    "caseWeightLb": 36,
    "listPriceCents": 3140,
    "tempClass": "dry",
    "tiers": [
      { "minCases": 50,   "unitPriceCents": 2985 },
      { "minCases": 250,  "unitPriceCents": 2720 },
      { "minCases": 1000, "unitPriceCents": 2510 }
    ],
    "discontinued": false
  }]
}
```

**`POST /supplier/{ref}/quote`** — price a pooled order.

```json
{ "lines": [{ "sku": "OIL-35", "totalCases": 400 }], "deliveryDate": "2026-12-04" }
```
```json
{
  "quoteRef": "Q-12345",
  "validUntil": "2026-12-01T00:00:00Z",
  "lines": [{ "sku": "OIL-35", "totalCases": 400, "grantedUnitCents": 2690 }],
  "minimumMet": true
}
```

`grantedUnitCents` may beat or miss the published ladder. Both are recorded, and
a quote that misses is shown to members as the worse number rather than hidden.

**`POST /supplier/{ref}/orders`** — release the collective order. Carries an
`Idempotency-Key` header; replaying it must return the first response rather
than creating a second order. Each line carries a `buyerRef` so the supplier can
invoice each member separately at the one negotiated price — **this is the part
that makes the whole arrangement work.**

### Carrier

**`POST /carrier/{ref}/rates`**

```json
{
  "origin": { "lat": 35.205, "lng": -80.88 },
  "stops": [{ "ref": "a1b2c3d4", "lat": 35.586, "lng": -80.813,
              "pallets": 4, "weightLb": 1440, "liftgate": true }],
  "pickupDate": "2026-12-03",
  "equipment": "dry_van"
}
```
```json
{ "quotes": [{ "quoteRef": "R-9", "linehaulCents": 47700, "accessorialCents": 34500,
               "totalCents": 82200, "transitDays": 1 }] }
```

Stops are identified by an opaque `ref`. **Partners never receive member
names, addresses or contact details** — only the coordinates needed to route.

**`POST /carrier/{ref}/tenders`** — same body plus `shipmentRef` and
`quoteRef`, with an `Idempotency-Key`. Responds `accepted` or `declined` with a
reason. A decline is a normal outcome and is shown to the operator.

**`GET /carrier/{ref}/tenders/{tenderRef}/tracking`**

```json
{ "events": [{ "externalRef": "T-9-ARR-1", "code": "delivered",
               "message": "Stop 1 delivered and signed.",
               "occurredAt": "2026-12-03T13:12:00Z",
               "stopSequence": 1, "signedBy": "Receiving" }] }
```

`externalRef` must be stable per event: it is the deduplication key, so the
feed can be polled as often as you like.

**`GET /carrier/{ref}/invoices?since=ISO`** — billed charges, matched back to
the tender. See reconciliation below.

---

## What the system does with it

### Catalog changes are proposals, never edits

A feed cannot move a price under a live pool. Every incoming difference lands
in `catalog_changes` with `status = 'pending'` and an operator applies it. Each
proposal is staged with its blast radius: how many open cycles it touches, how
many cases are already committed, and what it does to those members' cost.

A new sync supersedes the previous sync's untouched proposals, so a week-old
price cannot be applied by accident.

Prices already negotiated on a cycle live in `negotiated_prices` and are never
touched by any feed.

Change types and why each matters:

| Type | Why it needs a human |
| --- | --- |
| `price` | Members committed at the old number |
| `tier` | A withdrawn break changes what pooling is worth |
| `pack` | Cases per pallet drives freight allocation for *everyone* on the load |
| `new_product` | Nothing breaks, but someone should decide to carry it |
| `discontinued` | If cases are committed, those members have no source |

### Rated quotes replace the benchmark

Every savings figure in this system was measured against `LTL_BENCHMARK` — a
planning estimate, labelled as such everywhere it appeared. Rating a cycle asks
the carrier to price both the consolidated load *and* each member's order
shipped alone. Those per-member quotes replace the benchmark in that member's
counterfactual, and the settlement switches from "Buying alone (est.)" to
"Buying alone (quoted)".

That is the single most valuable thing this integration buys: a savings number
that can go in front of a member without a disclaimer.

The quote is stored alongside the contract-rate estimate it replaced, so drift
between the rate card and the live market is visible. On the seeded corridor a
rated load came back **$86 above** the contract-rate estimate — the kind of gap
that quietly turns a modelled saving into a real loss.

### Tenders cannot double-offer

The idempotency key is derived (`tender:{shipmentId}:{carrierId}`), not random.
A retry, a double-click or a replayed webhook finds the existing tender and
refuses. A load that has already left cannot be tendered at all.

### Invoices are reconciled against what members were billed

Members are given a freight figure at settlement. When the carrier's invoice
arrives it is matched to the tender and compared with the sum actually
allocated to members:

```
variance = invoice total − allocated to members
```

Within $5 it is `matched`. Beyond that it is a `variance` and waits for a
human: **absorb** it or **dispute** it. It is never silently re-billed to
members who were already given a number. An invoice that matches no tender we
issued is held, not paid.

Detention, redelivery and reweighs are the usual causes, and they are exactly
what gets missed when freight bills are approved in bulk.

---

## Onboarding a real partner

1. Add the provider: partner kind, adapter, `partner_ref`, base URL, and the
   **name** of the env var holding the token.
2. Put the token in the environment. Never in the database, never in the repo.
3. Run a catalog sync from `/integrations` and review what it stages. The first
   sync of a supplier we already carry will stage a lot; that is the point.
4. For a carrier, rate one cycle and compare the quote against the contract
   rate before tendering anything.
5. Watch `failed_runs_7d` on the provider row. A partner that silently stops
   responding is the failure mode that costs money, because the catalog goes
   stale without anyone noticing.

## Not built yet

- **EDI (X12 850/855/856/214/210).** Larger distributors and carriers will want
  it rather than JSON. The adapter interface is the right seam: an `edi`
  adapter implements the same `SupplierAdapter` / `CarrierAdapter` contract and
  nothing above it changes.
- **Scheduled syncs.** `sync_interval_minutes` is recorded but nothing runs it;
  operations are manual from the console today.
- **Webhooks.** Tracking is pulled, not pushed. Pull is correct to start with —
  it needs no public endpoint and the dedup key makes it free to repeat.
- **Supplier order release.** `submitOrder` is implemented in the adapter and
  exercised against the mock, but is not yet wired to a button; releasing a
  real PO should wait until member agreements define the commitment.
