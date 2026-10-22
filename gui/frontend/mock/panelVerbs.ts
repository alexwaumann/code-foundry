/**
 * The view.panel.* verbs' --thread and --focus, like the daemon
 * (internal/command/commands_view_thread.go): a call that passes a thread sends a
 * ShowView scoped to it (its panel changes, the window's selection stays), with focus a
 * FocusThread first. The app's palette and keys pass neither, so their ShowView acts on
 * each window's selection. The mock only ever sees the app's calls, so it treats a
 * passed thread as explicit (the daemon also scopes a CLI call inside a thread).
 */
import { ArgType } from "../src/gen/codefoundry/v1/command_pb";
import type { UiIntentInit } from "./world";

export const panelThreadArgs = [
  {
    name: "thread",
    type: ArgType.STRING,
    required: false,
    description:
      "Thread whose side panel it acts on, without changing what any window shows (default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app and outside a thread: each window's selection) (or a unique suffix of 4+ characters)",
  },
  { name: "focus", type: ArgType.BOOL, required: false, description: "Also select the thread in every window first; only when the user asked to be taken there" },
];

/** Runs panel verb `name` (its ShowView name) with the caller's args. */
export function runPanelVerb(emit: (i: UiIntentInit) => number, name: string, args: Readonly<Record<string, string>>): string {
  const threadId = args.thread ?? "";
  // The user asked (--focus): explicit, so a hidden thread just created is selected too.
  if (threadId && args.focus === "true") emit({ intent: { case: "focusThread", value: { threadId, explicit: true } } });
  return `delivered=${String(emit({ intent: { case: "showView", value: { name, threadId } } }))}`;
}
