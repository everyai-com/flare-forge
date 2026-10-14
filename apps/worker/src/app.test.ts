import { describe, expect, it } from "vitest";
import { APP_PAGES, appHtml } from "./app";

describe("product app shell", () => {
  const html = appHtml();
  const scripts = html.split("<script>").slice(1).map((s) => s.slice(0, s.indexOf("</script>")));

  it("keeps embedded JS interpolation-free and markup-free", () => {
    for (const script of scripts) {
      expect(script).not.toContain("`");
      expect(script).not.toContain("${");
      expect(script).not.toContain("innerHTML");
      expect(script).not.toContain("insertAdjacentHTML");
      expect(script).not.toContain("document.write");
    }
  });

  it("parses as JavaScript (no raw newlines or stray escapes inside strings)", () => {
    for (const script of scripts) expect(() => new Function(script)).not.toThrow();
  });

  it("routes every page, reads one overview bundle, and supports spectators", () => {
    const js = scripts[scripts.length - 1];
    for (const p of APP_PAGES) expect(js).toContain(`["${p.id}", "${p.title}"`);
    expect(js).toContain("/v1/forge/overview");
    expect(js).toContain("/v1/public/forge/overview");
    expect(js).toContain("/v1/public/forge/join");
    expect(js).toContain("/v1/admin/status");
    expect(js).toContain("/v1/admin/login");
    expect(js).toContain("/v1/admin/github/login");
  });

  it("drives the review and settings writes through the REST routes the MCP tools use", () => {
    const js = scripts[scripts.length - 1];
    for (const route of ["/approve-plan", "/approve-landing", "/send-back", "/review", "/v1/forge/goals/plan", "/v1/forge/goals", "/v1/admin/tokens", "/v1/admin/pair-codes", "/v1/admin/forge/public", "/v1/admin/forge/judge-token", "/conflicts/", "/claim"]) {
      expect(js).toContain(route);
    }
    expect(html).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(html).toContain('name="robots" content="noindex"');
  });
});
