// ---------------------------------------------------------------------------
// SSR auth gate — the server-side session check for DOCUMENT requests.
//
// Before this gate, every signed-out visitor was served the SPA, whose root
// AuthGate SSRs the AUTHENTICATED app-shell skeleton until a client-side
// `/account/me` round trip 401s — the "bad skeleton on unauthed state" flash.
// The sealed `wos-session` cookie can be verified right here in the worker
// (unseal + JWT check against cached JWKS — no per-request WorkOS round trip
// except token refresh), so signed-out visitors are 302'd to /login before any
// app HTML exists, and signed-in visitors proceed knowing the session is real.
//
// Scope: GET/HEAD requests that are document navigations (sec-fetch-dest /
// accept), excluding app-owned paths (/api, /mcp — they answer for themselves
// earlier in the middleware chain). Everything else passes through untouched.
// ---------------------------------------------------------------------------

import { createMiddleware } from "@tanstack/react-start";
import { Effect, Exit, ManagedRuntime } from "effect";

import { AUTH_HINT_COOKIE } from "@executor-js/react/multiplayer/auth-hint";

import { isAppOwnedPath } from "../app-paths";
import { parseCookie } from "./cookies";
import { loginPath, safeReturnTo } from "./return-to";
import { WorkOSClient } from "./workos";

const SESSION_COOKIE = "wos-session";
/** Mirrors the handlers' COOKIE_OPTIONS (path /, HttpOnly, Lax, 7d, Secure). */
const SESSION_COOKIE_ATTRIBUTES = "Path=/; HttpOnly; Secure; SameSite=Lax";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

const isDocumentRequest = (request: Request): boolean => {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  // Browsers label navigations explicitly; non-browser clients fall back to
  // content negotiation. Anything that isn't asking for a page (vite module
  // requests, JSON fetches, health probes) passes through ungated.
  const dest = request.headers.get("sec-fetch-dest");
  if (dest !== null) return dest === "document";
  return request.headers.get("accept")?.includes("text/html") ?? false;
};

// Lazy for the same reason start.ts instantiates the app handler lazily: this
// module reaches workers-only imports (cloudflare:workers via ./workos), which
// must stay behind the stripped `.server()` callback so the client bundle
// never pulls them in. One runtime per isolate — the WorkOS client holds no
// sockets, just config and a JWKS cache, so sharing it across requests is
// exactly what the unified app handler already does.
let runtime: ManagedRuntime.ManagedRuntime<WorkOSClient, unknown> | undefined;
const getRuntime = () => (runtime ??= ManagedRuntime.make(WorkOSClient.Default));

type VerifiedSession = { readonly refreshedSession?: string | undefined };

// EVERY failure collapses to "signed out" — WorkOS errors inside the effect
// and layer-construction errors like a bad cookie password (runPromiseExit
// carries those in its Exit too) — so the login flow surfaces the real
// problem instead of 500ing every page.
const verifySession = async (sealed: string): Promise<VerifiedSession | null> => {
  const exit = await getRuntime().runPromiseExit(
    Effect.flatMap(WorkOSClient.asEffect(), (workos) => workos.authenticateSealedSession(sealed)),
  );
  return Exit.isSuccess(exit) ? exit.value : null;
};

const sessionSetCookie = (sealed: string) =>
  `${SESSION_COOKIE}=${sealed}; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=${SESSION_MAX_AGE}`;

const redirect = (
  location: string,
  options?: {
    /** Drop the (invalid) session + auth-hint cookies along the way. */
    readonly clearSession?: boolean;
    /** Persist a WorkOS-rotated sealed session (refresh tokens are single-use). */
    readonly refreshedSession?: string | undefined;
  },
): Response => {
  const headers = new Headers({ location });
  if (options?.clearSession) {
    headers.append("set-cookie", `${SESSION_COOKIE}=; ${SESSION_COOKIE_ATTRIBUTES}; Max-Age=0`);
    headers.append("set-cookie", `${AUTH_HINT_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`);
  }
  if (options?.refreshedSession) {
    headers.append("set-cookie", sessionSetCookie(options.refreshedSession));
  }
  return new Response(null, { status: 302, headers });
};

export const authGateMiddleware = createMiddleware({ type: "request" }).server(
  async ({ pathname, request, next }) => {
    if (isAppOwnedPath(pathname) || !isDocumentRequest(request)) return next();

    const sealed = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
    const url = new URL(request.url);

    // /login is the one page signed-out visitors are FOR; a signed-in visitor
    // landing here is bounced straight back to where they were headed.
    if (pathname === "/login") {
      const session = sealed ? await verifySession(sealed) : null;
      if (!session) return next();
      return redirect(safeReturnTo(url.searchParams.get("returnTo")) ?? "/", {
        refreshedSession: session.refreshedSession,
      });
    }

    // Marketing CTAs link to /cloud, which is not a route — it's "open the
    // app". Send it to the root (the gate below decides app vs login).
    const returnTo = pathname === "/cloud" ? "/" : `${pathname}${url.search}`;

    if (!sealed) return redirect(loginPath(returnTo));

    const session = await verifySession(sealed);
    if (!session) {
      // A cookie that doesn't verify is worse than none: on executor.sh its
      // mere presence keeps routing / into the app instead of marketing.
      return redirect(loginPath(returnTo), { clearSession: true });
    }

    if (pathname === "/cloud") {
      return redirect("/", { refreshedSession: session.refreshedSession });
    }

    const result = await next();
    if (session.refreshedSession) {
      // WorkOS refresh tokens are single-use: the rotated sealed session MUST
      // reach the browser or the next expiry logs the user out.
      const response = new Response(result.response.body, result.response);
      response.headers.append("set-cookie", sessionSetCookie(session.refreshedSession));
      return response;
    }
    return result;
  },
);
