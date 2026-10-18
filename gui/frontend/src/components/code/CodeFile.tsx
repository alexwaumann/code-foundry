import { memo, useMemo } from "react";
import { File, type FileOptions, type SelectedLineRange } from "@pierre/diffs/react";
import { useCodeTheme } from "@/lib/codeTheme";
import { cn } from "@/lib/utils";
import { useCodeViewStore } from "@/stores/codeView";
import { useCodeHost } from "./useCodeHost";
import "./code.css";

export interface CodeFileProps {
  /** The file name (or path): the language comes from its extension. */
  name: string;
  contents: string;
  /** Long lines wrap instead of scrolling; the codeView store's choice when unset. */
  wrap?: boolean;
  /** Line numbers in the gutter (on by default). */
  lineNumbers?: boolean;
  /** Lines to mark as selected (a File tab's line). Given, even as null, the selection is controlled: clicks do not change it. */
  selectedLines?: SelectedLineRange | null;
  className?: string;
}

/**
 * A highlighted file on @pierre/diffs with the house options: the app theme (lib/codeTheme),
 * no file header (callers draw their own outside it), line numbers on, wrap from the
 * codeView store. Read-only.
 */
export const CodeFile = memo(function CodeFile({ name, contents, wrap, lineNumbers = true, selectedLines, className }: CodeFileProps) {
  const { theme, themeType } = useCodeTheme();
  const storeWrap = useCodeViewStore((s) => s.wrap);
  const overflow = (wrap ?? storeWrap) ? "wrap" : "scroll";
  const file = useMemo(() => ({ name, contents }), [name, contents]);
  const options = useMemo(
    (): FileOptions<undefined, undefined> => ({ theme, themeType, disableFileHeader: true, disableLineNumbers: !lineNumbers, overflow }),
    [theme, themeType, lineNumbers, overflow],
  );
  const host = useCodeHost();
  return (
    <div ref={host} className={cn("cf-code-view", className)}>
      {selectedLines === undefined ? <File file={file} options={options} /> : <File file={file} options={options} selectedLines={selectedLines} />}
    </div>
  );
});
