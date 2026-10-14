import { describe, expect, it } from "vitest";
import { BETTER_AUTH_BASE_PATH, bridgeDecision } from "./better-auth";
import { SCHEMA_STATEMENTS } from "./schema";

describe("bridgeDecision", () => {
  it("logs a known account in regardless of registration policy", () => {
    expect(bridgeDecision({ existing: true, claimed: true, openRegistration: false })).toBe("login");
    expect(bridgeDecision({ existing: true, claimed: false, openRegistration: false })).toBe("login");
  });
  it("lets the first account claim admin, like bootstrap", () => {
    expect(bridgeDecision({ existing: false, claimed: false, openRegistration: false })).toBe("claim_admin");
  });
  it("registers a reader only when open registration is on", () => {
    expect(bridgeDecision({ existing: false, claimed: true, openRegistration: true })).toBe("register");
    expect(bridgeDecision({ existing: false, claimed: true, openRegistration: false })).toBe("deny");
  });
});

describe("schema", () => {
  it("carries the four Better Auth tables under the auth_ prefix", () => {
    const sql = SCHEMA_STATEMENTS.join("\n");
    for (const t of ["auth_user", "auth_session", "auth_account", "auth_verification"]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${t} (`);
    }
    expect(BETTER_AUTH_BASE_PATH).toBe("/v1/auth");
  });
});
