// Better Auth (better-auth.com) fronts account creation and the
// email+password / magic-link sign-in surface at /v1/auth/*, on the
// Worker's own D1 (tables auth_*, migration 0051). It owns credentials
// only. Authorization stays Flare's: POST /v1/admin/auth/bridge turns a
// Better Auth session into a Flare session (flare_session cookie, admin
// bit, allow-lists, tokens) through `bridgeDecision`. Instances are
// built per request (no module state): the base URL is the request
// origin, the secret is the deployment's secrets key.
import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";

export type MagicLinkSender = (args: { email: string; url: string }) => Promise<void>;

export const BETTER_AUTH_BASE_PATH = "/v1/auth";

export function createBetterAuth(args: {
  db: D1Database;
  baseURL: string;
  secret: string;
  sendMagicLink: MagicLinkSender;
}) {
  return betterAuth({
    appName: "Flare Forge",
    baseURL: args.baseURL,
    basePath: BETTER_AUTH_BASE_PATH,
    secret: args.secret,
    database: args.db,
    trustedOrigins: [args.baseURL],
    user: { modelName: "auth_user" },
    session: { modelName: "auth_session" },
    account: { modelName: "auth_account" },
    verification: { modelName: "auth_verification" },
    emailAndPassword: { enabled: true, minPasswordLength: 8 },
    advanced: { cookiePrefix: "flare_auth" },
    plugins: [
      magicLink({
        expiresIn: 900,
        sendMagicLink: async ({ email, url }) => {
          await args.sendMagicLink({ email, url });
        },
      }),
    ],
  });
}

// What the bridge does for an email Better Auth vouches for. Mirrors
// the legacy doors exactly: a known account logs in; the very first
// account claims admin (same as /v1/admin/bootstrap); otherwise open
// registration decides between a reader account and a refusal.
export type BridgeDecision = "login" | "claim_admin" | "register" | "deny";

export function bridgeDecision(args: { existing: boolean; claimed: boolean; openRegistration: boolean }): BridgeDecision {
  if (args.existing) return "login";
  if (!args.claimed) return "claim_admin";
  return args.openRegistration ? "register" : "deny";
}
