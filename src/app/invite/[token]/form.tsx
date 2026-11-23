"use client";

import { useActionState } from "react";

import { acceptInvite, type InviteState } from "@/lib/onboarding/actions";

export function InviteForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<InviteState, FormData>(
    acceptInvite,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />

      {state.error ? (
        <p
          role="alert"
          className="rounded border border-alert/50 bg-alert-dim/40 px-3 py-2 text-sm text-alert"
        >
          {state.error}
        </p>
      ) : null}

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-hi">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          autoFocus
          className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
        />
        <p className="mt-1 text-xs text-low">At least 12 characters.</p>
      </div>

      <div>
        <label htmlFor="confirm" className="mb-1.5 block text-sm font-medium text-hi">
          Confirm password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-signal px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal/90 disabled:opacity-60"
      >
        {pending ? "Setting password…" : "Set password and continue"}
      </button>
    </form>
  );
}
