import { useCallback, useMemo, useState } from "react";
import { Code, FileDiff, FileQuestion } from "lucide-react";
import type { CodeViewDiffItem, CodeViewItem, FileDiffMetadata } from "@pierre/diffs";
import { CodeView, type CodeViewReactOptions } from "@pierre/diffs/react";
import { COLLAPSE_OVER } from "@/components/pr/diffModel";
import { Button } from "@/components/ui/button";
import { useCodeTheme } from "@/lib/codeTheme";
import { useCodeViewStore } from "@/stores/codeView";
import type { FilePlace } from "../fileActions";
import { FileEmptyState, NoticeBar } from "../states";
import { patchModelOf, type PatchFile, type PatchModel } from "./patch";
import { CommitHead, CommitRow, FileRow } from "./PatchRows";
import { SOURCE, type PreviewBodyProps } from "./types";
import "@/components/code/code.css";

/** Line height in code.css (--diffs-line-height): the CodeView lays out rows from it. */
const LINE_HEIGHT = 19;
/** The rows' height (h-9), for the same reason: every row, a file's or a commit's, is this tall. */
const HEADER_H = 36;

/** A commit's row in a mailbox is an item with no diff, always folded: CodeView has items only, and this keeps it in the virtualized list. */
function emptyDiff(name: string): FileDiffMetadata {
  return { name, type: "change", hunks: [], splitLineCount: 0, unifiedLineCount: 0, isPartial: true, deletionLines: [], additionLines: [] };
}

/** Starts folded: nothing to show but the row (a binary, a mode change), or a diff too long to want open (a lockfile). */
const foldedAtFirst = (f: PatchFile) => f.note !== null || f.lines > COLLAPSE_OVER;

type Row = { kind: "commit"; index: number } | { kind: "file"; file: PatchFile };

/**
 * The patch kind's body (docs/notes/file-previews-5-patch.md): the commit's subject on top
 * when the patch has one, then every file's section, its sticky row over its diff, in the
 * library's virtualized CodeView (as the PR Code tab), so a long patch mounts only what is in
 * view. A mailbox of several commits gets a row per commit before its files. Unified or
 * split and wrap follow the codeView store.
 */
export function PatchBody({ file, place, onMode }: PreviewBodyProps) {
  const text = file.text ?? "";
  const model = useMemo(() => patchModelOf(text), [text]);
  if (text.trim() === "") return <FileEmptyState icon={FileDiff} heading="Empty patch" detail="The file has nothing in it." testId="file-patch-empty" />;
  if (model.commits.length === 0)
    return (
      <FileEmptyState icon={FileQuestion} heading="No diff in this file" detail="Nothing in it reads as a diff." testId="file-patch-none">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onMode(SOURCE.id);
          }}
          data-testid="file-patch-show-source"
        >
          <Code aria-hidden />
          Show source
        </Button>
      </FileEmptyState>
    );
  return <PatchView model={model} place={place} />;
}

function PatchView({ model, place }: { model: PatchModel; place: FilePlace }) {
  const { theme, themeType } = useCodeTheme();
  const diffStyle = useCodeViewStore((s) => s.diffStyle);
  const wrap = useCodeViewStore((s) => s.wrap);
  const several = model.commits.length > 1;
  const single = several ? null : (model.commits[0]?.header ?? null);
  // Folded or not once the user chose, and how often (the item's version: CodeView re-reads an item only when it changes).
  const [folds, setFolds] = useState<Readonly<Record<string, { collapsed: boolean; version: number }>>>({});
  const { rows, byId } = useMemo(() => {
    const byId = new Map<string, Row>();
    const rows: { id: string; fileDiff: FileDiffMetadata; row: Row }[] = [];
    model.commits.forEach((c, i) => {
      if (several) {
        const row: Row = { kind: "commit", index: i };
        rows.push({ id: `commit:${String(i)}`, fileDiff: emptyDiff(`commit ${String(i)}`), row });
      }
      for (const f of c.files) rows.push({ id: f.id, fileDiff: f.fileDiff ?? emptyDiff(f.path), row: { kind: "file", file: f } });
    });
    for (const r of rows) byId.set(r.id, r.row);
    return { rows, byId };
  }, [model, several]);
  const items = useMemo(
    () =>
      rows.map(({ id, fileDiff, row }): CodeViewDiffItem => {
        if (row.kind === "commit") return { id, type: "diff", fileDiff, collapsed: true };
        const fold = folds[id];
        return { id, type: "diff", fileDiff, collapsed: fold?.collapsed ?? foldedAtFirst(row.file), version: fold?.version ?? 0 };
      }),
    [rows, folds],
  );
  const toggle = useCallback(
    (id: string) => {
      const row = byId.get(id);
      if (row?.kind !== "file") return;
      setFolds((s) => {
        const cur = s[id];
        const collapsed = cur?.collapsed ?? foldedAtFirst(row.file);
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
      itemMetrics: { lineHeight: LINE_HEIGHT, diffHeaderHeight: HEADER_H },
    }),
    [theme, themeType, diffStyle, wrap],
  );
  const renderHeader = useCallback(
    (item: CodeViewItem<undefined>) => {
      const row = byId.get(item.id);
      if (!row) return null;
      if (row.kind === "commit") return <CommitRow header={model.commits[row.index]?.header ?? null} index={row.index} count={model.commits.length} />;
      return <FileRow f={row.file} collapsed={item.collapsed ?? false} onToggle={toggle} place={place} />;
    },
    [byId, model, toggle, place],
  );
  const problems = model.problems;
  const top =
    single || problems > 0 || model.files.length === 0 ? (
      <>
        {problems > 0 && (
          <NoticeBar testId="file-patch-problems">
            {problems === 1 ? "1 file" : `${String(problems)} files`} did not parse whole: each shows what did. Source has the text as it is.
          </NoticeBar>
        )}
        {single && <CommitHead header={single} />}
        {model.files.length === 0 && <p className="px-3 py-2 text-caption">No file changes in this patch.</p>}
      </>
    ) : null;
  if (items.length === 0)
    return (
      <div className="min-h-0 flex-1 overflow-auto" data-testid="file-patch">
        {top}
      </div>
    );
  return (
    <div className="cf-code-view relative min-h-0 flex-1" data-testid="file-patch" data-style={diffStyle}>
      <CodeView items={items} options={options} className="absolute inset-0 overflow-auto" renderCustomHeader={renderHeader} renderCodeViewHeader={top ? () => top : undefined} />
    </div>
  );
}
