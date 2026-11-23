# The CRS model, and what the numbers said about it

This document records the economic design of Consumer Road Share, the two
places where running real arithmetic contradicted the original plan, and what
was changed in response. Everything here is reproducible: the figures come from
`db/seed.ts` run through `src/lib/crs`, and the live versions are at
`/economics`.

---

## 1. The transaction

```
10 members commit demand
        ↓
one collective order, one negotiated price
        ↓
supplier invoices each member for its own allocation
        ↓
one consolidated load, several drops
        ↓
carrier invoices; 90 Express allocates the charge
        ↓
90 Express invoices its coordination fee
```

90 Express never holds title to goods and never holds member money. Three
parties get paid and only the fee line is revenue:

| Line | Owed to | Revenue to 90 Express |
| --- | --- | --- |
| Goods | Supplier | No |
| Freight | Carrier | No |
| Coordination fee | 90 Express | **Yes** |
| Membership | 90 Express | **Yes** |

This requires suppliers willing to invoice members separately while honouring
one negotiated volume price (`suppliers.invoices_members_separately`). Where a
supplier insists on a single purchaser and a single invoice, a properly
structured purchasing-agent arrangement is needed before that supplier can be
used — the schema records the distinction rather than assuming it away.

### What the member is actually buying

Two distinct things, which the economics keep separating:

1. **A better unit price**, from landing higher on the supplier's volume ladder
   than their own volume reaches.
2. **Cheaper delivery**, from sharing a truck instead of buying LTL alone.

These do not move together, they do not benefit the same members, and conflating
them is how a collective-purchasing pitch falls apart in diligence. The app
reports them separately on every settlement.

---

## 2. Finding one — the fee schedule was upside down

### What happened

The first seeded settlement run, with a conventional 2.5%-of-spend procurement
fee plus $25 per stop, produced this:

| Member | Goods | Goods saved | Fee | Net |
| --- | --- | --- | --- | --- |
| Pit Row BBQ | $2,017 | $124 | $75 | **+$149** |
| Brawley Street Kitchen | $3,985 | $92 | $125 | **+$38** |
| Catawba Catering Co. | $4,271 | $101 | $132 | **+$9** |
| Mooresville Pizza Works | $9,931 | $80 | $273 | **−$263** |

Mooresville Pizza Works is the **largest** buyer on the load and the only one
that loses money by participating.

### Why

A percentage-of-spend fee scales with how much a member buys. The benefit scales
with how far pooling moves that member up the volume ladder. Those are different
quantities, and for the largest member in a zone they point in opposite
directions:

- At 110 cases of flour and 96 of cheese, Pizza Works **already clears the
  supplier's volume break on its own**. Pooling moves its unit price by 0.8%.
- It has a loading dock, so its own LTL delivery is cheap, and its large pallet
  share means it absorbs most of the truckload linehaul.
- It pays the largest fee of anyone on the load.

So the member whose volume pulls the whole zone past the price break is the
member subsidising it. In a voluntary network that member does the arithmetic
and leaves — and when it leaves, the break it was funding goes with it.

### What changed

`settlement.ts` now takes a `FeeModel`:

- `spend_bps` — the original schedule, retained so historical cycles settle as
  they were agreed, and so the comparison can be shown.
- `savings_share` — a share of **verified** savings, measured against each
  member's own counterfactual and capped so the fee can never exceed what the
  pool delivered. Nothing saved, nothing charged.

Across the seeded cycles:

| | Spend-based @2.5% | Savings-share @20% |
| --- | --- | --- |
| Fee revenue | $2,757 | $695 |
| Value created for members | $3,475 | $3,475 |
| Capture rate | 79% (134% on one cycle) | 20% |
| Member-cycles left worse off by fees | 8 | 0 |

A capture rate above 100% means 90 Express would bill more than the pool saved.
That happened on a real seeded cycle.

Savings-share bills roughly a quarter as much today. That is the trade, and it
is the right one at this stage: the pilot's scarce resource is members willing
to commit volume, not fee revenue per cycle. The fee can be revisited once zone
density makes the savings large enough to share.

`screenParticipants()` runs this check per member before a cycle is confirmed,
and names the cause — `fees`, `freight` or `goods` — with a remedy for each.

---

## 3. Finding two — consolidation needs stops, not miles

### What happened

Checking each member's freight position against what its own LTL shipment would
have cost:

| Member | Allocated | Own LTL (est.) | Position |
| --- | --- | --- | --- |
| Mooresville Pizza Works | $255 | $185 | **−$70** |
| Cornelius Fish Camp | $236 | $185 | **−$51** |
| Huntersville Taco Shop | $249 | $280 | +$31 |
| Brawley Street Kitchen | $210 | $280 | +$70 |
| Pit Row BBQ | $180 | $280 | +$100 |

Consolidation saved **$280 in aggregate** across these stops — and still left
two members paying more than they would alone. Both are the dock-equipped,
high-pallet-share members. The aggregate was hiding the distribution.

### Why

Two carrier minimums are fighting each other:

- A truckload carrier charges a **minimum for the truck** — $450 here — whether
  it runs 25 miles or 150, plus a charge per stop.
- On a corridor this short, every member's own LTL shipment also prices at
  **its** carrier's minimum charge ($185), because 22¢ per pallet-mile over 40
  miles is nowhere near it.

So the comparison is one truckload minimum plus N stop charges against N
small-shipment minimums. **Distance barely enters into it. Stop count is the
variable.** At benchmark rates, with three pallets a member:

| Stops | Consolidated | Separate LTL | Difference |
| --- | --- | --- | --- |
| 2 | $690 | $560 | **−$130** |
| 3 | $810 | $840 | +$30 |
| 4 | $930 | $1,120 | +$190 |
| 6 | $1,170 | $1,680 | +$510 |
| 10 | $1,650 | $2,800 | +$1,150 |

Consolidation **loses** at two stops and wins from three upward, widening each
time. This is an operating threshold, not a theory: a zone below it should still
pool its purchasing — the volume break is untouched by any of this — but should
let members take their own delivery until the zone fills out.

### What changed

Two things.

**An allocation rule that cannot bankrupt the anchor member.**
`planLoad(..., "ltl_capped")` holds every member at or under its own LTL
benchmark and redistributes the excess across members still below theirs, by
pallet share, until it settles. The total still equals the carrier's charge
exactly — the pool never under-collects. This is now the platform default.

**An honest failure mode.** If the caps together cannot cover the truck, there
is no split that leaves everyone whole, and the load should not run as one
tender. `planLoad` says so in `warnings` rather than quietly billing it out.
One seeded cycle — Statesville, three stops on a reefer with a $580 minimum —
trips exactly this, which is the system working.

### The strategic read

Freight consolidation on a 25-to-50-mile corridor is thin. It earns its keep
when either:

- **the zone is dense** — six or more stops on a load, which is a membership
  target, not a freight problem; or
- **the sourcing is distant** — a manufacturer or regional DC several hundred
  miles out that no single member can reach economically, where the truckload
  rate per mile beats LTL decisively; or
- **the members are tiny** — operators who cannot clear LTL minimums at all and
  are paying parcel or distributor delivery fees today.

Until one of those holds, CRS is a purchasing club with a delivery convenience
attached, and should be sold as one. That is still a real business — the goods
savings on the seeded cycles are larger than the freight savings — but it is a
different pitch, and the difference matters when a prospective member checks the
numbers.

---

## 4. What the savings numbers depend on

> **Update.** The LTL benchmark below is now replaceable. Rating a cycle through
> a connected carrier (see [`INTEGRATIONS.md`](INTEGRATIONS.md)) prices each
> member's order shipped alone and substitutes that quote for the benchmark, and
> the settlement says which figure it used. On the first seeded run a rated load
> came back **$86 above** the contract-rate estimate — so this table is not
> hypothetical caution. Rate a cycle before quoting its savings to anyone.

Every "you saved" figure rests on a counterfactual, and the counterfactual rests
on assumptions. Stated plainly so nobody carries them into a contract:

| Assumption | Where | Risk |
| --- | --- | --- |
| LTL minimum charge $185 | `LTL_BENCHMARK` | A member with a negotiated carrier rate beats this, and their real saving is smaller |
| 22¢ per pallet-mile LTL | `LTL_BENCHMARK` | Varies widely by lane, class and density |
| Road miles = straight line × 1.15 | `geo.ts` | Fine for planning, wrong for billing a carrier |
| The member's solo tier price | `pricing.ts` | Assumes the supplier would honour its published ladder for a one-off buyer, which is optimistic |
| The supplier honours the negotiated price | `negotiated_prices` | Recorded per cycle so a miss is visible rather than absorbed |

The last one matters most. `buildPoolLines` lets a granted price override the
ladder **in either direction** — if the supplier comes back above the published
break, members see the worse number rather than the projection. A system that
can only report good news is not worth putting in front of a member who has
their own invoices.

---

## 5. Open questions for the pilot

1. **Will suppliers invoice members separately at one negotiated price?** The
   whole no-title structure depends on it. Worth confirming with one
   distributor before writing member agreements.
2. **What happens when a pool misses its minimum?** The schema releases the
   commitments and fails the cycle. The member agreement needs to say so, along
   with commitment deadlines, cancellation and who bears a short-load cost.
3. **What is the real stop threshold** against rated quotes from the carriers
   actually under contract, rather than benchmark rates?
4. **Does the zone's anchor member accept savings-share pricing**, now that it
   is the member the old schedule would have charged $273 to save $80?
