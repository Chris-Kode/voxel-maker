import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Accessibility CSS baseline checks (plan S7.17, ticket #43, ADR-0008):
 * the theme tokens and rules that implement the WCAG 2.2 AA baseline —
 * contrast-approved palette, visible keyboard focus, hover-only controls
 * reachable by keyboard, and reduced-motion honoring. These are golden
 * artifact checks for CSS-only behavior; the DOM behavior behind them is
 * covered by the component and shell tests (focus movement, aria state,
 * keyboard workflows).
 */

const cssPath = join(dirname(fileURLToPath(import.meta.url)), "app.css");
const css = readFileSync(cssPath, "utf8");

describe("app.css accessibility baseline", () => {
  it("uses the contrast-approved palette tokens", () => {
    // White text on --accent reads 4.7:1; --border is 3.2:1 on --panel
    // (the 3:1 non-text baseline); --focus is the keyboard ring.
    expect(css).toContain("--accent: #3d6fd8;");
    // Accent used as text color keeps >= 4.5:1 via --accent-text.
    expect(css).toContain("--accent-text: #8ab4ff;");
    expect(css).toContain("color: var(--accent-text);");
    expect(css).toContain("--border: #5f6b7d;");
    expect(css).toContain("--focus: #8ab4ff;");
    expect(css).toContain("--bg: #12151a;");
    expect(css).toContain("--panel: #181b21;");
  });

  it("declares a visible keyboard focus ring for every control", () => {
    expect(css).toContain(":focus-visible {");
    expect(css).toContain("outline: 2px solid var(--focus);");
    // The canvas-like focusable regions keep their own rings.
    expect(css).toContain(".viewport:focus-visible");
    expect(css).toContain(".timeline-lanes:focus-visible");
  });

  it("does not hide focus with outline:none on interactive controls", () => {
    // Any remaining outline:none must not target focusable controls
    // (the viewport/lanes rules are paired with focus-visible rings).
    const controlOutlines = css.match(/[^{}]*outline:\s*none;[^}]*}/g) ?? [];
    for (const rule of controlOutlines) {
      const selector = rule.split("{")[0] ?? "";
      expect(selector).not.toMatch(/button|input|select|textarea/);
    }
  });

  it("keeps row actions reachable for keyboard focus, not only hover", () => {
    expect(css).toContain(".hierarchy-row:focus-within .hierarchy-actions");
  });

  it("honors prefers-reduced-motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("transition-duration: 0.01ms !important");
  });

  it("marks selection states with a 3:1 accent bar, not tint alone", () => {
    expect(css).toContain("border-left: 3px solid var(--accent);");
  });
});
