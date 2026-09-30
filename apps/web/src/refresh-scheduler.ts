export class RefreshScheduler {
  private pending = new Map<string, { timer: ReturnType<typeof setTimeout>; dueAt: number }>();

  schedule(key: string, callback: () => void, delay: number): void {
    const dueAt = Date.now() + delay;
    const existing = this.pending.get(key);
    if (existing && existing.dueAt <= dueAt) return;
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      this.pending.delete(key);
      callback();
    }, delay);
    this.pending.set(key, { timer, dueAt });
  }

  cancelAll(): void {
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
