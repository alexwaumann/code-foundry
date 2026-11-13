/**
 * Keeps a test that timed out from running on into the tests after it. Vitest fails a test at its
 * timeout and goes on, but the body keeps running: in a file whose fakes live at module level (a
 * world, the stores, the fake layout), its later steps act on the next test's, and one slow test
 * under load fails dozens after it (docs/notes/shell-24b-flakes.md).
 *
 * Use this `it` in place of vitest's, register `trackTests()` at the top of the file, and await
 * `bodyDone()` first in its afterEach, before cleanup: a timed-out body then ends against its own
 * DOM and fakes. Harness steps call `throwIfTimedOut()`, so such a body ends at its next step.
 */
import { beforeEach, it as base, type TestContext } from "vitest";

let body: Promise<void> = Promise.resolve();
let signal: AbortSignal | undefined;

function tracked<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => Promise<void> {
  return (...args) => {
    const p = Promise.resolve().then(async () => {
      await fn(...args);
    });
    body = p;
    return p;
  };
}

/** Vitest's `it` (a name, the body, an optional timeout) with the body recorded for bodyDone. */
export function it(name: string, fn: (ctx: TestContext) => unknown, timeout?: number): void {
  base(name, tracked(fn), timeout);
}

/** Vitest's `it.each` with each body recorded for bodyDone. */
it.each = <T extends unknown[]>(cases: readonly T[]) =>
  (name: string, fn: (...args: T) => unknown, timeout?: number): void => {
    base.each<T>(cases)(name, tracked(fn), timeout);
  };

/** Keeps each test's abort signal (aborted when it times out) for throwIfTimedOut. */
export function trackTests(): void {
  beforeEach((ctx) => {
    signal = ctx.signal;
  });
}

/** Waits until the last test's body has ended, however it ended. */
export async function bodyDone(): Promise<void> {
  await body.catch(() => undefined);
}

/** Throws in a body whose test timed out: it stops at its next step. */
export function throwIfTimedOut(): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("the test timed out");
}
