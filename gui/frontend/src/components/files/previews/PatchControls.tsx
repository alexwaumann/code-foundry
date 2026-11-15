import { setDiffStyle, useCodeViewStore, type DiffStyle } from "@/stores/codeView";
import { ModeSwitch } from "../FileHeader";

const STYLES: readonly { value: DiffStyle; label: string }[] = [
  { value: "unified", label: "Unified" },
  { value: "split", label: "Split" },
];

/** The patch kind's Unified | Split, after the mode switch: the codeView store's choice, the Diff tab's and the PR Code tab's too. */
export function PatchControls() {
  const style = useCodeViewStore((s) => s.diffStyle);
  return <ModeSwitch options={STYLES} value={style} onChange={setDiffStyle} label="Diff layout" testId="file-patch-style" />;
}
