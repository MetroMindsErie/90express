/**
 * Sessions and access control.
 *
 * A session cookie holds a random token; the database holds its hash. Sessions
 * expire, are refreshed lazily, and are destroyed on sign-out.
 *
 * Two roles:
 *   member   — sees only their own business
 *   operator — sees the network, reviews applications, and may view a
 *              member's console for support. That view is explicit and
 *              labelled; it is not a silent impersonation.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { sql } from "@/lib/db/client";
import { generateToken, hashToken } from "./crypto";

export const SESSION_COOKIE = "ninety_express_session";
/** Which business an operator is currently looking at, if any. */
export const VIEW_AS_COOKIE = "ninety_express_view_as";

const SESSION_TTL_DAYS = 14;
/** Refresh at most once an hour, to keep a read from writing every request. */
const REFRESH_AFTER_MS = 60 * 60 * 1000;

export type SessionUser = {
  id: string;
  email: string;
  displayName: string;
  role: "member" | "operator";
  businessId: string | null;
};

export async function createSession(userId: string): Promise<string> {
  const token = generateToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await sql`
    insert into sessions (token_hash, user_id, expires_at)
    values (${hashToken(token)}, ${userId}, ${expires})
  `;

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    // Set over TLS in production; left off locally so the dev server works.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await sql`delete from sessions where token_hash = ${hashToken(token)}`;
  }
  jar.delete(SESSION_COOKIE);
  jar.delete(VIEW_AS_COOKIE);
}

/** The signed-in user, or null. Safe to call on public pages. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await sql<
    Array<{
      session_id: string;
      last_seen_at: Date;
      id: string;
      email: string;
      display_name: string;
      role: "member" | "operator";
      business_id: string | null;
    }>
  >`
    select s.id as session_id, s.last_seen_at,
           u.id, u.email, u.display_name, u.role, u.business_id
    from sessions s
    join users u on u.id = s.user_id
    where s.token_hash = ${hashToken(token)}
      and s.expires_at > now()
  `;
  if (!row) return null;

  if (Date.now() - new Date(row.last_seen_at).getTime() > REFRESH_AFTER_MS) {
    const extended = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);
    await sql`
      update sessions
      set last_seen_at = now(), expires_at = ${extended}
      where id = ${row.session_id}
    `;
  }

  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    businessId: row.business_id,
  };
}

/** Require any signed-in user; redirect to sign-in otherwise. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(
      returnTo ? `/signin?next=${encodeURIComponent(returnTo)}` : "/signin",
    );
  }
  return user;
}

export async function requireOperator(returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo);
  if (user.role !== "operator") {
    // Not a 404: a member reaching an operator page should be told plainly,
    // not left guessing whether the page exists.
    redirect("/?denied=operator");
  }
  return user;
}

/**
 * Which business the current request acts for.
 *
 * A member always acts for their own. An operator may select one to view;
 * without a selection they have none, and member-scoped pages say so rather
 * than silently showing someone else's numbers.
 */
export async function getActingBusinessId(
  user: SessionUser,
): Promise<string | null> {
  if (user.role === "member") return user.businessId;

  const jar = await cookies();
  const selected = jar.get(VIEW_AS_COOKIE)?.value;
  if (!selected) return null;

  const [row] = await sql<Array<{ id: string }>>`
    select id from businesses where id = ${selected}
  `;
  return row?.id ?? null;
}

/** Remove expired sessions. Cheap enough to call from the sign-in path. */
export async function pruneSessions(): Promise<void> {
  await sql`delete from sessions where expires_at < now()`;
}
