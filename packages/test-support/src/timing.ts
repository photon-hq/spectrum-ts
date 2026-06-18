// Shared timing helpers for the async coordination in the suite, named so intent
// is clear and tuning is centralized.

// Upper bound on idle teardown waits (see settleSoon).
export const SETTLE_CAP_MS = 150;
// Yield one event-loop turn so a lazy Fusor stream start can fire.
export const TICK_MS = 0;
// Long enough to confirm no message arrived.
export const NO_MESSAGE_WAIT_MS = 50;

// Resolve to "resolved" if the promise settles within `ms`, else "timeout".
export const withinMs = (p: Promise<unknown>, ms: number): Promise<string> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(() => "resolved"),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("timeout"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Bound teardown of an idle messages subscription: gracefully closing a stream
// that never received a live event waits on the (empty) queue, which is
// irrelevant to the assertions. Cap it so the test always returns.
export const settleSoon = (
  p: Promise<unknown> | undefined
): Promise<unknown> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise((resolve) => {
      timer = setTimeout(resolve, SETTLE_CAP_MS);
    }),
  ]).finally(() => clearTimeout(timer));
};

// Flush pending microtasks plus one macrotask turn, letting fire-and-forget
// promises (e.g. a tracker's background share) settle before assertions.
export const flush = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
