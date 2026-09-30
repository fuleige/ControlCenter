import { afterEach, describe, expect, it, vi } from "vitest";
import { RefreshScheduler } from "./refresh-scheduler";

afterEach(() => vi.useRealTimers());

describe("merged refresh timing", () => {
  it("advances a queued progress refresh for read events and runs only once", () => {
    vi.useFakeTimers();
    const scheduler = new RefreshScheduler();
    const refresh = vi.fn();
    scheduler.schedule("tasks", refresh, 1500);
    vi.advanceTimersByTime(50);
    scheduler.schedule("tasks", refresh, 100);
    scheduler.schedule("tasks", refresh, 300);
    vi.advanceTimersByTime(99);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps an earlier timer, groups each resource separately, and cancels on cleanup", () => {
    vi.useFakeTimers();
    const scheduler = new RefreshScheduler();
    const tasks = vi.fn();
    const conversations = vi.fn();
    scheduler.schedule("tasks", tasks, 100);
    vi.advanceTimersByTime(50);
    scheduler.schedule("tasks", tasks, 100);
    scheduler.schedule("conversations", conversations, 300);
    vi.advanceTimersByTime(50);
    expect(tasks).toHaveBeenCalledTimes(1);
    expect(conversations).not.toHaveBeenCalled();
    scheduler.cancelAll();
    vi.advanceTimersByTime(1500);
    expect(conversations).not.toHaveBeenCalled();
  });
});
