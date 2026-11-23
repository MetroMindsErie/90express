"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef } from "react";

import { setViewAs, signOut } from "@/lib/onboarding/actions";

const MEMBER_NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/pools", label: "CRS Exchange" },
  { href: "/inventory", label: "Inventory" },
  { href: "/agent", label: "Agent" },
  { href: "/freight", label: "Freight" },
  { href: "/catalog", label: "Catalog" },
];

const OPERATOR_NAV = [
  { href: "/network", label: "Network" },
  { href: "/operator/applications", label: "Applications" },
  { href: "/integrations", label: "Integrations" },
  { href: "/economics", label: "Unit Economics" },
];

export function Nav({ role }: { role: "member" | "operator" }) {
  const pathname = usePathname();
  const items = role === "operator" ? [...MEMBER_NAV, ...OPERATOR_NAV] : MEMBER_NAV;

  return (
    <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Main">
      {items.map((item) => {
        const active =
          item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded px-2.5 py-1.5 text-[13px] font-medium transition-colors ${
              active
                ? "bg-ink-800 text-hi"
                : "text-mid hover:bg-ink-850 hover:text-hi"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Operator support view.
 *
 * An operator can look at a member's console; a member never sees this. The
 * header says whose console is on screen, so it is a labelled view rather
 * than a silent impersonation.
 */
export function ViewAsSwitcher({
  businesses,
  currentId,
}: {
  businesses: Array<{ id: string; name: string; zone: string }>;
  currentId: string | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form ref={formRef} action={setViewAs} className="flex items-center gap-2">
      <label htmlFor="viewAsBusiness" className="eyebrow hidden sm:block">
        Viewing
      </label>
      <select
        id="viewAsBusiness"
        name="businessId"
        defaultValue={currentId ?? ""}
        onChange={() => formRef.current?.requestSubmit()}
        className="max-w-[15rem] truncate rounded border border-signal/50 bg-ink-850 px-2 py-1.5 text-[13px] text-hi hover:border-signal"
      >
        <option value="">No member selected</option>
        {businesses.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name} — {b.zone}
          </option>
        ))}
      </select>
      <noscript>
        <button
          type="submit"
          className="rounded border border-ink-600 px-2 py-1.5 text-xs text-hi"
        >
          View
        </button>
      </noscript>
    </form>
  );
}

export function UserMenu({
  displayName,
  email,
  role,
}: {
  displayName: string;
  email: string;
  role: "member" | "operator";
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="hidden text-right leading-tight sm:block">
        <p className="text-[13px] font-medium text-hi">{displayName}</p>
        <p className="text-[11px] text-low" title={email}>
          {role === "operator" ? "90 Express operator" : "Member"}
        </p>
      </div>
      <form action={signOut}>
        <button
          type="submit"
          className="rounded border border-ink-600 px-2.5 py-1.5 text-xs font-semibold text-mid transition-colors hover:border-ink-500 hover:text-hi"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}

export function Mark({ href = "/" }: { href?: string }) {
  return (
    <Link href={href} className="flex shrink-0 items-center gap-2.5">
      {/* Interstate shield, because the corridor is the product. */}
      <svg width="26" height="28" viewBox="0 0 26 28" aria-hidden="true">
        <path
          d="M13 1.5 C9 1.5 5 3 1.5 4.2 L1.5 14 C1.5 20.5 6.5 25 13 26.5 C19.5 25 24.5 20.5 24.5 14 L24.5 4.2 C21 3 17 1.5 13 1.5 Z"
          fill="var(--ink-800)"
          stroke="var(--signal)"
          strokeWidth="1.5"
        />
        <text
          x="13"
          y="18"
          textAnchor="middle"
          fill="var(--signal)"
          fontSize="11"
          fontWeight="700"
          fontFamily="var(--font-mono)"
        >
          90
        </text>
      </svg>
      <span className="leading-tight">
        <span className="block text-sm font-semibold tracking-tight text-hi">
          90 Express
        </span>
        <span className="block text-[10px] uppercase tracking-[0.12em] text-low">
          Consumer Road Share
        </span>
      </span>
    </Link>
  );
}
