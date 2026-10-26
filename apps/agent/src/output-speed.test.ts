import { describe, expect, it } from "vitest";
import { estimateTextTokens, OutputSpeedTracker } from "./output-speed.js";

describe("visible output speed", () => {
  it("excludes the first buffered chunk and time after the last chunk", () => {
    const speed = new OutputSpeedTracker();
    speed.append("x".repeat(400), 30_000);
    expect(speed.snapshot().averageTokensPerSecond).toBeNull();
    speed.append("x".repeat(400), 32_000);
    expect(speed.snapshot()).toEqual({ estimatedTokens: 200, elapsedMs: 2_000, averageTokensPerSecond: 50, recentTokensPerSecond: 50 });
    // Rendering, finishing a tool, or finishing the turn does not extend timing.
    expect(speed.snapshot().averageTokensPerSecond).toBe(50);
  });

  it("uses a recent window and does not mix separate messages or long first-token waits", () => {
    const speed = new OutputSpeedTracker();
    for (let second = 0; second <= 5; second++) speed.append("中".repeat(second < 3 ? 10 : 100), 90_000 + second * 1_000);
    expect(speed.snapshot().recentTokensPerSecond).toBe(100);
    expect(speed.snapshot().averageTokensPerSecond).toBe(64);
    const next = new OutputSpeedTracker();
    next.append("新回复", 150_000);
    expect(next.snapshot().elapsedMs).toBe(0);
    expect(next.snapshot().averageTokensPerSecond).toBeNull();
  });

  it("handles Chinese and Unicode across arbitrary delta boundaries without treating deltas as tokens", () => {
    const text = "Hello 中文 😀";
    const speed = new OutputSpeedTracker();
    for (let index = 0; index < text.length; index++) speed.append(text[index]!, index * 50);
    expect(speed.snapshot().estimatedTokens).toBe(Math.ceil(estimateTextTokens(text)));
    expect(speed.snapshot().estimatedTokens).not.toBe(text.length);
    expect(new OutputSpeedTracker().snapshot().averageTokensPerSecond).toBeNull();
    const burst = new OutputSpeedTracker();
    burst.append("Hello", 0);
    burst.append(" world", 1);
    expect(burst.snapshot().averageTokensPerSecond).toBeNull();
  });

  it.each([1, 5, 10, 25, 50])("keeps the recent rate local to the last three seconds with %i ms chunks", (stepMs) => {
    const speed = new OutputSpeedTracker();
    for (let elapsed = 0; elapsed <= 6_000; elapsed += stepMs) {
      speed.append(elapsed <= 3_000 ? "x" : "x".repeat(10), 90_000 + elapsed);
    }
    expect(speed.snapshot().recentTokensPerSecond).toBe(2_500 / stepMs);
    expect(speed.snapshot().averageTokensPerSecond).toBe(1_375 / stepMs);
  });

  it("does not reuse a sample from before a long output pause as the current rate", () => {
    const speed = new OutputSpeedTracker();
    speed.append("中".repeat(100), 0);
    speed.append("中".repeat(100), 1_000);
    expect(speed.snapshot().recentTokensPerSecond).toBe(100);
    speed.append("中".repeat(100), 10_000);
    expect(speed.snapshot().recentTokensPerSecond).toBeNull();
    speed.append("中".repeat(50), 10_500);
    expect(speed.snapshot().recentTokensPerSecond).toBe(100);
  });

  it("excludes empty input and first-output waits from both rate and duration", () => {
    const measure = (offset: number) => {
      const speed = new OutputSpeedTracker();
      speed.append("", 0);
      speed.append("首段".repeat(1_000), offset);
      speed.append("中".repeat(50), offset + 500);
      speed.append("", offset + 100_000);
      return speed.snapshot();
    };
    expect(measure(90_000)).toEqual(measure(1_000));
    expect(measure(90_000)).toMatchObject({ elapsedMs: 500, averageTokensPerSecond: 100, recentTokensPerSecond: 100 });
  });

  it("requires a measurable output interval rather than reporting burst or completion speed", () => {
    const speed = new OutputSpeedTracker();
    speed.append("中".repeat(100), 0);
    speed.append("中".repeat(100), 0);
    speed.append("中".repeat(100), 249);
    expect(speed.snapshot().averageTokensPerSecond).toBeNull();
    speed.append("中".repeat(25), 250);
    expect(speed.snapshot().averageTokensPerSecond).toBe(900);
    expect(speed.snapshot().recentTokensPerSecond).toBe(900);
  });

  it("uses elapsed time for irregular chunks and keeps concurrent replies independent", () => {
    const first = new OutputSpeedTracker();
    const second = new OutputSpeedTracker();
    first.append("中".repeat(10), 0);
    second.append("中".repeat(1_000), 500);
    first.append("中".repeat(20), 1_000);
    first.append("中".repeat(40), 3_000);
    second.append("中".repeat(500), 3_000);
    expect(first.snapshot()).toMatchObject({ estimatedTokens: 70, elapsedMs: 3_000, averageTokensPerSecond: 20, recentTokensPerSecond: 20 });
    expect(second.snapshot()).toMatchObject({ estimatedTokens: 1_500, elapsedMs: 2_500, averageTokensPerSecond: 200, recentTokensPerSecond: 200 });
  });
});
