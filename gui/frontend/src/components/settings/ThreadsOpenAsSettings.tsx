import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import type { EditorProps } from "./editor";
import { BoolEditor, EnumEditor } from "./editors";
import { confirmThreadsOpenAs, useSmartSwapForced } from "./threadsOpenAsSwitch";

/**
 * layout.threads_open_as's dropdown (docs/notes/threads-open-as-2-gui.md): a pick that would close
 * thread tabs or panes asks first, with the counts (threadsOpenAsSwitch.ts); Cancel saves nothing,
 * so the dropdown stays on the daemon's value. It is busy while it asks.
 */
export function ThreadsOpenAsEditor(props: EditorProps) {
  const [asking, setAsking] = useState(false);
  return (
    <EnumEditor
      {...props}
      pending={props.pending || asking}
      commit={(raw) => {
        setAsking(true);
        void confirmThreadsOpenAs(raw).then((yes) => {
          setAsking(false);
          if (yes) props.commit(raw);
        });
      }}
    />
  );
}

/**
 * layout.smart_swap's switch: on and disabled while Threads open as is Panes or Single, without
 * touching its stored value, which it shows and changes again under Tabs.
 */
export function SmartSwapEditor(props: EditorProps) {
  const forced = useSmartSwapForced();
  if (!forced) return <BoolEditor {...props} />;
  return <Switch aria-label={props.field.title} checked disabled data-testid="smart-swap-forced" />;
}

/** After layout.smart_swap's description while it is forced on. */
export function SmartSwapForcedNote() {
  return useSmartSwapForced() ? " Always on while threads open as Panes or Single." : null;
}
