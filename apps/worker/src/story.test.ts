import { describe, expect, it } from "vitest";
import { STORY_CHAPTERS, storyHtml } from "./story";

describe("story page", () => {
  const html = storyHtml();
  const script = html.slice(html.indexOf("<script>"), html.lastIndexOf("</script>"));

  it("keeps embedded JS interpolation-free and markup-free", () => {
    // Same rules as dashboard.ts: the page is one outer template literal,
    // and API data only reaches the DOM through textContent.
    expect(script).not.toContain("`");
    expect(script).not.toContain("${");
    expect(script).not.toContain("innerHTML");
    expect(script).not.toContain("insertAdjacentHTML");
    expect(script).not.toContain("document.write");
  });

  it("tells every chapter in order, each with a why block, and polls one bundled read", () => {
    for (const ch of STORY_CHAPTERS) expect(html).toContain(`id="ch-${ch.id}"`);
    const order = STORY_CHAPTERS.map((c) => html.indexOf(`id="ch-${c.id}"`));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/class="why"/g)?.length).toBeGreaterThanOrEqual(10);
    expect(script).toContain("/v1/forge/story?repo=");
    expect(script).toContain("/v1/public/forge/story?repo=");
    expect(script).toContain("/v1/forge/why");
    expect(script).toContain("/v1/public/forge/why");
  });

  it("names the command that fills each empty state and never ships a token", () => {
    expect(html).toContain("npm run forge:demo");
    expect(html).toContain("npm run forge:agents -- --mode scripted --count 6");
    expect(html).toContain("npm run forge:ops-reconcile");
    expect(html).toContain("claude mcp add --transport http flare-forge ");
    expect(html).toContain("$FLARE_TOKEN");
    expect(html).not.toMatch(/Bearer [A-Za-z0-9_-]{20,}/);
    expect(html).toContain('name="robots" content="noindex"');
  });
});
