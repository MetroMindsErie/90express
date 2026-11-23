import Link from "next/link";
import type { ReactNode } from "react";

import { formatCents } from "@/lib/crs/money";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-ink-700 bg-ink-900 ${className}`}
    >
      {children}
    </div>
  );
}

export function CardHead({
  title,
  sub,
  right,
}: {
  title: ReactNode;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-ink-700 px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-hi">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-mid">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

export function PageHead({
  eyebrow,
  title,
  sub,
  right,
}: {
  eyebrow?: string;
  title: string;
  sub?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        <h1 className="text-2xl font-semibold tracking-tight text-hi">{title}</h1>
        {sub ? <p className="mt-1.5 max-w-3xl text-sm text-mid">{sub}</p> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </header>
  );
}

type Tone = "neutral" | "signal" | "guide" | "alert" | "route";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-ink-700 text-mid",
  signal: "bg-signal-dim text-signal",
  guide: "bg-guide-dim text-guide",
  alert: "bg-alert-dim text-alert",
  route: "bg-route-dim text-route",
};

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${toneClasses[tone]}`}
    >
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  open: "guide",
  locked: "signal",
  negotiated: "signal",
  confirmed: "route",
  shipped: "route",
  in_transit: "route",
  delivered: "neutral",
  failed: "alert",
  planned: "neutral",
  tendered: "route",
  accepted: "route",
  out_for_delivery: "signal",
  exception: "alert",
  pending: "signal",
  auto_approved: "guide",
  approved: "guide",
  rejected: "alert",
  committed: "route",
  draft: "neutral",
  expired: "neutral",
  cancelled: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={statusTone[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  const valueTone =
    tone === "guide"
      ? "text-guide"
      : tone === "alert"
        ? "text-alert"
        : tone === "signal"
          ? "text-signal"
          : "text-hi";
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900 px-4 py-3">
      <p className="eyebrow">{label}</p>
      <p className={`num mt-2 text-2xl font-semibold ${valueTone}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs leading-snug text-mid">{sub}</p> : null}
    </div>
  );
}

/** Money with a sign and colour that follows whether it helps the member. */
export function Money({
  cents,
  signed = false,
  className = "",
}: {
  cents: number;
  signed?: boolean;
  className?: string;
}) {
  const tone = !signed
    ? ""
    : cents > 0
      ? "text-guide"
      : cents < 0
        ? "text-alert"
        : "text-mid";
  const prefix = signed && cents > 0 ? "+" : "";
  return (
    <span className={`num ${tone} ${className}`}>
      {prefix}
      {formatCents(cents)}
    </span>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({
  children,
  right = false,
  className = "",
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`eyebrow border-b border-ink-700 px-3 py-2 ${right ? "text-right" : "text-left"} ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right = false,
  className = "",
  colSpan,
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      className={`border-b border-ink-800 px-3 py-2 align-middle ${right ? "text-right" : ""} ${className}`}
    >
      {children}
    </td>
  );
}

/** Horizontal progress toward a target, e.g. a supplier order minimum. */
export function Meter({
  value,
  target,
  tone = "signal",
}: {
  value: number;
  target: number;
  tone?: "signal" | "guide" | "route";
}) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 100;
  const bar =
    tone === "guide" ? "bg-guide" : tone === "route" ? "bg-route" : "bg-signal";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700"
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-sm text-low">{children}</div>
  );
}

/**
 * Flags a figure that comes from a benchmark rather than a quote.
 *
 * Used wherever a savings number depends on the LTL estimate, so nobody
 * carries one of these into a contract thinking it was rated.
 */
export function EstimateNote({ children }: { children: ReactNode }) {
  return (
    <p className="mt-3 flex gap-2 border-l-2 border-ink-600 pl-3 text-xs leading-relaxed text-low">
      <span className="font-semibold text-mid">Estimate</span>
      <span>{children}</span>
    </p>
  );
}

export function LinkButton({
  href,
  children,
  tone = "neutral",
}: {
  href: string;
  children: ReactNode;
  tone?: "neutral" | "signal";
}) {
  const cls =
    tone === "signal"
      ? "bg-signal text-ink-950 hover:bg-signal/90"
      : "border border-ink-600 text-hi hover:border-ink-500 hover:bg-ink-800";
  return (
    <Link
      href={href}
      className={`inline-flex items-center rounded px-3 py-1.5 text-xs font-semibold transition-colors ${cls}`}
    >
      {children}
    </Link>
  );
}

export function dow(n: number): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][n] ?? "—";
}

export function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function fmtDateTime(d: Date | string): string {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** "in 3 days" / "2 days ago" — relative, for cycle windows. */
export function relDays(d: Date | string): string {
  const ms = new Date(d).getTime() - Date.now();
  const days = Math.round(ms / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export function titleCase(s: string): string {
  return s
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
