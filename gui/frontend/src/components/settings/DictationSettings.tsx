/**
 * Settings › General › Dictation (docs/notes/dictation-4-gui.md): the dictation.enabled
 * row's switch, state chip and "Needs the model below.", and the Model row after it (state
 * from DictationService.Watch, actions through the dictation.* commands). The section's
 * only setting is the switch; everything else is the daemon's snapshot.
 */
import type { DictationView } from "@/api/dictation";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { downloadProgress, gigabytes, megabytes, memorySize } from "@/lib/dictation";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommandForResult } from "@/stores/commands";
import { useDictationStore, useHoldDictation } from "@/stores/dictation";
import { useSettingsStore } from "@/stores/settings";
import type { EditorProps } from "./editor";

const CHIP = "rounded-sm bg-cf-surface-sunken px-1.5 py-px text-caption-sm";

function useSnapshot(): DictationView | null {
  // The section is on screen: it holds the snapshot at core priority.
  useHoldDictation(true, "core");
  return useDictationStore((s) => s.snapshot);
}

function run(name: string): void {
  void runCommandForResult(name, {}, { quiet: true });
}

/**
 * dictation.enabled's switch. Turning it on without the model downloads the model
 * instead: the daemon turns the setting on when the download finishes. Turning it on
 * while the model downloads does nothing more (it turns on by itself).
 */
export function DictationToggleEditor({ field, value, pending, commit }: EditorProps) {
  const snap = useSnapshot();
  const on = value === "true";
  return (
    <Switch
      aria-label={field.title}
      checked={on}
      disabled={pending}
      onCheckedChange={(checked) => {
        if (checked && snap && !snap.model.downloaded) {
          if (!snap.model.download) run("dictation.download");
          return;
        }
        commit(checked ? "true" : "false");
      }}
    />
  );
}

/** The chip beside "Dictation": Ready, Unloaded, Loading model…, or the engine's failure. */
export function DictationStateChip() {
  const snap = useSnapshot();
  if (!snap?.enabled || !snap.model.downloaded) return null;
  switch (snap.state) {
    case "ready":
    case "listening":
      return (
        <span className={cn(CHIP, "text-cf-success-text")} data-testid="dictation-chip" data-state="ready">
          Ready
        </span>
      );
    case "unloaded":
      return (
        <span className={CHIP} data-testid="dictation-chip" data-state="unloaded">
          Unloaded · reloads when you return
        </span>
      );
    case "loading":
      return (
        <span className={CHIP} data-testid="dictation-chip" data-state="loading">
          Loading model…
        </span>
      );
    case "error":
      return (
        <span className={cn(CHIP, "bg-cf-error-surface text-cf-error-text")} data-testid="dictation-chip" data-state="error">
          {snap.error || "The engine failed"}
        </span>
      );
    default:
      return null;
  }
}

/** After the switch's description while there is no model. */
export function DictationNeedsModel() {
  const snap = useSnapshot();
  if (!snap || snap.model.downloaded) return null;
  return <> Needs the model below.</>;
}

/** Where the model is kept: next to the settings file (~/.code-foundry/dictation). */
function useModelDir(): string {
  const settingsPath = useSettingsStore((s) => s.snapshot?.path ?? "");
  const dir = settingsPath.includes("/") ? settingsPath.slice(0, settingsPath.lastIndexOf("/")) : "~/.code-foundry";
  return `${tildify(dir)}/dictation`;
}

function modelDescription(snap: DictationView | null, dir: string): string {
  const head = "Whisper Large v3 Turbo, English.";
  if (snap?.model.download) return `${head} Downloading. Dictation turns on when it finishes.`;
  if (snap?.model.downloaded) return `${head} Loaded while dictation is on; freed after 10 minutes away from the app.`;
  return `${head} Downloaded once, kept in ${dir}. Nothing you say leaves this Mac.`;
}

/** The right side: Download, the download's progress with Cancel, or the size on disk with Remove. */
function ModelActions({ snap }: { snap: DictationView | null }) {
  if (!snap) return null;
  const d = snap.model.download;
  if (d) {
    const pct = d.totalBytes > 0 ? Math.min(100, (d.receivedBytes / d.totalBytes) * 100) : null;
    return (
      <div className="flex w-full flex-col items-end gap-1.5" data-testid="dictation-download">
        <Progress value={pct} aria-label="Model download" className="h-1.5 bg-cf-surface-sunken" />
        <div className="flex items-center gap-2.5">
          <span className="text-caption tabular-nums" data-testid="dictation-progress">
            {downloadProgress(d.receivedBytes, d.totalBytes, d.bytesPerSecond)}
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="text-cf-text-muted"
            data-testid="dictation-cancel"
            onClick={() => {
              run("dictation.download.cancel");
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  if (snap.model.downloaded) {
    return (
      <div className="flex items-center justify-end gap-2.5">
        <span className="text-caption tabular-nums" data-testid="dictation-size">
          {megabytes(snap.model.sizeBytes)} on disk
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="text-cf-text-muted"
          data-testid="dictation-remove"
          onClick={() => {
            run("dictation.remove");
          }}
        >
          Remove
        </Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end">
      <Button
        size="sm"
        data-testid="dictation-download-button"
        onClick={() => {
          run("dictation.download");
        }}
      >
        Download · {gigabytes(snap.model.sizeBytes || 874_188_075)}
      </Button>
    </div>
  );
}

/** General › Dictation's Model row, after the switch: the one Whisper model, this Mac, and on an M1 the speed warning. */
export function DictationModelRow({ className }: { className?: string | undefined }) {
  const snap = useSnapshot();
  const dir = useModelDir();
  const hw = snap?.hardware;
  // A download's failure (the engine's shows as the switch's chip). The daemon's message
  // starts "Download failed:" and gives each source's failure a line.
  const downloadError = snap && snap.state !== "error" && !snap.model.downloaded ? snap.error : "";
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_18rem] items-center gap-x-6 gap-y-1 px-4 py-3", className)} data-testid="dictation-model-row" data-state={snap?.state}>
      <div className="min-w-0">
        <span className="text-label">Model</span>
        <p className="mt-0.5 text-caption">{modelDescription(snap, dir)}</p>
        {hw?.chip && (
          <p className="mt-0.5 text-caption" data-testid="dictation-mac">
            This Mac:{" "}
            <span className={CHIP}>
              {hw.chip}
              {hw.memoryBytes > 0 && ` · ${memorySize(hw.memoryBytes)}`}
            </span>
          </p>
        )}
        {hw?.m1Family && (
          <p className="mt-1 text-caption text-cf-warning-text" data-testid="dictation-m1">
            On an M1 each phrase takes a few seconds to appear, and the model uses about 1.2 GB while loaded. Newer M-series chips are much quicker.
          </p>
        )}
        {downloadError && (
          <p className="mt-1 text-caption break-words whitespace-pre-line text-cf-error-text" role="alert" data-testid="dictation-download-error">
            {downloadError}
          </p>
        )}
      </div>
      <ModelActions snap={snap} />
    </div>
  );
}
