import { useContext, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { TAG_ACCENT, tagClass } from "@/components/compose/tagStyle";
import { Tip } from "@/components/ui/tooltip";
import { dirPart, fileName } from "@/lib/filePath";
import { chipTarget, type PathMatch, type PathPlace } from "@/lib/pathChips";
import { cn } from "@/lib/utils";
import { openFileInPanel } from "@/stores/filePanel";
import { useThreadsStore } from "@/stores/threads";
import { PathPlaceContext, useThreadCtx } from "./context";

/** The place chips under this component resolve against. */
function usePathPlace(): PathPlace {
  const place = useContext(PathPlaceContext);
  const { threadId, cwd } = useThreadCtx();
  const project = useThreadsStore((s) => s.byId[threadId]?.projectId ?? "");
  return place ?? { project, base: cwd };
}

/** Click (cmd-click too), Enter and Space open the file; the event stops here (a tool row's own toggle is under it). */
function useOpen(path: string, line: number | undefined) {
  const place = usePathPlace();
  const open = () => {
    openFileInPanel("current", chipTarget({ path, ...(line !== undefined && { line }) }, place));
  };
  return {
    onClick: (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    },
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      e.stopPropagation();
      open();
    },
  };
}

/**
 * A file path in Claude's markdown (lib/pathChips) as the user bubble's file tag (style A):
 * a file icon, the path in mono with its directory truncating from the start so the name
 * stays, the `:line` suffix muted. Opens the File tab in the side panel. A span with the
 * button role, so it can sit inside a tool row's button; its text stays selectable (copying
 * a paragraph keeps its paths). The tooltip shows the whole token only while it is cut short.
 */
export function PathChip({ match }: { match: PathMatch }) {
  const handlers = useOpen(match.path, match.line);
  const suffix = match.text.slice(match.path.length);
  const dir = dirPart(match.path);
  const name = fileName(match.path) + (match.path.endsWith("/") ? "/" : "");
  return (
    <Tip label={match.text} whenTruncated>
      <span
        role="button"
        tabIndex={0}
        className={tagClass(false, cn(TAG_ACCENT.file, "cursor-pointer font-mono font-normal select-text focus-visible:outline-2 focus-visible:outline-ring/60"))}
        data-testid="path-chip"
        data-path={match.path}
        {...handlers}
      >
        <FileText className="size-[1em] shrink-0 opacity-70" aria-hidden />
        <span className="flex min-w-0 items-center">
          {/* Truncates from its start (rtl box); the bdi keeps the slashes in place without marks a copy would carry. */}
          {dir && (
            <span className="min-w-0 truncate [direction:rtl]">
              <bdi>{dir}</bdi>
            </span>
          )}
          <span className="max-w-full shrink-0 truncate">{name}</span>
          {suffix && <span className="shrink-0 text-muted-foreground">{suffix}</span>}
        </span>
      </span>
    </Tip>
  );
}

/**
 * A tool row's path (Read, Edit, MultiEdit, Write, NotebookEdit; lib/toolSummary
 * toolFileTarget): the row's own label parts, quiet until hovered, when the tag's tint shows
 * it opens the file (at `line`). The rest of the row still expands and collapses it.
 */
export function ToolPathChip({ path, line, children }: { path: string; line?: number; children: ReactNode }) {
  const handlers = useOpen(path, line);
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`Open ${fileName(path)}`}
      className={cn(
        TAG_ACCENT.file,
        "-mx-0.5 cursor-pointer rounded-sm border border-transparent px-1 hover:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--color-border))] hover:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)] focus-visible:outline-2 focus-visible:outline-ring/60",
      )}
      data-testid="tool-path-chip"
      data-path={path}
      {...handlers}
    >
      {children}
    </span>
  );
}
