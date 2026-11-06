interface QueuedKey {
  data: Uint8Array;
  failed: (err: unknown) => void;
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0]) return chunks[0];
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Typed input on its way to the daemon: per terminal, one Write in flight and later bytes
 * coalesced, so keys cannot reorder across concurrent requests. It outlives any one view,
 * because a remount (cmd+j) brings a new AttachController while the old one's keys still
 * wait: the app keeps one of these for all of them (TerminalHost). A queue exists only while
 * it has something to send, so a closed terminal's goes with its failed Write.
 */
export class TerminalInput {
  private readonly queues = new Map<string, QueuedKey[]>();

  constructor(private readonly write: (id: string, data: Uint8Array) => Promise<void>) {}

  /** Queues data for terminal id. `failed` runs if it, or a key ahead of it, cannot be written. */
  send(id: string, data: Uint8Array, failed: (err: unknown) => void): void {
    const queue = this.queues.get(id);
    if (queue) {
      queue.push({ data, failed });
      return;
    }
    const started = [{ data, failed }];
    this.queues.set(id, started);
    void this.flush(id, started);
  }

  private async flush(id: string, queue: QueuedKey[]): Promise<void> {
    try {
      while (queue.length > 0) {
        const keys = queue.splice(0);
        try {
          await this.write(id, concat(keys.map((k) => k.data)));
        } catch (err) {
          // Later keys would land with a hole before them.
          const dropped = [...keys, ...queue.splice(0)];
          for (const failed of new Set(dropped.map((k) => k.failed))) failed(err);
        }
      }
    } finally {
      this.queues.delete(id);
    }
  }
}
