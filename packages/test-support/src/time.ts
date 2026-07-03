import { vi } from "vitest";

// Bun-setSystemTime-compatible shim: fakes Date ONLY. The suite's timing
// helpers (withinMs/settleSoon/flush) rely on real setTimeout/setImmediate,
// so the timer functions themselves must never be faked. Calling with no
// argument restores the real clock, mirroring bun:test's setSystemTime().
export const setSystemTime = (date?: Date): void => {
  if (date) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(date);
  } else {
    vi.useRealTimers();
  }
};
