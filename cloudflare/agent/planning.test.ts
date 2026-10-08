import { describe, expect, it } from "bun:test";
import { hasUserPlan, planMode } from "./planning";

describe("smart planning", () => {
  it("follows a user-written plan directly", () => {
    const p = "Build my bakery site:\n1. Hero with the shop name and a photo\n2. Menu grid with prices for 8 items\n3. Contact form with name, email, message\n4. Footer with opening hours";
    expect(hasUserPlan(p)).toBe(true);
    expect(planMode(p, { fileCount: 0 })).toBe("provided");
  });
  it("starts clear requests without asking for approval", () => {
    expect(planMode("Build a React website for a yoga studio with schedule and pricing", { fileCount: 0 })).toBe("auto");
    expect(planMode("Change the hero button color to blue", { fileCount: 12 })).toBe("direct");
  });
  it("asks for review only when the request is vague or plan mode was chosen", () => {
    expect(planMode("make it better", { fileCount: 10 })).toBe("review");
    expect(planMode("a website", { fileCount: 0 })).toBe("review");
    expect(planMode("Change the hero button color to blue", { fileCount: 12, forceReview: true })).toBe("review");
  });
});
