import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import type { FileFinderMode } from "@/stores/ui";

/**
 * The finder's Files / Text switch, at the right of its query field in both modes (the
 * thread search dialog's mode switch). A click leaves the keyboard in the field; Tab in the
 * field does the same.
 */
export function FinderModeSwitch({ mode, onSwitch }: { mode: FileFinderMode; onSwitch: () => void }) {
  return (
    <div
      className="shrink-0"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      <RadioGroup
        variant="segmented"
        size="sm"
        value={mode}
        onValueChange={(v) => {
          if (v !== mode) onSwitch();
        }}
        aria-label="Search by"
        data-testid="finder-mode"
      >
        <RadioGroupChoice value="files" className="text-label font-normal" data-testid="finder-mode-files">
          Files
        </RadioGroupChoice>
        <RadioGroupChoice value="text" className="text-label font-normal" data-testid="finder-mode-text">
          Text
        </RadioGroupChoice>
      </RadioGroup>
    </div>
  );
}
