import type { HostNeedView } from "@/api/plugin";
import { startCommandNamed } from "@/keys/bindings";
import { hostNeedSentence } from "./model";

/**
 * Where a row's Update or Install would be when the version needs a newer Code Foundry: what it needs, in muted caption
 * text ("1.4.0 needs Code Foundry 0.31.0" on an installed plugin, "Needs Code Foundry 0.31.0" on a Browse entry).
 */
export function HostNeedMark({ words, testId }: { words: string; testId: string }) {
  return (
    <span className="flex h-6 shrink-0 items-center px-1.5 text-caption-sm" data-testid={testId}>
      {words}
    </span>
  );
}

/** The details' line saying why, with the app's own update check (app.update.check opens the update dialog and checks). */
export function HostNeedLine({ need }: { need: HostNeedView }) {
  return (
    <p className="text-caption-sm break-words" data-testid="plugin-host-need">
      {hostNeedSentence(need)}{" "}
      <button
        type="button"
        className="text-link"
        onClick={() => {
          startCommandNamed("app.update.check");
        }}
        data-testid="plugin-host-need-update"
      >
        Update Code Foundry
      </button>
    </p>
  );
}
