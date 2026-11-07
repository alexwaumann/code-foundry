import { ArrowLeft, Ellipsis } from "lucide-react";
import type { CompareSource } from "@/api/compare";
import { HeaderAction, ModeSwitch } from "@/components/files/FileHeader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { setDiffStyle, useCodeViewStore, type DiffStyle } from "@/stores/codeView";
import { SourcePicker } from "./SourcePicker";

const STYLES = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
] as const satisfies readonly { value: DiffStyle; label: string }[];

function StyleSwitch() {
  const style = useCodeViewStore((s) => s.diffStyle);
  return <ModeSwitch options={STYLES} value={style} onChange={setDiffStyle} label="Diff layout" testId="diff-style" />;
}

/** Unified | Split behind ⋯ where the bar has no room for it. */
function StyleMenu() {
  return (
    <Popover>
      <Tip label="Diff layout">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="text-cf-text-muted hover:text-cf-text" aria-label="Diff layout" data-testid="diff-style-menu">
            <Ellipsis aria-hidden />
          </Button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" className="w-auto p-2">
        <StyleSwitch />
      </PopoverContent>
    </Popover>
  );
}

/**
 * What the tab compares: the base ← the head, either any source, then the diff's layout
 * (behind ⋯ when narrow). The arrow swaps the sides.
 */
export function CompareBar({
  projectId,
  base,
  head,
  baseSource,
  headSource,
  baseLabel,
  wide,
  onChange,
}: {
  projectId: string;
  /** The sides' labels. */
  base: string;
  head: string;
  baseSource: CompareSource;
  headSource: CompareSource;
  /** What the merge base choice is called: the checkout's base ref. */
  baseLabel: string;
  wide: boolean;
  onChange: (base: CompareSource, head: CompareSource) => void;
}) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b border-cf-divider px-3" data-testid="diff-compare-bar">
      <SourcePicker
        projectId={projectId}
        value={baseSource}
        label={base}
        baseLabel={baseLabel}
        testId="diff-base"
        onChange={(s) => {
          onChange(s, headSource);
        }}
      />
      <HeaderAction
        icon={ArrowLeft}
        label="Swap sides"
        testId="diff-swap"
        onClick={() => {
          onChange(headSource, baseSource);
        }}
      />
      <SourcePicker
        projectId={projectId}
        value={headSource}
        label={head}
        baseLabel={baseLabel}
        testId="diff-head"
        onChange={(s) => {
          onChange(baseSource, s);
        }}
      />
      <span className="flex-1" />
      {wide ? <StyleSwitch /> : <StyleMenu />}
    </div>
  );
}
