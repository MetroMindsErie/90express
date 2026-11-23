/**
 * HTTP transport shared by the partner adapters.
 *
 * Deliberately strict. A partner endpoint is the one place in this system
 * where someone else's bytes become our numbers, so: short timeout, no
 * redirects followed blindly, a size ceiling, and every response parsed
 * through a schema before it goes anywhere near the engine.
 *
 * Tokens are read from the environment by the variable name recorded on the
 * provider. They are never stored in the database and never logged.
 */
import type { z } from "zod";

import { IntegrationError, type ProviderConfig } from "./types";

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 8 * 1024 * 1024;

function authHeader(config: ProviderConfig): Record<string, string> {
  if (!config.authEnvVar) return {};
  const token = process.env[config.authEnvVar];
  if (!token) {
    throw new IntegrationError(
      `${config.name} needs a token in ${config.authEnvVar}, which is not set in this environment.`,
    );
  }
  return { authorization: `Bearer ${token}` };
}

export async function partnerFetch<T>(
  config: ProviderConfig,
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: "GET" | "POST"; body?: unknown; idempotencyKey?: string },
): Promise<T> {
  if (!config.baseUrl) {
    throw new IntegrationError(`${config.name} has no base URL configured.`);
  }

  const url = new URL(path, config.baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init?.method ?? "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        accept: "application/json",
        // A generic client name. Partner endpoints get no member details.
        "user-agent": "90express-integration/1.0",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.idempotencyKey
          ? { "idempotency-key": init.idempotencyKey }
          : {}),
        ...authHeader(config),
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new IntegrationError(`${config.name} is unreachable: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new IntegrationError(
      `${config.name} returned ${response.status} for ${path}.`,
      body.slice(0, 500),
    );
  }

  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_BYTES) {
    throw new IntegrationError(
      `${config.name} returned ${declared} bytes for ${path}, over the ${MAX_BYTES} limit.`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_BYTES) {
    throw new IntegrationError(
      `${config.name} returned an oversized body for ${path}.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new IntegrationError(
      `${config.name} returned a body that is not JSON for ${path}.`,
      text.slice(0, 200),
    );
  }

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new IntegrationError(
      `${config.name} returned a payload that failed validation for ${path}.`,
      parsed.error.issues.slice(0, 5),
    );
  }
  return parsed.data;
}
