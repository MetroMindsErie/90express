"use client";

import { useActionState, useMemo, useState } from "react";

import { submitApplication, type ApplyState } from "@/lib/onboarding/actions";
import { Card, CardHead, titleCase } from "@/components/ui";

type FormProduct = {
  id: string;
  sku: string;
  name: string;
  category: string;
  pack: string;
  supplier: string;
  listPriceCents: number;
};

const SEGMENTS = [
  "full_service_restaurant",
  "quick_service",
  "pizzeria",
  "bbq",
  "cafe",
  "diner",
  "seafood",
  "caterer",
  "bakery",
  "food_truck",
  "convenience_store",
  "other",
];

export function ApplicationForm({
  products,
  postalCodes,
}: {
  products: FormProduct[];
  postalCodes: string[];
}) {
  const [state, formAction, pending] = useActionState<ApplyState, FormData>(
    submitApplication,
    { ok: false },
  );
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<string, string>>({});

  const bySupplier = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? products.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            p.sku.toLowerCase().includes(needle) ||
            p.category.toLowerCase().includes(needle),
        )
      : products;
    const groups = new Map<string, FormProduct[]>();
    for (const p of filtered) {
      const list = groups.get(p.supplier);
      if (list) list.push(p);
      else groups.set(p.supplier, [p]);
    }
    return [...groups.entries()];
  }, [products, query]);

  const chosenCount = Object.values(selected).filter(
    (v) => Number(v) > 0,
  ).length;

  const err = (field: string) => state.fieldErrors?.[field];

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <div
          role="alert"
          className="rounded-lg border border-alert/50 bg-alert-dim/40 px-4 py-3 text-sm text-alert"
        >
          {state.error}
        </div>
      ) : null}

      <Card>
        <CardHead
          title="Your business"
          sub="We use the ZIP code to work out which zone you fall in. Nothing leaves this system."
        />
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Field label="Legal name" name="legalName" required error={err("legalName")} />
          <Field label="Trading name" name="dba" placeholder="If different" />
          <div>
            <label htmlFor="segment" className="mb-1.5 block text-sm font-medium text-hi">
              What kind of operation
            </label>
            <select
              id="segment"
              name="segment"
              required
              defaultValue="full_service_restaurant"
              className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            >
              {SEGMENTS.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label
              htmlFor="requestedTier"
              className="mb-1.5 block text-sm font-medium text-hi"
            >
              Membership
            </label>
            <select
              id="requestedTier"
              name="requestedTier"
              defaultValue="standard"
              className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            >
              <option value="starter">Starter — one zone, manual ordering</option>
              <option value="standard">Standard — all zones, priority allocation</option>
              <option value="premium">Premium — adds autonomous replenishment</option>
            </select>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead title="Where you receive" />
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Field label="Street address" name="street" required error={err("street")} />
          <div>
            <label
              htmlFor="postalCode"
              className="mb-1.5 block text-sm font-medium text-hi"
            >
              ZIP code
            </label>
            <input
              id="postalCode"
              name="postalCode"
              required
              inputMode="numeric"
              list="corridor-zips"
              placeholder="28115"
              className="num w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            />
            <datalist id="corridor-zips">
              {postalCodes.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
            {err("postalCode") ? (
              <p className="mt-1 text-xs text-alert">{err("postalCode")}</p>
            ) : (
              <p className="mt-1 text-xs text-low">
                We serve {postalCodes.length} ZIP codes along I-77 today.
              </p>
            )}
          </div>
          <div>
            <label
              htmlFor="dockType"
              className="mb-1.5 block text-sm font-medium text-hi"
            >
              How a truck delivers
            </label>
            <select
              id="dockType"
              name="dockType"
              defaultValue="liftgate"
              className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            >
              <option value="dock">Loading dock</option>
              <option value="liftgate">Liftgate needed</option>
              <option value="ground">Ground level, no dock</option>
            </select>
            <p className="mt-1 text-xs text-low">
              This changes your freight cost, so it changes the estimate.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead
          title="What you buy"
          sub="Cases in a typical month. Rough is fine — this is what makes the estimate yours rather than a brochure number."
          right={
            <span className="eyebrow">
              {chosenCount} selected
            </span>
          }
        />
        <div className="border-b border-ink-700 px-4 py-3">
          <label htmlFor="product-search" className="sr-only">
            Search products
          </label>
          <input
            id="product-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by product, SKU or category"
            className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
          />
        </div>

        <div className="max-h-[28rem] overflow-y-auto">
          {bySupplier.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-low">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            bySupplier.map(([supplier, items]) => (
              <div key={supplier}>
                <p className="eyebrow sticky top-0 border-b border-ink-800 bg-ink-900 px-4 py-2">
                  {supplier}
                </p>
                <ul className="divide-y divide-ink-800">
                  {items.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-3 px-4 py-2.5 hover:bg-ink-850"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-hi">{p.name}</p>
                        <p className="text-xs text-low">
                          {p.sku} · {p.pack} · {titleCase(p.category)}
                        </p>
                      </div>
                      <label htmlFor={`cases_${p.id}`} className="sr-only">
                        Monthly cases of {p.name}
                      </label>
                      <input
                        id={`cases_${p.id}`}
                        name={`cases_${p.id}`}
                        type="number"
                        min={0}
                        max={100000}
                        placeholder="0"
                        value={selected[p.id] ?? ""}
                        onChange={(e) =>
                          setSelected((s) => ({ ...s, [p.id]: e.target.value }))
                        }
                        className="num w-20 shrink-0 rounded border border-ink-600 bg-ink-850 px-2 py-1 text-sm text-hi"
                      />
                      <span className="w-14 shrink-0 text-right text-xs text-low">
                        cs/mo
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <CardHead title="Who to contact" />
        <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
          <Field label="Your name" name="contactName" required error={err("contactName")} />
          <Field
            label="Email"
            name="contactEmail"
            type="email"
            required
            error={err("contactEmail")}
          />
          <Field label="Phone" name="phone" type="tel" />
          <div className="sm:col-span-2">
            <label htmlFor="notes" className="mb-1.5 block text-sm font-medium text-hi">
              Anything we should know
            </label>
            <textarea
              id="notes"
              name="notes"
              rows={3}
              maxLength={2000}
              placeholder="Current distributor, delivery windows, anything unusual about receiving"
              className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
            />
          </div>
        </div>
      </Card>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="rounded bg-signal px-5 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal/90 disabled:opacity-60"
        >
          {pending ? "Working out your number…" : "See what joining is worth"}
        </button>
        <p className="text-xs text-low">
          No payment details, no commitment. You will see the estimate before
          anyone contacts you.
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required,
  placeholder,
  error,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  error?: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-hi">
        {label}
        {required ? <span className="ml-1 text-low">*</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded border bg-ink-850 px-2.5 py-2 text-sm text-hi ${
          error ? "border-alert" : "border-ink-600"
        }`}
      />
      {error ? <p className="mt-1 text-xs text-alert">{error}</p> : null}
    </div>
  );
}
