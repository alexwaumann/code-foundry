import { memo, useMemo, type ReactNode } from "react";
import { MultiFileDiff, PatchDiff, Virtualizer, type FileDiffOptions } from "@pierre/diffs/react";
import { useCodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";
import { useCodeViewStore, type DiffStyle } from "@/stores/codeView";
import "./code.css";

/** One side of a diff: a file name (its extension picks the language) and its text. */
export interface CodeSide {
  name: string;
  contents: string;
}

/** A unified patch for one file, or both sides' contents (a side null for an added or deleted file). */
export type CodeDiffInput = { patch: string } | { oldFile: CodeSide | null; newFile: CodeSide };

export type CodeDiffProps = CodeDiffInput & {
  /** The codeView store's choice when unset. */
  diffStyle?: DiffStyle;
  /** Long lines wrap instead of scrolling; the codeView store's choice when unset. */
  wrap?: boolean;
  /** Line numbers in the gutter (on by default; off for snippets whose place in the file is unknown). */
  lineNumbers?: boolean;
  className?: string;
};

type Options = FileDiffOptions<undefined, undefined>;

/** The house options every diff shares; the rest are the library's defaults (word-alt inline diff, line-info separators). */
function useDiffOptions({ diffStyle, wrap, lineNumbers = true }: Pick<CodeDiffProps, "diffStyle" | "wrap" | "lineNumbers">): Options {
  const { theme, themeType } = useCodeTheme();
  const store = useCodeViewStore((s) => s.diffStyle);
  const storeWrap = useCodeViewStore((s) => s.wrap);
  const style = diffStyle ?? store;
  const overflow = (wrap ?? storeWrap) ? "wrap" : "scroll";
  return useMemo(
    (): Options => ({
      theme,
      themeType,
      diffStyle: style,
      overflow,
      disableFileHeader: true,
      disableLineNumbers: !lineNumbers,
      diffIndicators: "bars",
      lineDiffType: "word-alt",
    }),
    [theme, themeType, style, overflow, lineNumbers],
  );
}

function PatchView({ patch, options, className }: { patch: string; options: Options; className: string }) {
  return <PatchDiff patch={patch} options={options} className={className} />;
}

function FilesView({ oldFile, newFile, options, className }: { oldFile: CodeSide | null; newFile: CodeSide; options: Options; className: string }) {
  const oldName = oldFile?.name;
  const oldContents = oldFile?.contents;
  const old = useMemo(() => (oldName === undefined || oldContents === undefined ? null : { name: oldName, contents: oldContents }), [oldName, oldContents]);
  const neu = useMemo(() => ({ name: newFile.name, contents: newFile.contents }), [newFile.name, newFile.contents]);
  return old ? <MultiFileDiff oldFile={old} newFile={neu} options={options} className={className} /> : <MultiFileDiff oldFile={null} newFile={neu} options={options} className={className} />;
}

/**
 * A diff on @pierre/diffs with the house options: the app theme (lib/codeTheme), no file
 * header (callers draw their own), bars, word-level inline changes, line numbers on,
 * unified/split and wrap from the codeView store unless a prop fixes them.
 */
export const CodeDiff = memo(function CodeDiff(props: CodeDiffProps) {
  const options = useDiffOptions(props);
  const className = cn("cf-code-view", props.className);
  return "patch" in props ? <PatchView patch={props.patch} options={options} className={className} /> : <FilesView oldFile={props.oldFile} newFile={props.newFile} options={options} className={className} />;
});

/**
 * A scroll box that renders only the visible lines of the CodeFile / CodeDiff inside it (the
 * library's own virtualizer), for code too long to lay out whole: give it a bounded height.
 */
export function CodeScroll({ children, className }: { children: ReactNode; className?: string }) {
  return <Virtualizer className={className}>{children}</Virtualizer>;
}
