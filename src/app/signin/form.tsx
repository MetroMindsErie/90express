"use client";

import { useActionState } from "react";

import { signIn, type SignInState } from "@/lib/onboarding/actions";

export function SignInForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<SignInState, FormData>(
    signIn,
    {},
  );

  return (
    <form action={formAction} className="space-y-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? (
        <p
          role="alert"
          className="rounded border border-alert/50 bg-alert-dim/40 px-3 py-2 text-sm text-alert"
        >
          {state.error}
        </p>
      ) : null}

      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-hi">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          autoComplete="email"
          autoFocus
          className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
        />
      </div>

      <div>
        <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-hi">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          className="w-full rounded border border-ink-600 bg-ink-850 px-2.5 py-2 text-sm text-hi"
        />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-signal px-4 py-2.5 text-sm font-semibold text-ink-950 transition-colors hover:bg-signal/90 disabled:opacity-60"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
