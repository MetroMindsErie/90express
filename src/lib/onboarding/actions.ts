"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { generateToken, hashToken, hashPassword, verifyPassword } from "@/lib/auth/crypto";
import {
  createSession,
  destroySession,
  getSessionUser,
  requireOperator,
  requireUser,
  pruneSessions,
  VIEW_AS_COOKIE,
} from "@/lib/auth/session";
import { sql } from "@/lib/db/client";
import { lookupPostalCode, matchZone } from "./corridor";
import { buildEstimate, getZoneCandidates } from "./queries";

const email = z.string().trim().toLowerCase().email().max(200);
const uuid = z.string().uuid();

/**
 * Never reveal whether an address is registered.
 *
 * Sign-in and invite flows return the same message whether the account is
 * missing, has no password set, or the password is wrong.
 */
const GENERIC_SIGNIN_ERROR =
  "That email and password do not match an account.";

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MINUTES = 15;

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

const applicationSchema = z.object({
  legalName: z.string().trim().min(2).max(200),
  dba: z.string().trim().max(200).optional(),
  segment: z.string().trim().min(2).max(64),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: email,
  phone: z.string().trim().max(40).optional(),
  street: z.string().trim().min(3).max(200),
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a 5-digit ZIP code."),
  dockType: z.enum(["dock", "liftgate", "ground"]),
  requestedTier: z.enum(["starter", "standard", "premium"]),
  notes: z.string().trim().max(2000).optional(),
});

export type ApplyState = {
  ok: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Where to send the applicant to watch their status. */
  statusUrl?: string;
};

export async function submitApplication(
  _prev: ApplyState,
  formData: FormData,
): Promise<ApplyState> {
  const parsed = applicationSchema.safeParse({
    legalName: formData.get("legalName"),
    dba: formData.get("dba") || undefined,
    segment: formData.get("segment"),
    contactName: formData.get("contactName"),
    contactEmail: formData.get("contactEmail"),
    phone: formData.get("phone") || undefined,
    street: formData.get("street"),
    postalCode: formData.get("postalCode"),
    dockType: formData.get("dockType"),
    requestedTier: formData.get("requestedTier"),
    notes: formData.get("notes") || undefined,
  });

  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form");
      fieldErrors[key] ??= issue.message;
    }
    return { ok: false, error: "Please check the highlighted fields.", fieldErrors };
  }
  const input = parsed.data;

  // Declared volumes: product id -> cases per month.
  const monthlyDemand = new Map<string, number>();
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("cases_")) continue;
    const productId = key.slice("cases_".length);
    if (!uuid.safeParse(productId).success) continue;
    const cases = Number(value);
    if (!Number.isFinite(cases) || cases <= 0) continue;
    monthlyDemand.set(productId, Math.min(100_000, Math.round(cases)));
  }

  if (monthlyDemand.size === 0) {
    return {
      ok: false,
      error:
        "Add at least one product and the cases you buy in a typical month. Without it we cannot tell you what joining is worth.",
    };
  }

  const place = lookupPostalCode(input.postalCode);
  if (!place) {
    return {
      ok: false,
      error:
        "That ZIP code is outside the I-77 corridor we serve today. Email us and we will add you to the list for the next corridor.",
      fieldErrors: { postalCode: "Outside the current service area." },
    };
  }

  const zones = await getZoneCandidates();
  const match = matchZone(place, zones);

  // One open application per email. A second attempt should not create a
  // duplicate the operator has to reconcile by hand.
  const [existing] = await sql<Array<{ id: string }>>`
    select id from member_applications
    where lower(contact_email) = ${input.contactEmail}
      and status in ('submitted','reviewing','waitlisted')
  `;
  if (existing) {
    return {
      ok: false,
      error:
        "There is already an open application for that email address. Check your inbox for the status link, or contact us.",
    };
  }

  const estimate =
    match.zone !== null
      ? await buildEstimate({
          zoneId: match.zone.id,
          destination: { lat: place.lat, lng: place.lng },
          dockType: input.dockType,
          monthlyDemand,
        })
      : null;

  const statusToken = generateToken();

  const [application] = await sql<Array<{ id: string }>>`
    insert into member_applications
      (legal_name, dba, segment, contact_name, contact_email, phone, street, city,
       state, postal_code, lat, lng, zone_id, nearest_zone_id, distance_miles,
       dock_type, requested_tier, status, estimate, notes, status_token_hash)
    values (${input.legalName}, ${input.dba ?? null}, ${input.segment},
            ${input.contactName}, ${input.contactEmail}, ${input.phone ?? null},
            ${input.street}, ${place.city}, ${place.state}, ${input.postalCode},
            ${place.lat}, ${place.lng}, ${match.zone?.id ?? null},
            ${match.nearest?.id ?? null}, ${match.distanceMiles},
            ${input.dockType}, ${input.requestedTier},
            ${match.zone ? "submitted" : "waitlisted"},
            ${estimate ? sql.json(estimate as never) : null},
            ${input.notes ?? null}, ${hashToken(statusToken)})
    returning id
  `;

  for (const [productId, cases] of monthlyDemand) {
    await sql`
      insert into application_products (application_id, product_id, monthly_cases)
      values (${application.id}, ${productId}, ${cases})
      on conflict do nothing
    `;
  }

  revalidatePath("/operator/applications");
  // The token is the applicant's only way back to their status page; it is
  // never stored in plaintext, so this redirect is the one time it exists.
  redirect(`/join/status/${statusToken}`);
}

// ---------------------------------------------------------------------------
// Operator review
// ---------------------------------------------------------------------------

export async function approveApplication(formData: FormData) {
  const operator = await requireOperator();
  const applicationId = uuid.parse(formData.get("applicationId"));

  const [app] = await sql<
    Array<{
      id: string;
      status: string;
      zone_id: string | null;
      legal_name: string;
      dba: string | null;
      segment: string;
      contact_name: string;
      contact_email: string;
      phone: string | null;
      street: string;
      city: string;
      state: string;
      postal_code: string;
      lat: number | null;
      lng: number | null;
      dock_type: "dock" | "liftgate" | "ground";
      requested_tier: "starter" | "standard" | "premium";
    }>
  >`
    select id, status, zone_id, legal_name, dba, segment, contact_name, contact_email,
           phone, street, city, state, postal_code, lat::float8 as lat,
           lng::float8 as lng, dock_type, requested_tier
    from member_applications where id = ${applicationId}
  `;

  if (!app) throw new Error("Application not found.");
  if (!["submitted", "reviewing"].includes(app.status)) {
    throw new Error(`This application is ${app.status} and cannot be approved.`);
  }
  if (!app.zone_id || app.lat === null || app.lng === null) {
    throw new Error(
      "This applicant is not inside an active zone. Open a zone for them, or leave them waitlisted.",
    );
  }

  // Provision the member, their account invite, and their declared inventory
  // in one transaction: a half-provisioned member is worse than none.
  const inviteToken = generateToken();

  await sql.begin(async (tx) => {
    const [business] = await tx<Array<{ id: string }>>`
      insert into businesses (zone_id, legal_name, dba, segment, contact_name,
                              contact_email, phone, street, city, state, postal_code,
                              lat, lng, dock_type, membership_tier, status)
      values (${app.zone_id}, ${app.legal_name}, ${app.dba}, ${app.segment},
              ${app.contact_name}, ${app.contact_email}, ${app.phone}, ${app.street},
              ${app.city}, ${app.state}, ${app.postal_code}, ${app.lat}, ${app.lng},
              ${app.dock_type}, ${app.requested_tier}, 'pending')
      returning id
    `;

    // Seed inventory from what they told us they buy, so their first
    // dashboard is not empty. Par is a month's usage; they adjust it.
    const declared = await tx<Array<{ product_id: string; monthly_cases: number }>>`
      select product_id, monthly_cases::float8 as monthly_cases
      from application_products where application_id = ${applicationId}
    `;
    for (const row of declared) {
      const weekly = Math.max(0, row.monthly_cases / 4.345);
      await tx`
        insert into inventory_items (business_id, product_id, on_hand_cases,
                                     avg_weekly_cases, par_cases, safety_days)
        values (${business.id}, ${row.product_id}, 0,
                ${Number(weekly.toFixed(2))},
                ${Number(row.monthly_cases.toFixed(2))}, 5)
        on conflict (business_id, product_id) do nothing
      `;
    }

    // Automation starts off. A member turns it on once they trust it.
    await tx`
      insert into agent_policies (business_id, enabled, cycle_budget_cents,
                                  auto_approve_under_cents, allowed_categories)
      values (${business.id}, false, 0, 0, '{}')
      on conflict (business_id) do nothing
    `;

    await tx`
      insert into users (email, role, business_id, display_name,
                         invite_token_hash, invite_expires_at)
      values (${app.contact_email}, 'member', ${business.id}, ${app.contact_name},
              ${hashToken(inviteToken)}, now() + interval '14 days')
      on conflict do nothing
    `;

    await tx`
      update member_applications
      set status = 'approved', reviewed_by = ${operator.displayName},
          reviewed_at = now(), business_id = ${business.id}
      where id = ${applicationId}
    `;
  });

  revalidatePath("/operator/applications");
  revalidatePath("/network");
  // The invite link is shown to the operator once, to pass on. Nothing
  // emails yet, and pretending otherwise would lose members silently.
  redirect(`/operator/applications?invited=${inviteToken}`);
}

export async function declineApplication(formData: FormData) {
  const operator = await requireOperator();
  const applicationId = uuid.parse(formData.get("applicationId"));
  const reason = z
    .string()
    .trim()
    .min(3, "Give a reason: it goes on the applicant's status page.")
    .max(500)
    .parse(formData.get("reason"));

  await sql`
    update member_applications
    set status = 'declined', decline_reason = ${reason},
        reviewed_by = ${operator.displayName}, reviewed_at = now()
    where id = ${applicationId} and status in ('submitted','reviewing','waitlisted')
  `;
  revalidatePath("/operator/applications");
}

export async function markReviewing(formData: FormData) {
  const operator = await requireOperator();
  const applicationId = uuid.parse(formData.get("applicationId"));
  await sql`
    update member_applications
    set status = 'reviewing', reviewed_by = ${operator.displayName}
    where id = ${applicationId} and status = 'submitted'
  `;
  revalidatePath("/operator/applications");
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export type SignInState = { error?: string };

export async function signIn(
  _prev: SignInState,
  formData: FormData,
): Promise<SignInState> {
  const parsed = z
    .object({
      email,
      password: z.string().min(1).max(1024),
      next: z.string().max(500).optional(),
    })
    .safeParse({
      email: formData.get("email"),
      password: formData.get("password"),
      next: formData.get("next") || undefined,
    });

  if (!parsed.success) return { error: GENERIC_SIGNIN_ERROR };

  const [user] = await sql<
    Array<{
      id: string;
      password_hash: string | null;
      failed_attempts: number;
      locked_until: Date | null;
    }>
  >`
    select id, password_hash, failed_attempts, locked_until
    from users where lower(email) = ${parsed.data.email}
  `;

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return {
      error: `Too many attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`,
    };
  }

  // Always run the KDF, even with no such user, so response time does not
  // disclose whether the address exists.
  const ok = await verifyPassword(
    parsed.data.password,
    user?.password_hash ?? "scrypt$131072$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA",
  );

  if (!user || !ok) {
    if (user) {
      const attempts = user.failed_attempts + 1;
      await sql`
        update users
        set failed_attempts = ${attempts},
            locked_until = ${
              attempts >= MAX_FAILED_ATTEMPTS
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
                : null
            }
        where id = ${user.id}
      `;
    }
    return { error: GENERIC_SIGNIN_ERROR };
  }

  await sql`
    update users
    set failed_attempts = 0, locked_until = null, last_login_at = now()
    where id = ${user.id}
  `;
  await pruneSessions();
  await createSession(user.id);

  // Only ever redirect within this app: an open redirect here would be a
  // phishing primitive handed to anyone who can craft a link.
  const next = parsed.data.next;
  const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  redirect(safeNext);
}

export async function signOut() {
  await destroySession();
  redirect("/signin");
}

export type InviteState = { error?: string };

/** Accept an invite by setting a password. The token is single-use. */
export async function acceptInvite(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const parsed = z
    .object({
      token: z.string().min(10).max(200),
      password: z.string().min(12, "Use at least 12 characters.").max(1024),
      confirm: z.string().max(1024),
    })
    .safeParse({
      token: formData.get("token"),
      password: formData.get("password"),
      confirm: formData.get("confirm"),
    });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form." };
  }
  if (parsed.data.password !== parsed.data.confirm) {
    return { error: "Those passwords do not match." };
  }

  const [user] = await sql<Array<{ id: string; business_id: string | null }>>`
    select id, business_id from users
    where invite_token_hash = ${hashToken(parsed.data.token)}
      and invite_expires_at > now()
  `;
  if (!user) {
    return { error: "This invite link is invalid or has expired. Ask us for a new one." };
  }

  const hash = await hashPassword(parsed.data.password);
  await sql`
    update users
    set password_hash = ${hash}, invite_token_hash = null, invite_expires_at = null,
        failed_attempts = 0, locked_until = null
    where id = ${user.id}
  `;

  await createSession(user.id);
  redirect("/terms");
}

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export async function acceptTerms(formData: FormData) {
  const user = await requireUser("/terms");
  if (!user.businessId) throw new Error("Only a member can accept terms.");

  const termsVersionId = uuid.parse(formData.get("termsVersionId"));
  const name = z.string().trim().min(2).max(120).parse(formData.get("acceptedByName"));

  await sql`
    insert into terms_acceptances (business_id, terms_version_id, user_id, accepted_by_name)
    values (${user.businessId}, ${termsVersionId}, ${user.id}, ${name})
    on conflict (business_id, terms_version_id) do nothing
  `;

  // Accepting the agreement is what activates the membership.
  await sql`
    update businesses set status = 'active'
    where id = ${user.businessId} and status = 'pending'
  `;

  revalidatePath("/", "layout");
  redirect("/");
}

// ---------------------------------------------------------------------------
// Operator support view
// ---------------------------------------------------------------------------

/** Let an operator look at a member's console. Labelled, never silent. */
export async function setViewAs(formData: FormData) {
  const user = await getSessionUser();
  if (!user || user.role !== "operator") {
    throw new Error("Only an operator can change the viewed business.");
  }
  const raw = formData.get("businessId");
  const { cookies } = await import("next/headers");
  const jar = await cookies();

  if (!raw || raw === "") {
    jar.delete(VIEW_AS_COOKIE);
  } else {
    const businessId = uuid.parse(raw);
    jar.set(VIEW_AS_COOKIE, businessId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 8,
    });
  }
  revalidatePath("/", "layout");
}
