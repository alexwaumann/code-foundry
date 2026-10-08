/** Minimal fan-out pub/sub with per-subscriber unbounded queues, for mock streams. */
export class Hub<T> {
  private readonly subs = new Set<(v: T) => void>();

  get size(): number {
    return this.subs.size;
  }

  publish(v: T): number {
    for (const s of this.subs) s(v);
    return this.subs.size;
  }

  /** Yields published values until the signal aborts. `initial` values are yielded first. */
  async *subscribe(signal: AbortSignal, initial: readonly T[] = []): AsyncGenerator<T> {
    const queue: T[] = [...initial];
    let wake: (() => void) | null = null;
    const push = (v: T) => {
      queue.push(v);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.subs.add(push);
    signal.addEventListener("abort", onAbort);
    try {
      while (!signal.aborted) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        await new Promise<void>((r) => {
          wake = r;
        });
        wake = null;
      }
    } finally {
      this.subs.delete(push);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
