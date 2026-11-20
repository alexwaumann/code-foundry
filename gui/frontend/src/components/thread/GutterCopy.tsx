import { CopyIcon } from "@/components/copy/CopyButton";
import { Tip } from "@/components/ui/tooltip";

/**
 * The thread's small icon-only Copy (thread.css `.ib`, 24×22): a turn's gutter copies its
 * reply with it (rows.tsx GutterRow, docs/notes/turn-gutter.md), a user message its prompt
 * (UserBubble, docs/notes/copy-prompt.md). Its caller holds the state (lib/useCopied), since
 * each shows its row while `copied`: then the icon is a check and the name and tooltip read
 * "Copied". `text` is read on press.
 */
export function GutterCopy({ label, copied, copy, text, testId }: { label: string; copied: boolean; copy: (text: string) => Promise<boolean>; text: () => string; testId: string }) {
  const name = copied ? "Copied" : label;
  return (
    <Tip label={name}>
      <button
        type="button"
        className="ib"
        aria-label={name}
        data-copied={copied || undefined}
        data-testid={testId}
        onClick={() => {
          void copy(text());
        }}
      >
        <CopyIcon copied={copied} />
      </button>
    </Tip>
  );
}
