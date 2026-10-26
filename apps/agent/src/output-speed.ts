import type { MessageOutputStats } from "@controller-center/protocol";

const RECENT_WINDOW_MS = 3_000;
const SAMPLE_BUCKET_MS = 25;

/** A language-aware estimate, never an authoritative tokenizer or usage count. */
export function estimateTextTokens(text: string): number {
  let count = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    count += point <= 0x7f ? 0.25 : point >= 0x2e80 && point <= 0x9fff ? 1 : 2;
  }
  return count;
}

export class OutputSpeedTracker {
  private tokens = 0;
  private samples: Array<{ at: number; tokens: number }> = [];
  private first: { at: number; tokens: number } | null = null;
  private lastAt = 0;
  private trailingHighSurrogate = false;

  append(text: string, at = performance.now()): void {
    if (!text) return;
    const firstCodeUnit = text.charCodeAt(0);
    const joinsSurrogate = this.trailingHighSurrogate && firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff;
    this.tokens += estimateTextTokens(text) - (joinsSurrogate ? 2 : 0);
    const lastCodeUnit = text.charCodeAt(text.length - 1);
    this.trailingHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
    // A monotonic clock avoids wall-clock corrections changing the denominator.
    this.lastAt = Math.max(at, this.lastAt);
    const sample = { at: this.lastAt, tokens: this.tokens };
    this.first ??= sample;
    const previous = this.samples.at(-1);
    // Coalesce dense deltas by time, keeping the initial timing baseline intact.
    // A count-only cap can otherwise retain an old baseline indefinitely.
    if (this.samples.length > 1 && previous
      && Math.floor(previous.at / SAMPLE_BUCKET_MS) === Math.floor(sample.at / SAMPLE_BUCKET_MS)) {
      this.samples[this.samples.length - 1] = sample;
    } else {
      this.samples.push(sample);
    }
    // A resumed stream needs a fresh measurable interval after a long pause.
    while (this.samples.length > 1 && this.samples[0]!.at < this.lastAt - RECENT_WINDOW_MS) this.samples.shift();
  }

  snapshot(): MessageOutputStats {
    const elapsedMs = this.first ? this.lastAt - this.first.at : 0;
    const rate = (sample: { at: number; tokens: number } | null | undefined): number | null => {
      if (!sample || this.lastAt - sample.at < 250) return null;
      return Math.round((this.tokens - sample.tokens) / (this.lastAt - sample.at) * 10_000) / 10;
    };
    return {
      estimatedTokens: Math.ceil(this.tokens), elapsedMs: Math.round(elapsedMs),
      averageTokensPerSecond: rate(this.first), recentTokensPerSecond: rate(this.samples[0]),
    };
  }
}
