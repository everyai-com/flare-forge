import { describe, expect, it, vi } from "vitest";
import type { Db } from "./db";
import { ensureSchema, SCHEMA_FINGERPRINT, SCHEMA_FINGERPRINT_KEY, SCHEMA_STATEMENTS } from "./schema";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

// A counting D1 shim over node:sqlite. ensureSchema memoizes per isolate,
// so each test reaches applySchema through a fresh module instance.
function countingDb(): Db & { statements: string[] } {
  const raw = new DatabaseSync(":memory:");
  const statements: string[] = [];
  return {
    statements,
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          const params = values.map((v) => (v === undefined ? null : v)) as (string | number | null)[];
          statements.push(query);
          return {
            async all<T>() {
              return { results: raw.prepare(query).all(...params) as T[] };
            },
            async first<T>(column?: string) {
              const row = raw.prepare(query).get(...params) as Record<string, unknown> | undefined;
              if (row === undefined) return null;
              return (column ? row[column] : row) as T;
            },
            async run() {
              return raw.prepare(query).run(...params);
            },
          };
        },
      };
    },
  };
}

async function freshEnsureSchema(): Promise<typeof ensureSchema> {
  vi.resetModules();
  const mod = await import("./schema");
  return mod.ensureSchema;
}

describe("ensureSchema fast path", () => {
  it("runs the full DDL pass on a fresh database and stamps the fingerprint", async () => {
    const db = countingDb();
    await (await freshEnsureSchema())(db);
    expect(db.statements.length).toBeGreaterThan(SCHEMA_STATEMENTS.length);
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SCHEMA_FINGERPRINT_KEY).first<{ value: string }>();
    expect(row?.value).toBe(SCHEMA_FINGERPRINT);
  });

  it("does one SELECT and nothing else when the stored fingerprint matches", async () => {
    const db = countingDb();
    await (await freshEnsureSchema())(db);
    db.statements.length = 0;
    await (await freshEnsureSchema())(db);
    expect(db.statements).toEqual(["SELECT value FROM app_settings WHERE key = ?"]);
  });

  it("re-runs the full pass when the stored fingerprint is stale", async () => {
    const db = countingDb();
    await (await freshEnsureSchema())(db);
    await db.prepare("UPDATE app_settings SET value = ? WHERE key = ?").bind("v1-00000000-0", SCHEMA_FINGERPRINT_KEY).run();
    db.statements.length = 0;
    await (await freshEnsureSchema())(db);
    expect(db.statements.length).toBeGreaterThan(SCHEMA_STATEMENTS.length);
    const row = await db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(SCHEMA_FINGERPRINT_KEY).first<{ value: string }>();
    expect(row?.value).toBe(SCHEMA_FINGERPRINT);
  });

  it("fingerprint is stable and bound to the DDL text", () => {
    expect(SCHEMA_FINGERPRINT).toMatch(/^v1-[0-9a-f]{8}-\d+$/);
  });
});
