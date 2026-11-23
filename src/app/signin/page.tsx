import Link from "next/link";
import { redirect } from "next/navigation";

import { SignInForm } from "./form";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Sign in — 90 Express" };

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await getSessionUser();
  if (user) redirect("/");

  const { next } = await searchParams;
  // Only ever hand an in-app path to the form.
  const safeNext =
    next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

  return (
    <div className="mx-auto max-w-sm pt-10">
      <h1 className="text-2xl font-semibold tracking-tight text-hi">Sign in</h1>
      <p className="mt-2 text-sm text-mid">
        For members and 90 Express operators.
      </p>
      <div className="mt-6">
        <SignInForm next={safeNext} />
      </div>
      <p className="mt-6 text-xs leading-relaxed text-low">
        Not a member yet?{" "}
        <Link href="/join" className="text-mid underline hover:text-signal">
          Apply to join a zone
        </Link>
        . If you were approved but have no password, use the invite link we sent
        you — it expires after 14 days, and we can issue a new one.
      </p>
    </div>
  );
}
