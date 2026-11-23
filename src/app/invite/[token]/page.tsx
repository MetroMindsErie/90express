import { notFound } from "next/navigation";

import { InviteForm } from "./form";
import { hashToken } from "@/lib/auth/crypto";
import { sql } from "@/lib/db/client";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Set your password — 90 Express",
  robots: { index: false, follow: false },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const [user] = await sql<
    Array<{ display_name: string; email: string; business_name: string | null }>
  >`
    select u.display_name, u.email, coalesce(b.dba, b.legal_name) as business_name
    from users u
    left join businesses b on b.id = u.business_id
    where u.invite_token_hash = ${hashToken(token)}
      and u.invite_expires_at > now()
  `;

  if (!user) notFound();

  return (
    <div className="mx-auto max-w-sm pt-10">
      <p className="eyebrow mb-2">Welcome to 90 Express</p>
      <h1 className="text-2xl font-semibold tracking-tight text-hi">
        Set your password
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-mid">
        {user.business_name ? (
          <>
            This signs you in as <strong className="text-hi">{user.display_name}</strong>{" "}
            for <strong className="text-hi">{user.business_name}</strong>.
          </>
        ) : (
          <>
            This signs you in as <strong className="text-hi">{user.display_name}</strong>.
          </>
        )}{" "}
        Next you will read and accept the member agreement, which is what
        activates the membership.
      </p>
      <div className="mt-6">
        <InviteForm token={token} />
      </div>
      <p className="mt-6 text-xs leading-relaxed text-low">
        This link works once and expires 14 days after it was issued. Use at
        least 12 characters; a passphrase of a few words beats a short, clever
        one.
      </p>
    </div>
  );
}
