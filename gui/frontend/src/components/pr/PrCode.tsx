import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ExternalLink, Loader2, RefreshCw, TriangleAlert, WrapText } from "lucide-react";
import { CodeView, type CodeViewHandle, type CodeViewReactOptions } from "@pierre/diffs/react";
import type { CodeViewDiffItem, CodeViewItem, FileDiffContentsLoader } from "@pierre/diffs";
import { isTooLargeMessage, tooLargeText } from "@/api/prDiff";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tip } from "@/components/ui/tooltip";
import { Segmented } from "@/components/usage/Segmented";
import { useCodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";
import { setDiffStyle, setWrap, useCodeViewStore, type DiffStyle } from "@/stores/codeView";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { expandFailed, pullRequestDiffResource, readPullRequestFile, refreshPullRequestDiff, syncPullRequestDiff, usePrDiffStore } from "@/stores/prDiff";
import { sectionOpenByDefault, toggleSection, usePrPanelStore } from "@/stores/prPanel";
import { useResource } from "@/stores/resource";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { parsePrDiff, prFileLoader, type PrDiffFile, type PrDiffModel } from "./diffModel";
import "@/components/code/code.css";

const FILE_ROW_H = 24;
/** The file list shows this many rows, then scrolls (half a row peeks out). */
const FILE_ROWS = 7.5;
/** Line height in code.css (--diffs-line-height): the CodeView lays out rows from it. */
const LINE_HEIGHT = 19;
/** The file header's height (FileHeader h-9), for the same reason. */
const HEADER_H = 36;

const statusColor: Record<PrDiffFile["status"], string> = { A: "text-success", M: "text-warning", D: "text-destructive", R: "text-info" };

const styleOptions: readonly { value: DiffStyle; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

function Totals({ model }: { model: PrDiffModel }) {
  const n = model.files.length;
  return (
    <span className="min-w-0 truncate tabular-nums" data-testid="pr-code-totals">
      {n} {n === 1 ? "file" : "files"}
      {" · "}
      <span className="text-success">+{model.added.toLocaleString()}</span> <span className="text-destructive">−{model.deleted.toLocaleString()}</span>
    </span>
  );
}

/**
 * The strip: the file list's toggle with the totals, then Unified | Split, wrap and
 * refresh. The toggle stays a plain label until the diff has files.
 */
function Strip({ prRef, tabKey, model, listOpen }: { prRef: PrRef; tabKey: string; model: PrDiffModel | null; listOpen: boolean }) {
  const diffStyle = useCodeViewStore((s) => s.diffStyle);
  const wrap = useCodeViewStore((s) => s.wrap);
  const busy = usePrDiffStore((s) => s.refreshing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const Chevron = listOpen ? ChevronDown : ChevronRight;
  return (
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-2 border-b border-pane-border px-4 text-caption @max-[340px]:px-3" data-testid="pr-code-strip">
      {model && model.files.length > 0 ? (
        <button
          type="button"
          aria-expanded={listOpen}
          className="-ml-1 flex min-w-0 items-center gap-1 rounded-sm px-1 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            toggleSection(tabKey, "files");
          }}
          data-testid="pr-code-files-toggle"
        >
          <Chevron className="size-3.5 shrink-0" aria-hidden />
          <Totals model={model} />
        </button>
      ) : (
        <span className="min-w-0 flex-1" />
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <Segmented options={styleOptions} value={diffStyle} onChange={setDiffStyle} aria-label="Diff layout" data-testid="pr-code-style" />
        <Tip label={wrap ? "Lines wrap" : "Wrap long lines"}>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Wrap long lines"
            aria-pressed={wrap}
            className={cn(wrap ? "bg-muted text-foreground" : "text-muted-foreground")}
            onClick={() => {
              setWrap(!wrap);
            }}
            data-testid="pr-code-wrap"
          >
            <WrapText aria-hidden />
          </Button>
        </Tip>
        <Tip label="Fetch the diff from GitHub again">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh diff"
            className="text-muted-foreground"
            disabled={busy}
            onClick={() => void refreshPullRequestDiff(prRef.slug, prRef.number)}
            data-testid="pr-code-refresh"
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
          </Button>
        </Tip>
      </span>
    </div>
  );
}

/** A warning under the strip, with the way to the whole diff on GitHub. */
function Notice({ children, url, testId }: { children: ReactNode; url: string; testId: string }) {
  return (
    <div className="mx-4 mt-2 flex shrink-0 items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-caption text-warning" role="status" data-testid={testId}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      <button
        type="button"
        className="flex shrink-0 items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => void openUrl(`${url}/files`)}
        data-testid={`${testId}-open`}
      >
        Open on GitHub
        <ExternalLink className="size-3" aria-hidden />
      </button>
    </div>
  );
}

/** One file of the list: status letter, path (directory muted, truncating from its start), + and −. */
function FileRowButton({ f, onPick }: { f: PrDiffFile; onPick: (id: string) => void }) {
  return (
    <Tip label={f.prevPath ? `${f.prevPath} → ${f.path}` : f.path} align="start">
      <button
        type="button"
        className="grid h-full w-full grid-cols-[1.25rem_minmax(0,1fr)_5ch_5ch] items-center gap-x-2 rounded-sm px-1.5 text-left text-body-sm font-mono outline-none hover:bg-accent/50 focus-visible:ring-1 focus-visible:ring-ring"
        onClick={() => {
          onPick(f.id);
        }}
        data-testid="pr-code-file"
        data-path={f.path}
      >
        <span className={cn("text-center", statusColor[f.status])} data-status={f.status}>
          {f.status}
        </span>
        <span className="flex min-w-0 items-center">
          {f.dir && <span className="min-w-0 truncate text-left text-muted-foreground [direction:rtl]">{`‎${f.dir}‎`}</span>}
          <span className="max-w-full shrink-0 truncate">{f.name}</span>
        </span>
        <span className="text-right text-success tabular-nums">{f.added > 0 ? `+${String(f.added)}` : f.binary ? <span className="text-muted-foreground">bin</span> : ""}</span>
        <span className="text-right text-destructive tabular-nums">{f.deleted > 0 ? `−${String(f.deleted)}` : ""}</span>
      </button>
    </Tip>
  );
}

function FileList({ files, onPick }: { files: readonly PrDiffFile[]; onPick: (id: string) => void }) {
  return (
    <div className="shrink-0 border-b border-pane-border px-2.5 py-1" data-testid="pr-code-files">
      <RowList rows={files} rowKey={(f) => f.id} rowHeight={FILE_ROW_H} render={(f) => <FileRowButton f={f} onPick={onPick} />} capped maxHeight={FILE_ROWS * FILE_ROW_H} />
    </div>
  );
}

type Item = CodeViewDiffItem;

/**
 * A file's sticky header in the diff, drawn here rather than by the library (whose header
 * shows "-0 +0" for binaries and renames and counts in the other order): the fold chevron,
 * the status letter, the path as the list shows it, then + and −, "binary", or for a
 * folded file the way to open it.
 */
function FileHeader({ f, collapsed, onToggle }: { f: PrDiffFile; collapsed: boolean; onToggle: (id: string) => void }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const toggle = () => {
    onToggle(f.id);
  };
  return (
    <div className="flex h-9 min-w-0 items-center gap-2 border-y border-pane-border bg-muted/40 px-2 text-body-sm dark:bg-muted/30" data-testid="pr-code-header" data-path={f.path} data-collapsed={collapsed}>
      <button
        type="button"
        aria-label={collapsed ? "Show file" : "Fold file"}
        aria-expanded={!collapsed}
        className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={toggle}
        data-testid="pr-code-fold"
      >
        <Chevron className="size-3.5" aria-hidden />
      </button>
      <span className={cn("w-3 shrink-0 text-center font-mono", statusColor[f.status])}>{f.status}</span>
      <Tip label={f.prevPath ? `${f.prevPath} → ${f.path}` : f.path} whenTruncated={!f.prevPath} align="start">
        <span className="flex min-w-0 items-center font-mono">
          {f.dir && <span className="min-w-0 truncate text-muted-foreground [direction:rtl]">{`‎${f.dir}‎`}</span>}
          <span className="max-w-full shrink-0 truncate">{f.name}</span>
        </span>
      </Tip>
      <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-caption tabular-nums">
        {f.binary ? (
          <span>binary</span>
        ) : collapsed ? (
          <button type="button" className="rounded-sm px-1 font-sans outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring" onClick={toggle} data-testid="pr-code-show">
            {f.collapsed ? `${f.lines.toLocaleString()} lines · Show file` : "Show file"}
          </button>
        ) : null}
        {!f.binary && f.added > 0 && <span className="text-success">+{f.added}</span>}
        {!f.binary && f.deleted > 0 && <span className="text-destructive">−{f.deleted}</span>}
      </span>
    </div>
  );
}

/**
 * Every file as one item of the library's virtualized CodeView under a sticky FileHeader.
 * Folded: binaries, the long ones (diffModel COLLAPSE_OVER) until opened, and any the
 * user folds.
 */
const Diff = memo(function Diff({
  model,
  loader,
  viewRef,
}: {
  model: PrDiffModel;
  loader: FileDiffContentsLoader;
  viewRef: React.RefObject<CodeViewHandle<undefined, undefined> | null>;
}) {
  const { theme, themeType } = useCodeTheme();
  const diffStyle = useCodeViewStore((s) => s.diffStyle);
  const wrap = useCodeViewStore((s) => s.wrap);
  // Per file: folded or not once the user chose, and how often (the item's version: CodeView re-reads an item only when it changes).
  const [folds, setFolds] = useState<Readonly<Record<string, { collapsed: boolean; version: number }>>>({});
  const byId = useMemo(() => new Map(model.files.map((f) => [f.id, f])), [model]);
  const items = useMemo(
    () =>
      model.files.map((f): Item => {
        const fold = folds[f.id];
        return { id: f.id, type: "diff", fileDiff: f.fileDiff, collapsed: fold?.collapsed ?? (f.collapsed || f.binary), version: fold?.version ?? 0 };
      }),
    [model, folds],
  );
  const toggle = useCallback(
    (id: string) => {
      const f = byId.get(id);
      if (!f) return;
      setFolds((s) => {
        const cur = s[id];
        const collapsed = cur?.collapsed ?? (f.collapsed || f.binary);
        return { ...s, [id]: { collapsed: !collapsed, version: (cur?.version ?? 0) + 1 } };
      });
    },
    [byId],
  );
  const options = useMemo(
    (): CodeViewReactOptions<undefined, undefined> => ({
      theme,
      themeType,
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      disableFileHeader: false,
      stickyHeaders: true,
      diffIndicators: "bars",
      lineDiffType: "word-alt",
      loadDiffFiles: loader,
      itemMetrics: { lineHeight: LINE_HEIGHT, diffHeaderHeight: HEADER_H },
    }),
    [theme, themeType, diffStyle, wrap, loader],
  );
  const renderHeader = useCallback(
    (item: CodeViewItem<undefined>) => {
      const f = byId.get(item.id);
      return f ? <FileHeader f={f} collapsed={item.collapsed ?? false} onToggle={toggle} /> : null;
    },
    [byId, toggle],
  );
  return (
    <div className="cf-code-view relative min-h-0 flex-1" data-testid="pr-code-diff" data-code="diff">
      <CodeView
        ref={viewRef}
        items={items}
        options={options}
        className="absolute inset-0 overflow-auto"
        renderCustomHeader={renderHeader}
      />
    </div>
  );
});

function LoadingDiff() {
  return (
    <div className="flex flex-col gap-2 p-4" aria-busy="true" aria-label="Loading diff" data-testid="pr-code-loading">
      <Skeleton className="h-3.5 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-4/5" />
      <Skeleton className="mt-3 h-3.5 w-1/2" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}

/**
 * The Code tab: the pull request's diff (GhService.GetPullRequestDiff through
 * pullRequestDiffResource), parsed once per read, as a file list over one virtualized
 * CodeView. Expanding unchanged lines reads the file at the head commit
 * (diffModel.prFileLoader). Read when the tab shows; read again when the head moves.
 */
export function PrCode({ prRef, tabKey, url }: { prRef: PrRef; tabKey: string; url: string }) {
  const key = pullRequestKey(prRef.slug, prRef.number);
  const entry = useResource(pullRequestDiffResource, key);
  const detailHead = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.headSha ?? "");
  const headRepo = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.headRepoSlug ?? "");
  const listOpen = usePrPanelStore((s) => s.byTab[tabKey]?.open.files ?? sectionOpenByDefault.files);
  const data = entry?.data ?? null;
  useEffect(() => {
    syncPullRequestDiff(key, detailHead, data);
  }, [key, detailHead, data]);
  const model = useMemo(() => (data ? parsePrDiff(data.diff, data.headSha) : null), [data]);
  const head = data?.headSha || detailHead;
  // The head side of a fork's pull request lives in the fork; GitHub also keeps the head
  // commit in the base repository, which serves when the fork is unknown (closed, deleted).
  const loader = useMemo((): FileDiffContentsLoader => {
    const load = prFileLoader(headRepo || prRef.slug, head, readPullRequestFile);
    return (fd) =>
      load(fd).catch((err: unknown) => {
        expandFailed(fd.name, err);
        throw err;
      });
  }, [headRepo, prRef.slug, head]);
  const viewRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const pick = useCallback((id: string) => {
    viewRef.current?.scrollTo({ type: "item", id, align: "start" });
  }, []);
  const error = entry?.error ?? null;
  const tooLarge = !data && isTooLargeMessage(error);

  let body: ReactNode;
  if (!data) {
    if (tooLarge && error) {
      body = (
        <Notice url={url} testId="pr-code-too-large">
          GitHub cannot show this diff here: {tooLargeText(error)}
        </Notice>
      );
    } else if (error) {
      body = (
        <p className="px-4 py-3 text-caption text-destructive" role="alert" data-testid="pr-code-error">
          Cannot load the diff: {error}
        </p>
      );
    } else {
      body = <LoadingDiff />;
    }
  } else if (model && model.files.length === 0) {
    body = (
      <p className="px-4 py-3 text-caption" data-testid="pr-code-empty">
        No changes.
      </p>
    );
  } else if (model) {
    body = (
      <>
        {data.truncated && (
          <Notice url={url} testId="pr-code-truncated">
            The diff is over 4 MiB: showing its first {model.files.length.toLocaleString()} files.
          </Notice>
        )}
        {error && (
          <p className="shrink-0 px-4 pt-2 text-caption text-destructive" data-testid="pr-code-refresh-error">
            Could not refresh: {error}
          </p>
        )}
        {listOpen && <FileList files={model.files} onPick={pick} />}
        <Diff model={model} loader={loader} viewRef={viewRef} />
      </>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pr-code">
      <Strip prRef={prRef} tabKey={tabKey} model={model} listOpen={listOpen} />
      {body}
    </div>
  );
}
