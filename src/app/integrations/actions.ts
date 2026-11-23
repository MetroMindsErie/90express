"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { sql } from "@/lib/db/client";
import {
  applyCatalogChange,
  pullTracking,
  rateCycle,
  reconcileInvoices,
  rejectCatalogChange,
  syncCatalog,
  tenderShipment,
} from "@/lib/integrations/sync";

const uuid = z.string().uuid();

/** Stands in for the signed-in operator until there is authentication. */
const OPERATOR = "90 Express operator";

export async function runCatalogSync(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  await syncCatalog(providerId, "console");
  revalidatePath("/integrations");
  revalidatePath("/catalog");
}

export async function decideCatalogChange(formData: FormData) {
  const changeId = uuid.parse(formData.get("changeId"));
  const decision = z.enum(["apply", "reject"]).parse(formData.get("decision"));

  if (decision === "apply") {
    await applyCatalogChange(changeId, OPERATOR);
  } else {
    await rejectCatalogChange(changeId, OPERATOR);
  }

  // A catalog change moves pooled pricing on every open cycle for that
  // supplier, so the pool views have to be refreshed too.
  revalidatePath("/integrations");
  revalidatePath("/catalog");
  revalidatePath("/pools");
  revalidatePath("/economics");
  revalidatePath("/");
}

export async function runRating(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  const cycleId = uuid.parse(formData.get("cycleId"));
  await rateCycle(providerId, cycleId, "console");
  revalidatePath("/integrations");
  revalidatePath(`/pools/${cycleId}`);
  revalidatePath("/economics");
}

export async function runTender(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  const shipmentId = uuid.parse(formData.get("shipmentId"));
  await tenderShipment(providerId, shipmentId, "console");
  revalidatePath("/integrations");
  revalidatePath("/freight");
}

export async function runTracking(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  const shipmentId = uuid.parse(formData.get("shipmentId"));
  await pullTracking(providerId, shipmentId, "console");
  revalidatePath("/integrations");
  revalidatePath("/freight");
}

export async function runInvoiceSync(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  await reconcileInvoices(providerId, "console");
  revalidatePath("/integrations");
}

export async function setProviderEnabled(formData: FormData) {
  const providerId = uuid.parse(formData.get("providerId"));
  const enabled = formData.get("enabled") === "true";
  await sql`
    update integration_providers set enabled = ${enabled} where id = ${providerId}
  `;
  revalidatePath("/integrations");
}

/**
 * Accept a carrier's invoice despite a variance, or mark it disputed.
 *
 * Deliberately a human decision. A variance means members were billed one
 * figure and the carrier charged another; which way that resolves is a
 * commercial call, not something to automate.
 */
export async function decideInvoice(formData: FormData) {
  const invoiceId = uuid.parse(formData.get("invoiceId"));
  const decision = z.enum(["approve", "dispute"]).parse(formData.get("decision"));
  await sql`
    update freight_invoices
    set status = ${decision === "approve" ? "approved" : "disputed"}
    where id = ${invoiceId}
  `;
  revalidatePath("/integrations");
}
