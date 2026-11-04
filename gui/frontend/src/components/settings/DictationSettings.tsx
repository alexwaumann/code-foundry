/**
 * Settings › General › Dictation (docs/notes/dictation-4-gui.md): the dictation.enabled
 * row's switch, state chip and "Needs the model below.", and the Model row at the end of
 * the section (state from DictationService.Watch, actions through the dictation.*
 * commands). The rows between them are plain settings (hiddenFields.ts hides two of them
 * while dictation is off). Before the Model row, the hold key's permission (DictationAccessRow;
 * docs/notes/dictate-anywhere.md).
 */
import { useEffect, useState } from "react";
import type { DictationAccessibilityView, DictationView } from "@/api/dictation";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { downloadProgress, gigabytes, megabytes, memorySize } from "@/lib/dictation";
import { tildify } from "@/lib/path";
import { cn } from "@/lib/utils";
import { runCommandForResult } from "@/stores/commands";
import { noteDictationAllow, useDictationStore, useHoldDictation } from "@/stores/dictation";
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
          Unloaded · reloads when you dictate
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
  if (snap?.model.downloaded) return `${head} Stays loaded while dictation is on, so it starts at once.`;
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

/** How long Allow gets before the row says what to do when the list's switch did nothing. */
export const ALLOW_ADVICE_MS = 30_000;

type AccessState = "ask" | "stuck" | "restart" | "allowed";

function accessState(a: DictationAccessibilityView, stuck: boolean): AccessState {
  if (a.granted) return a.tapSilent ? "restart" : "allowed";
  return stuck ? "stuck" : "ask";
}

/** Whether the time since the last Allow has run out; it turns true by itself, on screen. */
function useAllowRanOut(): boolean {
  const allowedAtMs = useDictationStore((s) => s.allowedAtMs);
  const [ranOutFor, setRanOutFor] = useState(0);
  useEffect(() => {
    if (allowedAtMs === 0) return undefined;
    const t = setTimeout(
      () => {
        setRanOutFor(allowedAtMs);
      },
      Math.max(0, allowedAtMs + ALLOW_ADVICE_MS - Date.now()),
    );
    return () => {
      clearTimeout(t);
    };
  }, [allowedAtMs]);
  return allowedAtMs !== 0 && ranOutFor === allowedAtMs;
}

function accessDescription(state: AccessState, a: DictationAccessibilityView): string {
  const list = `Privacy & Security › ${a.listName}`;
  switch (state) {
    case "ask":
      return `Lets Code Foundry hear the hold key and paste into other apps. Turn it on in ${list}.`;
    case "stuck":
      return `Still off? In ${list}, select Code Foundry and remove it with −, then add it back with + (⇧⌘G, then ${tildify(a.executable)}). The switch alone can leave an older build's entry in place.`;
    case "restart":
      return "macOS allows it, but this run of the app hears no keys. A restart picks up the permission.";
    case "allowed":
      return `Allowed in ${list}.`;
  }
}

/**
 * The hold key's permission, as one row while dictation is on and the host has said how it
 * stands (a browser has no host, so no row). The host watches the grant, so the row moves
 * on by itself.
 */
export function DictationAccessRow({ className }: { className?: string | undefined }) {
  const snap = useSnapshot();
  const ranOut = useAllowRanOut();
  const a = snap?.accessibility;
  if (!snap?.enabled || !a) return null;
  const state = accessState(a, ranOut);
  return (
    <div className={cn("grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 px-4 py-3", className)} data-testid="dictation-access-row" data-state={state}>
      <div className="min-w-0">
        <span className="text-label">Hold key permission</span>
        <p className={cn("mt-0.5 text-caption break-words", state === "stuck" && "text-cf-warning-text")}>{accessDescription(state, a)}</p>
      </div>
      {state === "allowed" && (
        <span className={cn(CHIP, "text-cf-success-text")} data-testid="dictation-access-chip">
          Allowed
        </span>
      )}
      {(state === "ask" || state === "stuck") && (
        <Button
          size="sm"
          data-testid="dictation-allow"
          onClick={() => {
            noteDictationAllow(Date.now());
            run("dictation.allow");
          }}
        >
          Allow
        </Button>
      )}
      {state === "restart" && (
        <Button
          size="sm"
          data-testid="dictation-access-restart"
          onClick={() => {
            run("app.restart");
          }}
        >
          Restart
        </Button>
      )}
    </div>
  );
}

/** What General › Dictation shows after its fields. */
export function DictationSectionEnd({ className }: { className?: string | undefined }) {
  return (
    <>
      <DictationAccessRow className={className} />
      <DictationModelRow className={className} />
    </>
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
