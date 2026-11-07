import { imageKey, type GalleryImage } from "@/surfaces/galleryTarget";

/** What a tile shows for an image. */
export type Thumb = { state: "loading" } | { state: "ready"; url: string } | { state: "failed"; reason: string };

/** A failure to show the user as it is; anything else reads as FAILED_READ. */
export class ImageFailure extends Error {}

/** What a tile says when the read itself failed. */
export const FAILED_READ = "Cannot read";

/**
 * How many images are read and shrunk at once. Each slot can hold a whole file and its full
 * decode, and a unary read shares the browser's six connections with the streams, so this
 * stays below what would queue a stream behind a picture.
 */
export const THUMB_SLOTS = 2;

interface Entry {
  image: GalleryImage;
  /** Tiles showing it now. */
  holders: number;
  thumb: Thumb;
  /** Set while it runs; what stops it when no tile wants it any more. */
  run: AbortController | null;
}

const LOADING: Thumb = { state: "loading" };

/**
 * One gallery's thumbnails, so a grid and its filmstrip read a file once. A tile holds what it
 * shows; only held images load, oldest ask first and at most THUMB_SLOTS at a time, and one
 * no tile holds any more stops, so a fast scroll does not leave a queue behind it. A thumbnail
 * that is ready stays until `clear`: it is small, which is what keeps full images out of the
 * grid. `load` gives a URL for the image; `revoke` frees one.
 */
export class ThumbStore {
  private entries = new Map<string, Entry>();
  private queue: Entry[] = [];
  private running = 0;
  private listeners = new Map<string, Set<() => void>>();

  constructor(
    private readonly load: (image: GalleryImage, signal: AbortSignal) => Promise<string>,
    private readonly revoke: (url: string) => void,
    private readonly slots = THUMB_SLOTS,
  ) {}

  /** What to show for the image with this key (a stable object until it changes). */
  peek(key: string): Thumb {
    return this.entries.get(key)?.thumb ?? LOADING;
  }

  /** Calls `listener` when the thumb for `key` changes. */
  subscribe(key: string, listener: () => void): () => void {
    const set = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, set);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0 && this.listeners.get(key) === set) this.listeners.delete(key);
    };
  }

  /** A tile shows `image`: it loads if it has to. Returns the release. */
  hold(image: GalleryImage): () => void {
    const key = imageKey(image);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { image, holders: 0, thumb: LOADING, run: null };
      this.entries.set(key, entry);
      this.queue.push(entry);
    }
    const held = entry;
    held.holders += 1;
    this.pump();
    return () => {
      held.holders -= 1;
      if (held.holders === 0 && held.thumb.state === "loading") this.drop(key, held);
    };
  }

  /** Stops everything and frees every thumbnail. The store can be used again after. */
  clear(): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.thumb.state === "ready") this.revoke(entry.thumb.url);
      this.drop(key, entry);
    }
  }

  /** Forgets an entry: out of the queue, stopped if it runs, so a later hold starts over. */
  private drop(key: string, entry: Entry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    this.queue = this.queue.filter((e) => e !== entry);
    entry.run?.abort();
    this.notify(key);
  }

  private pump(): void {
    while (this.running < this.slots) {
      const entry = this.queue.shift();
      if (!entry) return;
      this.running += 1;
      void this.start(entry).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private async start(entry: Entry): Promise<void> {
    const key = imageKey(entry.image);
    const run = new AbortController();
    entry.run = run;
    let thumb: Thumb;
    try {
      thumb = { state: "ready", url: await this.load(entry.image, run.signal) };
    } catch (err) {
      thumb = { state: "failed", reason: err instanceof ImageFailure ? err.message : FAILED_READ };
    }
    entry.run = null;
    if (this.entries.get(key) !== entry) {
      if (thumb.state === "ready") this.revoke(thumb.url);
      return;
    }
    entry.thumb = thumb;
    this.notify(key);
  }

  private notify(key: string): void {
    for (const listener of this.listeners.get(key) ?? []) listener();
  }
}
