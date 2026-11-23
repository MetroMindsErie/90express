# Member onboarding and accounts

How an operator on the corridor becomes a trading member, and how the app
knows who they are.

---

## The funnel

```
apply  →  match a zone  →  honest estimate  →  operator review
       →  provision + invite  →  set password  →  accept terms  →  active
```

Each step and where it lives:

| Step | Where | What happens |
| --- | --- | --- |
| Apply | `/join` (public) | Business details, receiving constraints, and the products they buy with monthly volumes |
| Match a zone | `corridor.ts` | ZIP → corridor centroid → the active zone whose radius covers it; otherwise waitlisted against the nearest zone |
| Estimate | `estimate.ts` | The real engine, against the zone's actual committed volume, per supplier, merged |
| Status | `/join/status/<token>` | The applicant's view, reachable without an account |
| Review | `/operator/applications` | The operator sees the same estimate and the caveats the applicant was shown |
| Provision | `approveApplication` | Business, member account, invite, inventory and agent policy in one transaction |
| Set password | `/invite/<token>` | Single-use, 14-day token; creates a session |
| Accept terms | `/terms` | Records the version; **this is what activates the membership** |

The business is created `pending` and becomes `active` only when the member
accepts the agreement. A pending member cannot be settled against, because
nobody has agreed to anything yet.

---

## The estimate is the product

Anyone can put a percentage on a landing page. What makes an applicant trust
this one is that it is computed by the same code that settles live cycles,
against the zone's real committed volume, and that it will tell them when
joining is not worth much.

For each supplier the zone trades with, the estimate takes that supplier's
most recent costed cycle and prices the applicant's declared volume twice:
at the break their own volume reaches, and at the break the zone's pooled
volume reaches with them added. Freight is priced by building the actual load
with the applicant as an extra stop and running the real allocator. The
per-supplier results are then merged — a member buys across suppliers and is a
stop on each of those trucks, and estimating against only the latest cycle
silently drops everything else they buy.

### It is built to say no

Five caveats, each tied to something the model genuinely can't deliver:

| Caveat | When | Why it matters |
| --- | --- | --- |
| `goods_flat` | Their own volume already clears the same break | Finding 1 in [MODEL.md](MODEL.md): the biggest operator gains least |
| `thin_zone` | Fewer than three stops on the load | Finding 2: a truck needs stops before it beats LTL |
| `freight_loss` | Their allocated share exceeds their own LTL | They are capped at their own cost, but delivery saves them nothing |
| `benchmark` | No carrier has rated their address | The figure can move once it is quoted |
| `no_history` | The zone has no pooled volume yet | The comparison is against themselves; it is a ceiling, not a forecast |

The estimate is snapshotted onto the application as JSON. If someone joins
because they were told $744 a month, that number still exists when they ask
about it in March — and the operator reviewing the application sees exactly
what the applicant was shown, caveats included.

### The waitlist is a planning instrument

An applicant outside every active zone is not rejected. They are waitlisted
against the nearest zone, and `/operator/applications` groups the waitlist by
zone with the towns involved. A planned zone — Rock Hill, today — opens when
enough operators near it are waiting. The waitlist is the demand signal that
decides it, so applying is itself the thing that moves it along.

---

## Accounts

No dependencies: Node's own `crypto`.

**Passwords** are scrypt at OWASP's floor (N=2¹⁷, r=8, p=1), each with its own
16-byte salt. The stored form is `scrypt$N$r$p$salt$hash`, self-describing so
the parameters can be raised later without invalidating existing hashes.
Verification is constant-time, and a malformed or missing hash returns false
rather than throwing — a user who never set a password behaves exactly like a
wrong password. Inputs are NFKC-normalised so a passphrase typed with combining
accents verifies against one typed precomposed.

**Sessions** are 32 bytes of CSPRNG output in an httpOnly, SameSite=Lax cookie;
the database stores only the SHA-256. Reading the sessions table does not let
anyone assume a session. They last 14 days and refresh lazily, at most hourly,
so a page read does not write on every request.

**Invite tokens** are stored hashed too, are single-use, and expire in 14 days.
Nothing emails yet, so the invite link is shown to the operator exactly once
after provisioning — the UI says so rather than implying a mail went out.

**Sign-in does not disclose whether an address is registered.** The same message
covers a missing account, an account with no password, and a wrong password.
The KDF runs even when no user matched, so response time does not leak
existence either. Eight failures locks the account for fifteen minutes.

**The `next` parameter is checked** — only in-app paths are followed, because an
open redirect on a sign-in page is a phishing primitive.

### Two roles

- **member** — their own business and nothing else. `getCurrentBusiness()`
  resolves from the session, so no page can be pointed at another member's
  data by changing a cookie or a form field.
- **operator** — the network pages (`/network`, `/economics`,
  `/integrations`, `/operator/applications`), and may view a member's console
  for support. That view is announced in a banner across the top of every
  page: *you are looking at X's console, and actions are recorded against
  them*. It is a labelled view, never a silent impersonation.

Every server action that writes on behalf of a business calls
`authorizeBusiness()`, which checks the session rather than trusting the
business id in the form.

---

## Running it

```bash
npm run db:migrate && npm run seed
```

The account seed refuses to run with `NODE_ENV=production`, because it sets a
known password on every account. It prints the credentials it created:

- `operator@90express.test` — operator, sees the whole network
- any seeded member's contact email, e.g. `dana@brawleystreetkitchen.test`
- password: `corridor-pilot-2026` (override with `SEED_PASSWORD`)

To walk the funnel yourself: apply at `/join` with a corridor ZIP (28115,
28117, 28078, 28031, 28036, 28625 …), then sign in as the operator to review
and approve, then follow the invite link it shows you.

---

## Not built yet

- **Email.** Nothing is sent. Invite links are handed to the operator to pass
  on. This is the first thing to add, and it is the reason the UI says so
  plainly rather than implying delivery.
- **Password reset.** An operator can reissue an invite by hand; there is no
  self-service reset.
- **Two-factor.** Worth having before this handles real purchasing authority.
- **Session management UI.** A member cannot see or revoke their own sessions.
- **Rate limiting at the edge.** Per-account lockout exists; there is no
  IP-level throttle, which a real deployment wants in front of `/signin`.
- **A real geocoder.** The ZIP table is deliberate — addresses never leave the
  system — but it means the corridor is extended by editing `corridor.ts`.
