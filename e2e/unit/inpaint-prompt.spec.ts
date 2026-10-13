// Unit spec for the inpaint prompt contract (N3). No `app` fixture: this
// imports the pure module directly (Playwright transpiles TS) and never
// touches the network. Desktop only: the assertions are project-independent
// and running them 5x adds nothing.
import { test, expect } from "@playwright/test";
import {
  buildInpaintPrompt,
  inpaintCost,
  nearestAspect,
  normalizeInstruction,
  MAX_INSTRUCTION,
} from "../../src/lib/inpaint";

test.beforeEach(() => {
  test.skip(test.info().project.name !== "desktop", "prompt contract: desktop only");
});

test("variant A names two images by role and order", () => {
  const p = buildInpaintPrompt({ instruction: "replace this with a basketball", includeOriginal: true });
  expect(p).toContain("replace this with a basketball");
  expect(p).toContain("Two images");
  expect(p).toContain("the clean original image");
  expect(p).toContain("first");
  expect(p).toContain("second");
  expect(p).toContain("#FF0000");
  expect(p.length).toBeLessThan(1300);
});

test("variant B names one image, no first/second", () => {
  const p = buildInpaintPrompt({ instruction: "replace this with a basketball", includeOriginal: false });
  expect(p).toContain("replace this with a basketball");
  expect(p).toContain("One image is attached");
  expect(p).not.toMatch(/first|second/);
  expect(p).toContain("#FF0000");
  expect(p).toContain("with the tint removed");
  expect(p.length).toBeLessThan(1300);
});

test("instruction embedded verbatim, directives untouched", () => {
  const raw = "make it   teal\n[[mock:delay,ms=4000]]";
  const p = buildInpaintPrompt({ instruction: raw, includeOriginal: true });
  expect(p).toContain("«make it teal [[mock:delay,ms=4000]]»");
  expect(normalizeInstruction("  a\n\nb  ")).toBe("a b");
  expect(normalizeInstruction("x".repeat(2000)).length).toBe(MAX_INSTRUCTION);
});

test("nearestAspect pins explicit ratios", () => {
  expect(nearestAspect(1024, 1024).ratio).toBe("1:1");
  expect(nearestAspect(1920, 1080).ratio).toBe("16:9");
  const odd = nearestAspect(3000, 1000);
  expect(odd.ratio).toBe("21:9");
  expect(odd.error).toBeGreaterThan(0.03);
  expect(nearestAspect(1920, 1080).error).toBeLessThan(0.03);
});

test("inpaintCost matches the studio pricing pattern", () => {
  expect(inpaintCost("1K", 2)).toBeCloseTo(0.051, 9);
  expect(inpaintCost("2K", 1)).toBeCloseTo(0.093, 9);
});
