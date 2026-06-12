import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { meAtom } from "../api/account-atoms";
import {
  clearAuthHintCookie,
  readAuthHintCookie,
  writeAuthHintCookie,
  type AuthHint,
} from "./auth-hint";

// ---------------------------------------------------------------------------
// Shared auth seam for the multiplayer apps (cloud + self-host).
//
// `useAuth()` reflects the `/account/me` query: loading → unauthenticated →
// authenticated. Provider-neutral — the only difference between cloud (WorkOS)
// and self-host (Better Auth) is which server answers `me` and how the session
// cookie was minted. Analytics stay OUT of here; a host that wants to identify
// the user (cloud → PostHog) passes an `onIdentify` callback.
//
// While `/account/me` is in flight the state is seeded from the auth-hint
// cookie (see ./auth-hint): a signed-in user's first paint is the app shell
// with their identity (no skeleton-gate), and a visitor with no hint renders
// as loading — which the host should never let happen for signed-out users
// (cloud redirects them to /login during SSR). The hint is display-only;
// the resolved `/account/me` answer always wins.
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthOrganization = {
  id: string;
  name: string;
};

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser; organization: AuthOrganization | null };

export type IdentifyFn = (
  state: Extract<AuthState, { status: "authenticated" }> | { status: "unauthenticated" },
) => void;

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

/** The auth-hint cookie as an optimistic AuthState, or null when absent. */
const hintState = (hint: AuthHint | null): AuthState | null =>
  hint && {
    status: "authenticated",
    user: hint.user,
    organization: hint.organization,
  };

const AuthProviderClient = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  const result = useAtomValue(meAtom);

  // The hint applies one frame AFTER mount: SSR always renders the loading
  // state and the first client render must match that HTML, so the cookie
  // read is deferred to an effect (the documented pattern for client-only
  // values). The flip costs a frame, not a network round trip.
  const [hint, setHint] = useState<AuthHint | null>(null);
  useEffect(() => {
    setHint(readAuthHintCookie());
  }, []);

  // What `/account/me` actually said — the authority. The atom value only
  // changes identity when the query emits, so memoizing on it gives the
  // effects below a dependency that tracks real transitions.
  const resolved = useMemo<AuthState>(
    () =>
      AsyncResult.match(result, {
        onInitial: () => ({ status: "loading" as const }),
        onSuccess: ({ value }) => ({
          status: "authenticated" as const,
          user: value.user,
          organization: value.organization,
        }),
        onFailure: () => ({ status: "unauthenticated" as const }),
      }),
    [result],
  );

  // Both effects key off RESOLVED state, never hint-derived optimism:
  // identify must not report a stale hint to analytics, and the hint cookie
  // must not rewrite itself from its own contents.
  useEffect(() => {
    if (resolved.status === "loading") return;
    onIdentify?.(resolved);
  }, [onIdentify, resolved]);

  // Keep the hint cookie in step with reality so the NEXT page load seeds
  // correctly: refresh it on every confirmed identity, drop it the moment the
  // server says signed-out.
  useEffect(() => {
    if (resolved.status === "authenticated") {
      writeAuthHintCookie({ v: 1, user: resolved.user, organization: resolved.organization });
    } else if (resolved.status === "unauthenticated") {
      clearAuthHintCookie();
    }
  }, [resolved]);

  // What consumers see — the hint papers over the in-flight window only.
  // Memoized so context consumers don't re-render on unrelated renders.
  const state = useMemo<AuthState>(
    () => (resolved.status === "loading" ? (hintState(hint) ?? resolved) : resolved),
    [resolved, hint],
  );

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient onIdentify={onIdentify}>{children}</AuthProviderClient>;
};
