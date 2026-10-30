/**
 * Watches files on disk for the views that show them live: an inline page's card and its
 * Expand modal reload when their file is written (docs/notes/page-card-reload.md). One
 * watch per file, shared by every view of it: its stamp (size and modification time,
 * api/files.ts statFile) is read when the first view mounts, then every STAMP_POLL_MS
 * while the window is visible and at once when it becomes visible again. A stamp unlike
 * the last one calls the file's listeners; a file that went away calls nothing until it is
 * back. Any writer counts: the thread's Edit or Write, its Bash (`cp` over the file,
 * `touch`, `sed -i`), another thread, the user's editor. The last view to go stops it.
 *
 * A poll, not a stream: WebKit gives the daemon six connections and a stream holds one for
 * its life (docs/notes/plugins-12-renderer-defects.md), and a stat a second of the few
 * files on screen costs nothing.
 */
import { statFile, type FileStamp } from "@/api/files";
import { isPageVisible, onBecameVisible } from "@/api/stream";

/** How often a watched file's stamp is read while the window is visible. */
export const STAMP_POLL_MS = 1000;

export interface FileWatcherDeps {
  /** The stamp of the file at an absolute path. */
  stat: (abs: string) => Promise<FileStamp>;
  every?: number;
  visible?: () => boolean;
  /** Calls the callback each time the window becomes visible; returns the unsubscribe. */
  onVisible?: (cb: () => void) => () => void;
}

export interface FileWatcher {
  /** Calls `onChange` each time the file at `abs` is written; returns the unsubscribe. */
  watch: (abs: string, onChange: () => void) => () => void;
  /** Reads the file's stamp now (a tool just wrote it), not at the next poll; nothing when unwatched. */
  check: (abs: string) => void;
}

interface Watch {
  listeners: Set<() => void>;
  /** The last stamp read; null until the first answer. */
  stamp: FileStamp | null;
  timer: ReturnType<typeof setInterval>;
  /** A read is out; `again`: another was asked for meanwhile. */
  busy: boolean;
  again: boolean;
}

export function createFileWatcher(deps: FileWatcherDeps): FileWatcher {
  const { stat, every = STAMP_POLL_MS, visible = isPageVisible, onVisible = onBecameVisible } = deps;
  const watches = new Map<string, Watch>();
  let stopVisible: (() => void) | null = null;

  const check = (abs: string) => {
    const w = watches.get(abs);
    if (!w) return;
    if (w.busy) {
      w.again = true;
      return;
    }
    w.busy = true;
    stat(abs)
      .then((now) => {
        if (watches.get(abs) !== w) return;
        const before = w.stamp;
        w.stamp = now;
        if (before !== null && now !== "" && now !== before) for (const l of [...w.listeners]) l();
      })
      .catch(() => {
        // The daemon is away or the read failed: keep the last stamp, try at the next poll.
      })
      .finally(() => {
        w.busy = false;
        if (w.again && watches.get(abs) === w) {
          w.again = false;
          check(abs);
        }
      });
  };

  const watch = (abs: string, onChange: () => void) => {
    let w = watches.get(abs);
    if (!w) {
      const timer = setInterval(() => {
        if (visible()) check(abs);
      }, every);
      w = { listeners: new Set(), stamp: null, timer, busy: false, again: false };
      watches.set(abs, w);
      stopVisible ??= onVisible(() => {
        for (const k of watches.keys()) check(k);
      });
      check(abs);
    }
    const entry = w;
    const l = () => {
      onChange();
    };
    entry.listeners.add(l);
    return () => {
      entry.listeners.delete(l);
      if (entry.listeners.size > 0 || watches.get(abs) !== entry) return;
      clearInterval(entry.timer);
      watches.delete(abs);
      if (watches.size === 0) {
        stopVisible?.();
        stopVisible = null;
      }
    };
  };

  return { watch, check };
}

/** The app's watcher, over the daemon. */
export const fileWatcher: FileWatcher = createFileWatcher({ stat: (abs) => statFile("", abs) });
