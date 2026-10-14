import { useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { runCommandForResult } from "@/stores/commands";
import type { EditorProps } from "./editor";

/**
 * notifications.sound_volume: a 0–100 slider with its value and a Play button. Dragging
 * only moves the slider; the setting is saved on release (and on each keyboard step), so
 * a drag is one save. Play runs notifications.test with the slider's own value, so it
 * plays what the slider shows even before that value's save has landed.
 */
export function VolumeEditor({ field, value, commit }: EditorProps) {
  const saved = Number(value);
  // The value being dragged, until the daemon's value changes (the save landed, or the
  // file changed underneath): then the slider shows the daemon's again.
  const [draft, setDraft] = useState<number | null>(null);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(null);
  }
  const current = draft ?? (Number.isFinite(saved) ? saved : Number(field.defaultValue));
  return (
    <div className="flex items-center gap-2">
      <Slider
        // Not disabled while saving: that would take the keyboard focus off the thumb.
        className="min-w-0 flex-1"
        min={field.min}
        max={field.max}
        step={1}
        value={[current]}
        thumbLabel={field.title}
        onValueChange={([v]) => {
          if (v !== undefined) setDraft(v);
        }}
        onValueCommit={([v]) => {
          if (v !== undefined && String(v) !== value) commit(String(v));
        }}
      />
      <span className="w-8 shrink-0 text-right text-xs text-muted-foreground tabular-nums" aria-hidden data-testid="volume-value">
        {current}%
      </span>
      <Button
        variant="outline"
        size="xs"
        aria-label="Play alert sound"
        disabled={current === 0}
        onClick={() => void runCommandForResult("notifications.test", { volume: String(current) }, { quiet: true })}
      >
        <Play /> Play
      </Button>
    </div>
  );
}
