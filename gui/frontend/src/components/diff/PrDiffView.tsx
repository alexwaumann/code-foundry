import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ExternalLink, FileDiff, FileX, GitCompare, RefreshCw, TriangleAlert } from "lucide-react";
import { isTooLargeMessage, tooLargeText } from "@/api/prDiff";
import { FileEmptyState, FileLoading, NoticeBar } from "@/components/files/states";
import { CopyPathAction, FileHeader, HeaderAction, WrapToggle } from "@/components/files/FileHeader";
import { parsePrDiff, type PrDiffFile, type PrDiffModel } from "@/components/pr/diffModel";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { useHeight, useWidth } from "@/lib/useWidth";
import { setTabParams } from "@/shell/host";
import { openUrl, pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { pullRequestDiffResource, pullRequestFileLoader, refreshPullRequestDiff, syncPullRequestDiff } from "@/stores/prDiff";
import { pullRequestUrl } from "@/stores/prPanel";
import { useResource } from "@/stores/resource";
import { prDiffTab, type PrDiffTarget } from "@/surfaces/prDiffTarget";
import type { FileDiffContentsLoader } from "@pierre/diffs";
import { StyleSwitch } from "./CompareBar";
import { DiffCode } from "./DiffFile";
import { FileList, type ListedView } from "./FileList";
import { pickRow, type FileRow } from "./files";
import { prFileOf, prFileRows, prListedView } from "./prDiff";

/** From this width the tab has a file list column beside the diff; narrower, only the files control. Its real width, not the window's. */
export const PR_RAIL_MIN = 680;

/** The files control's list: as tall as this at most. */
const MENU_H = 360;

/** "3 files · +7 −5": the diff's counts, on the files control. */
function Totals({ view }: { view: ListedView }) {
  return (
    <span className="min-w-0 truncate tabular-nums" data-testid="pr-diff-totals">
      {view.totalFiles} {view.totalFiles === 1 ? "file" : "files"}
      <span className="ml-1.5 text-cf-diff-addition">+{view.totalAdded.toLocaleString()}</span>
      <span className="ml-1 text-cf-diff-deletion">−{view.totalDeleted.toLocaleString()}</span>
    </span>
  );
}

/** The files control: the counts, and the list as a menu (the only list when the tab is narrow). Picking a file closes it. */
function FilesMenu({ view, rows, current, onPick }: { view: ListedView; rows: readonly FileRow[]; current: FileRow | null; onPick: (r: FileRow) => void }) {
  const [open, setOpen] = useState(false);
  const pick = useCallback(
    (r: FileRow) => {
      setOpen(false);
      onPick(r);
    },
    [onPick],
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="min-w-0 font-normal" aria-label={`Files: ${String(view.totalFiles)}`} data-testid="pr-diff-files">
          <Totals view={view} />
          <ChevronDown className="text-cf-text-muted" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-80 flex-col overflow-hidden p-0" style={{ height: Math.min(MENU_H, 44 + rows.length * 30) }} data-testid="pr-diff-files-menu">
        <FileList view={view} rows={rows} current={current} onPick={pick} rail height={MENU_H} query="" onQuery={noop} fold={undefined} onFold={noop} totals={false} className="w-full flex-1 border-r-0" />
      </PopoverContent>
    </Popover>
  );
}

const noop = (): void => undefined;

/**
 * The bar: base ← head, then the files control with the counts, Unified | Split, and at the
 * right end `review`, the slot a Review button goes in (docs/notes/pr-diff-tab.md). Before the
 * diff has loaded there is no files control.
 */
function Bar({ base, head, files, review }: { base: string; head: string; files: ReactNode; review?: ReactNode }) {
  const refs = base && head ? `${base} ← ${head}` : "";
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-cf-divider px-3" data-testid="pr-diff-bar">
      <Tip label={refs} whenTruncated align="start">
        <span className="min-w-0 flex-1 truncate text-caption font-mono" data-testid="pr-diff-refs">
          {refs}
        </span>
      </Tip>
      <span className="flex shrink-0 items-center gap-1.5">
        {files}
        <StyleSwitch />
        {/* The Review slot: a later change puts the pull request's Review button here, at the bar's right end. */}
        {review && (
          <span className="flex items-center" data-testid="pr-diff-review-slot">
            {review}
          </span>
        )}
      </span>
    </div>
  );
}

/** One file of the diff: the Diff tab's header and code, from the patch, its hunks expanded by reading the head commit's copy. */
function PrFile({ file, row, loader, url, onRefresh }: { file: PrDiffFile | undefined; row: FileRow; loader: FileDiffContentsLoader; url: string; onRefresh: () => void }) {
  const input = useMemo(() => (file ? { fileDiff: file.fileDiff, loadDiffFiles: loader } : null), [file, loader]);
  const code = file && !file.binary && file.lines > 0 && input;
  const actions = (
    <>
      {code && <WrapToggle />}
      <CopyPathAction path={row.path} />
      <HeaderAction
        icon={ExternalLink}
        label="Open on GitHub"
        testId="pr-diff-open-github"
        onClick={() => {
          void openUrl(`${url}/files`);
        }}
      />
      <HeaderAction icon={RefreshCw} label="Refresh" testId="pr-diff-refresh" onClick={onRefresh} />
    </>
  );
  let body: ReactNode;
  if (!file) body = <FileEmptyState icon={GitCompare} heading="No changes" detail={`${row.path} is no longer in this pull request's diff.`} testId="pr-diff-unlisted" />;
  else if (file.binary) body = <FileEmptyState icon={FileX} heading="Binary file" detail={file.status === "A" ? "Added" : file.status === "D" ? "Deleted" : "Changed"} testId="pr-diff-binary" />;
  else if (file.lines === 0 && file.prevPath) body = <FileEmptyState icon={GitCompare} heading="Renamed" detail={`From ${file.prevPath}; the contents are the same.`} testId="pr-diff-renamed" />;
  else if (!code) body = <FileEmptyState icon={GitCompare} heading="No changes in the contents" testId="pr-diff-none" />;
  else body = <DiffCode input={code} lines={file.lines} />;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pr-diff-file" data-path={row.path}>
      <FileHeader icon={FileDiff} name={row.name} dir={row.dir} fullPath={row.oldPath ? `${row.path}\nrenamed from ${row.oldPath}` : row.path} actions={actions} />
      {body}
    </div>
  );
}

/**
 * The diff once the pull request's detail has loaded, so the daemon's diff cache (keyed by the
 * cached detail's head) answers the first read: read while the tab shows, again when the head
 * moves (syncPullRequestDiff), and by Refresh.
 */
function Loaded({ tabId, target, rail, height, base, head, url, review }: { tabId: string; target: PrDiffTarget; rail: boolean; height: number; base: string; head: string; url: string; review?: ReactNode }) {
  const key = pullRequestKey(target.slug, target.number);
  const entry = useResource(pullRequestDiffResource, key);
  const detailHead = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.headSha ?? "");
  const headRepo = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.headRepoSlug ?? "");
  const data = entry?.data ?? null;
  useEffect(() => {
    syncPullRequestDiff(key, detailHead, data);
  }, [key, detailHead, data]);
  const model = useMemo<PrDiffModel | null>(() => (data ? parsePrDiff(data.diff, data.headSha) : null), [data]);
  const sha = data?.headSha || detailHead;
  const loader = useMemo(() => pullRequestFileLoader(target.slug, headRepo, sha), [target.slug, headRepo, sha]);
  const rows = useMemo(() => (model ? prFileRows(model) : []), [model]);
  const view = useMemo(() => (model ? prListedView(model) : null), [model]);
  const current = model ? pickRow(rows, target.file) : null;
  const listed = current !== null && rows.includes(current);

  // What the tab shows is its params, kept over its newest ones: nothing about that opens or activates it.
  const keep = useCallback(
    (file: string) => {
      setTabParams("current", tabId, (now) => prDiffTab({ slug: now.slug ?? target.slug, number: Number(now.number ?? target.number), file }).params);
    },
    [tabId, target.slug, target.number],
  );
  // The first file shown is the tab's from here on, or the next one to sort above it would take over.
  useEffect(() => {
    if (!target.file && current) keep(current.path);
  }, [target.file, current, keep]);
  const pick = useCallback(
    (r: FileRow) => {
      keep(r.path);
    },
    [keep],
  );
  const refresh = useCallback(() => {
    void refreshPullRequestDiff(target.slug, target.number);
  }, [target.slug, target.number]);

  const error = entry?.error ?? null;
  const files = view && rows.length > 0 ? <FilesMenu view={view} rows={rows} current={listed ? current : null} onPick={pick} /> : null;
  let body: ReactNode;
  if (!data || !model) {
    if (error && isTooLargeMessage(error)) {
      body = (
        <FileEmptyState icon={TriangleAlert} heading="GitHub cannot show this diff here" detail={tooLargeText(error)} testId="pr-diff-too-large">
          <Button variant="outline" size="sm" onClick={() => void openUrl(`${url}/files`)} data-testid="pr-diff-too-large-open">
            Open on GitHub
          </Button>
        </FileEmptyState>
      );
    } else if (error) {
      body = (
        <FileEmptyState icon={TriangleAlert} heading="Cannot load the diff" detail={error} testId="pr-diff-error">
          <Button variant="outline" size="sm" onClick={() => { pullRequestDiffResource.invalidate(key); }} data-testid="pr-diff-retry">
            Retry
          </Button>
        </FileEmptyState>
      );
    } else {
      body = <FileLoading />;
    }
  } else if (model.files.length === 0 || !current || !view) {
    body = <FileEmptyState icon={GitCompare} heading="No changes" detail="This pull request changes no files." testId="pr-diff-empty" />;
  } else {
    body = (
      <>
        {data.truncated && (
          <NoticeBar testId="pr-diff-truncated">
            The diff is over 4 MiB: showing its first {model.files.length.toLocaleString()} files.{" "}
            <button type="button" className="font-medium outline-none hover:underline focus-visible:ring-1 focus-visible:ring-cf-focus" onClick={() => void openUrl(`${url}/files`)} data-testid="pr-diff-truncated-open">
              Open on GitHub
            </button>
          </NoticeBar>
        )}
        {error && <NoticeBar testId="pr-diff-refresh-error">Could not refresh: {error}</NoticeBar>}
        <div className="flex min-h-0 flex-1">
          {rail && <FileList view={view} rows={rows} current={listed ? current : null} onPick={pick} rail height={height} query="" onQuery={noop} fold={undefined} onFold={noop} totals={false} />}
          <PrFile key={current.key} file={listed ? prFileOf(model, current) : undefined} row={current} loader={loader} url={url} onRefresh={refresh} />
        </div>
      </>
    );
  }
  return (
    <>
      <Bar base={base} head={head} files={files} review={review} />
      {body}
    </>
  );
}

/**
 * A pull request's diff in a tab of its own (surfaces/prdiff.ts): the Diff tab's file list and
 * file view over GitHub's diff, so any pull request shows, with or without a checkout. A bar
 * (base ← head, the files control, Unified | Split, the Review slot); at PR_RAIL_MIN and wider
 * the file list is a column on the left, narrower the files control is the list.
 * docs/notes/pr-diff-tab.md.
 */
export function PrDiffView({ tabId, target, review }: { tabId: string; target: PrDiffTarget; review?: ReactNode }) {
  const key = pullRequestKey(target.slug, target.number);
  useEffect(() => pullRequestDetailResource.watch(key), [key]);
  const ready = pullRequestDetailResource.store((s) => s.entries[key]?.data != null || s.entries[key]?.error != null);
  const base = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.baseRef ?? "");
  const head = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.headRef ?? "");
  const url = pullRequestDetailResource.store((s) => s.entries[key]?.data?.pullRequest.url ?? "") || pullRequestUrl(target);
  const [ref, width] = useWidth(PR_RAIL_MIN);
  const height = useHeight(ref);
  const rail = width >= PR_RAIL_MIN;
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="pr-diff" data-layout={rail ? "rail" : "menu"}>
      {ready ? (
        <Loaded tabId={tabId} target={target} rail={rail} height={height} base={base} head={head} url={url} review={review} />
      ) : (
        <>
          <Bar base={base} head={head} files={null} review={review} />
          <FileLoading />
        </>
      )}
    </div>
  );
}
