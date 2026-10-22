import { useState } from "react";
import { CircleQuestionMark, EyeOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { isMemoryEntryGone } from "@/api/memory";
import { SectionCard } from "@/components/settings/SectionCard";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { leftOutReason, rememberedWhen, type MemoryBy } from "@/lib/memory";
import { cn } from "@/lib/utils";
import { runCommand, runCommandForResult } from "@/stores/commands";
import { loadMemory, useMemoryBy, useMemoryCaps, useMemoryCount, useMemoryEntry, useMemoryFiles, useMemoryStatus, useMemoryStore } from "@/stores/memory";
import { useUiStore } from "@/stores/ui";
import { closeSettings, useViewsStore } from "@/stores/views";

/** Opens a thread from the page: it becomes the selection, which leaves Settings. */
function openThread(id: string): void {
  useUiStore.getState().select({ kind: "thread", id }, { focusPrompt: true });
  if (useViewsStore.getState().settingsOpen) closeSettings();
}

/**
 * "by <thread>": a link to it while it exists (struck through, "(archived)", once
 * archived); its recorded name, struck through, "(removed)", once it is gone.
 */
function ByThread({ by }: { by: Extract<MemoryBy, { kind: "thread" }> }) {
  const gone = by.state !== "live";
  return (
    <>
      {" · by "}
      {by.state === "removed" ? (
        <span className="line-through" data-testid="memory-by" data-state={by.state}>
          {by.name}
        </span>
      ) : (
        <button
          type="button"
          className={cn("rounded-sm underline underline-offset-2 outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus", gone && "line-through")}
          onClick={() => {
            openThread(by.id);
          }}
          data-testid="memory-by"
          data-state={by.state}
        >
          {by.name}
        </button>
      )}
      {gone && ` (${by.state})`}
    </>
  );
}

/**
 * Forgets an entry by its id, never its position: the list may be stale (a file removed
 * by hand a moment ago), and a position would then name another entry. An id that is
 * gone is refused; the page says so and reads the memory again.
 */
async function forget(id: string): Promise<void> {
  const seen = { gone: false };
  await runCommandForResult(
    "memory.remove",
    { id },
    {
      expected: (err) => {
        seen.gone = isMemoryEntryGone(err);
        return seen.gone;
      },
    },
  );
  if (!seen.gone) return;
  toast.info("That entry is gone; the list was refreshed.");
  await loadMemory();
}

/** One entry: its text, when and by whom, whether threads get it, and Forget. */
function MemoryRow({ file, className }: { file: string; className?: string | undefined }) {
  const entry = useMemoryEntry(file);
  const by = useMemoryBy(file);
  const caps = useMemoryCaps();
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  if (!entry) return null;
  const when = rememberedWhen(entry.createdMs, now);
  const leftOut = leftOutReason(entry.leftOut, caps);
  return (
    <div
      className={cn("group flex min-w-0 items-start gap-3 px-4 py-3 hover:bg-cf-control-hover/40", className)}
      data-testid="memory-row"
      data-file={file}
      data-injected={entry.injected}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className={cn("text-label break-words", leftOut && "text-cf-text-muted")} data-testid="memory-text">
          {entry.text}
        </p>
        <p className="text-caption-sm" data-testid="memory-meta">
          {when ? `Remembered ${when}` : "Added by hand"}
          {by?.kind === "thread" && <ByThread by={by} />}
        </p>
        {leftOut && (
          <p className="flex items-start gap-1.5 text-caption-sm text-cf-warning" data-testid="memory-left-out" data-reason={entry.leftOut}>
            <EyeOff className="mt-px size-3 shrink-0" aria-hidden />
            {leftOut}
          </p>
        )}
      </div>
      <Tip label="Forget">
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-cf-text-muted hover:text-cf-text"
          aria-label="Forget"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void forget(entry.id).finally(() => {
              setBusy(false);
            });
          }}
          data-testid="memory-forget"
        >
          <Trash2 aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}

/** No entries: what the memory is for, and how to add one. */
function EmptyMemory() {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-8 text-center" data-testid="memory-empty">
      <p className="text-label font-semibold">Nothing remembered yet</p>
      <p className="text-caption">Tell a thread how you like things done and it will be kept here, for every thread in every project.</p>
      <span className="mt-2 rounded-full bg-cf-surface-sunken px-3 py-1 text-caption text-cf-text">“from now on, open PRs as drafts”</span>
    </div>
  );
}

/** "N of 40" and Forget all (hidden with nothing to forget). */
function RememberedAside() {
  const { count, max } = useMemoryCount();
  const ready = useMemoryStatus() === "ready";
  if (!ready) return null;
  return (
    <div className="flex shrink-0 items-center gap-3">
      <span className="text-caption tabular-nums" data-testid="memory-count">
        {count} of {max}
      </span>
      {count > 0 && (
        <Button
          variant="outline"
          size="xs"
          onClick={() => {
            void runCommand("memory.clear");
          }}
          data-testid="memory-forget-all"
        >
          Forget all
        </Button>
      )}
    </div>
  );
}

/**
 * Settings › Memory › Remembered: every entry of the app memory with when and by which
 * thread it was remembered, each with Forget; Forget all asks first (memory.clear's
 * confirmation). Nothing adds here: a thread is told to remember.
 */
export function RememberedSection() {
  const files = useMemoryFiles();
  const status = useMemoryStatus();
  const loadError = useMemoryStore((s) => s.loadError);
  const readError = useMemoryStore((s) => s.snapshot?.error ?? "");
  return (
    <SectionCard id="remembered" heading="Remembered" description="Every thread in every project reads these before its first action." aside={<RememberedAside />}>
      {readError && (
        <p className="border-b border-cf-border px-4 py-3 text-caption break-words text-cf-warning" role="alert" data-testid="memory-read-error">
          The memory could not be read, so this is the last list read: {readError}
        </p>
      )}
      {status === "loading" ? (
        <p className="px-4 py-3 text-caption">Loading…</p>
      ) : status === "outdated" ? (
        <p className="px-4 py-3 text-caption" data-testid="memory-outdated">
          The daemon is older than this window and cannot show the memory. Restart it to see this page.
        </p>
      ) : status === "error" ? (
        <p className="px-4 py-3 text-caption break-words text-cf-error" role="alert" data-testid="memory-load-error">
          Cannot read the memory: {loadError}
        </p>
      ) : files.length === 0 ? (
        <EmptyMemory />
      ) : (
        <>
          {files.map((f, i) => (
            <MemoryRow key={f} file={f} className={i > 0 ? "border-t border-cf-border" : undefined} />
          ))}
          <p className="flex items-center gap-2 border-t border-cf-border px-4 py-2.5 text-caption" data-testid="memory-footnote">
            <CircleQuestionMark className="size-3.5 shrink-0" aria-hidden />
            Applies to new threads at once, and to open threads with their next message after a restart.
          </p>
        </>
      )}
    </SectionCard>
  );
}
