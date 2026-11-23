-- Fee model becomes an explicit, per-cycle, recorded decision.
--
-- Added after the first seeded settlements showed that a percentage-of-spend
-- procurement fee bills the most to the member who gains the least: the
-- largest buyer in a zone, which is already at its own volume break and whose
-- volume is what makes the pool work. See src/lib/crs/settlement.ts.

begin;

create type fee_model as enum ('spend_bps', 'savings_share');

alter table pool_cycles
  add column fee_model fee_model not null default 'savings_share',
  -- Share of verified savings, in basis points. 2000 = 20%.
  add column savings_share_bps integer not null default 2000;

alter table settlements
  add column fee_model fee_model not null default 'savings_share',
  add column savings_share_fee_cents integer not null default 0,
  -- Savings before 90 Express takes anything. Stored so a member can audit
  -- the fee against the benefit it was charged on.
  add column gross_savings_cents integer not null default 0;

comment on column pool_cycles.fee_model is
  'spend_bps charges a share of spend; savings_share charges a share of verified savings and is capped so fees can never exceed savings.';

commit;
