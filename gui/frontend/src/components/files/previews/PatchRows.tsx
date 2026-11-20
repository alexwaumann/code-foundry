import { ChevronDown, ChevronRight, FileText, TriangleAlert } from "lucide-react";
import { statFile } from "@/api/files";
import { splitPath } from "@/components/diff/files";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { openFileInPanel } from "@/stores/filePanel";
import type { FilePlace } from "../fileActions";
import { commitDate, shortSha, type PatchCommitHeader, type PatchFile } from "./patch";

/** "dev · Nov 13, 2026 · a4a92c6", the parts the patch has. */
function byline(h: PatchCommitHeader): string {
  return [h.author, commitDate(h.date), shortSha(h.sha)].filter(Boolean).join(" · ");
}

/** A single commit's header above its files: the subject, the byline, the message. */
export function CommitHead({ header }: { header: PatchCommitHeader }) {
  const by = byline(header);
  return (
    <div className="px-3 pt-2.5 pb-2" data-testid="file-patch-commit-head">
      {header.subject && <p className="text-body font-semibold break-words">{header.subject}</p>}
      {by && <p className="text-caption-sm text-cf-text-muted">{by}</p>}
      {header.body && <p className="mt-1.5 text-body-sm whitespace-pre-wrap text-cf-text-muted">{header.body}</p>}
    </div>
  );
}

/** A commit's one-row header in a mailbox of several: the subject, then the byline. The row is the files' height (CodeView lays rows out by one height). */
export function CommitRow({ header, index, count }: { header: PatchCommitHeader | null; index: number; count: number }) {
  const by = header ? byline(header) : "";
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 border-t border-cf-divider bg-cf-surface px-3" data-testid="file-patch-commit">
      <span className="shrink-0 text-caption-sm text-cf-text-muted tabular-nums">
        {index + 1}/{count}
      </span>
      <Tip label={header?.subject ?? ""} whenTruncated align="start">
        <span className="min-w-0 truncate text-body-sm font-semibold">{header?.subject || "No commit message"}</span>
      </Tip>
      {by && <span className="ml-auto shrink-0 text-caption-sm text-cf-text-muted">{by}</span>}
    </div>
  );
}

const STATUS_WORD: Partial<Record<PatchFile["status"], string>> = { added: "added", deleted: "deleted", renamed: "renamed", copied: "copied" };

/** The path as the PR Code tab shows it: the directory muted and cut from its start, the name whole. */
function PathText({ path }: { path: string }) {
  const [dir, name] = splitPath(path);
  return (
    <span className="flex min-w-0 items-center">
      {dir && <span className="min-w-0 truncate text-cf-text-muted [direction:rtl]">{`‎${dir}‎`}</span>}
      <span className="max-w-full shrink-0 truncate">{name}</span>
    </span>
  );
}

/** Opens the file in a File tab when it is in the checkout; says so when it is not. */
function openInCheckout(place: FilePlace, path: string): void {
  statFile(place.dir, path).then(
    () => {
      openFileInPanel("current", { project: place.project, base: place.dir, path });
    },
    () => {
      notify({ level: "info", title: "Not in this checkout", description: path });
    },
  );
}

/**
 * A file's sticky row: fold chevron, the path (old → new for a rename), the status where it
 * is not a plain change, a mark when part of it did not parse, then what shows instead of a
 * diff or + and −, and Open file when it may be in the checkout. A click anywhere but Open
 * folds it.
 */
export function FileRow({ f, collapsed, onToggle, place }: { f: PatchFile; collapsed: boolean; onToggle: (id: string) => void; place: FilePlace }) {
  const foldable = f.note === null;
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const toggle = () => {
    if (foldable) onToggle(f.id);
  };
  const word = f.binary ? (f.status === "modified" ? null : STATUS_WORD[f.status]) : STATUS_WORD[f.status];
  const canOpen = place.project !== "" && f.status !== "deleted" && f.path !== "";
  return (
    <div
      className={cn("flex h-9 min-w-0 items-center gap-2 border-y border-cf-divider bg-cf-surface-sunken/40 px-2 text-body-sm dark:bg-cf-surface-sunken/30", foldable && "cursor-pointer")}
      onClick={toggle}
      data-testid="file-patch-file"
      data-path={f.path}
      data-collapsed={collapsed}
    >
      {foldable ? (
        <button
          type="button"
          aria-label={collapsed ? "Show file" : "Fold file"}
          aria-expanded={!collapsed}
          className="flex size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
          data-testid="file-patch-fold"
        >
          <Chevron className="size-3.5" aria-hidden />
        </button>
      ) : (
        <span className="size-5 shrink-0" />
      )}
      <Tip label={f.prevPath ? `${f.prevPath} → ${f.path}` : f.path} whenTruncated align="start">
        <span className="flex min-w-0 items-center gap-1.5 font-mono" data-testid="file-patch-path">
          {f.prevPath && (
            <>
              <span className="min-w-0 shrink-[2] truncate text-cf-text-muted">{f.prevPath}</span>
              <span className="shrink-0 text-cf-text-muted">→</span>
            </>
          )}
          <PathText path={f.path || "(no name)"} />
        </span>
      </Tip>
      {word && (
        <span className="shrink-0 text-caption-sm text-cf-text-muted" data-testid="file-patch-status">
          {word}
        </span>
      )}
      {f.problem && (
        <Tip label={`Partially parsed: ${f.problem}`}>
          <TriangleAlert className="size-3.5 shrink-0 text-cf-warning-text" aria-label="Partially parsed" data-testid="file-patch-problem" />
        </Tip>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-caption tabular-nums">
        {f.note !== null ? (
          <span className="font-sans" data-testid="file-patch-note">
            {f.note}
          </span>
        ) : collapsed ? (
          <span className="font-sans">{`${f.lines.toLocaleString()} lines`}</span>
        ) : null}
        {f.added > 0 && <span className="text-cf-diff-addition">+{f.added.toLocaleString()}</span>}
        {f.deleted > 0 && <span className="text-cf-diff-deletion">−{f.deleted.toLocaleString()}</span>}
      </span>
      {canOpen ? (
        <Tip label="Open file">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="shrink-0 text-cf-text-muted hover:text-cf-text"
            aria-label="Open file"
            onClick={(e) => {
              e.stopPropagation();
              openInCheckout(place, f.path);
            }}
            data-testid="file-patch-open"
          >
            <FileText aria-hidden />
          </Button>
        </Tip>
      ) : (
        // Its place stays, so + and − line up with the rows that have Open.
        <span className="size-6 shrink-0" />
      )}
    </div>
  );
}
