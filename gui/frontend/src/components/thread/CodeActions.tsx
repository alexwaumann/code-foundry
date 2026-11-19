import { Play } from "lucide-react";
import { CopyIcon } from "@/components/copy/CopyButton";
import { Button } from "@/components/ui/button";
import { isStreamingBlock, runnableCommand } from "@/lib/codeActions";
import { useCopied } from "@/lib/useCopied";
import { runInQuickTerminal } from "@/shell/terminalActions";
import { useCommandsStore } from "@/stores/commands";
import { useCodeRun } from "./codeContext";
import "./codeActions.css";

/** The header's quiet buttons: an icon and a word, no tooltip (the word is the name), no transition. */
const HEAD_BUTTON = "h-5 gap-1 px-1.5 text-caption-sm text-cf-text-muted transition-none hover:text-cf-text has-[>svg]:px-1.5 [&_svg]:size-3";

/**
 * Copy with its word: "Copy", then a check and "Copied" in the success colour for a moment
 * (lib/useCopied). Both words sit in one grid cell, the idle one hidden, so the button is as
 * wide as the longer and nothing beside it moves.
 */
function CopyCodeButton({ text }: { text: string }) {
  const { copied, copy } = useCopied();
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={HEAD_BUTTON}
      aria-label={copied ? "Copied" : "Copy code"}
      data-copied={copied || undefined}
      data-testid="code-copy"
      onClick={() => {
        void copy(text);
      }}
    >
      <CopyIcon copied={copied} />
      <span className="grid">
        <span className={copied ? "invisible col-start-1 row-start-1" : "col-start-1 row-start-1"}>Copy</span>
        <span className={copied ? "col-start-1 row-start-1 text-cf-success-text" : "invisible col-start-1 row-start-1"}>Copied</span>
      </span>
    </Button>
  );
}

/** Whether terminal.new is offered for the current context (the visible thread's). */
function useCanStartShell(): boolean {
  return useCommandsStore((s) => s.commands.some((c) => c.name === "terminal.new" && c.available));
}

/**
 * Run for a shell block in Claude's reply: the thread's quick terminal types the command and
 * opens; when a command is still running there, a new terminal tab linked to the thread runs it
 * (shell/terminalActions.ts runInQuickTerminal). Only when the block is runnable
 * (lib/codeActions), finished, and terminal.new is available.
 */
function RunButton({ lang, code }: { lang: string; code: string }) {
  const run = useCodeRun();
  const can = useCanStartShell();
  const command = run ? runnableCommand(lang, code) : null;
  if (!run || !can || command === null || isStreamingBlock(run.text, code, run.streaming)) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={HEAD_BUTTON}
      aria-label="Run in terminal"
      data-testid="code-run"
      onClick={() => {
        void runInQuickTerminal(run.threadId, command);
      }}
    >
      <Play aria-hidden />
      Run
    </Button>
  );
}

/**
 * A fenced block's header, part of its layout and always shown: the fence's language at the
 * left (nothing for a block without one), Run (shell blocks in replies) and Copy at the right.
 * Find and citations leave its text out (data-find-skip, data-cite-skip): it is not the code.
 */
export function CodeHeader({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="cf-code-head" data-testid="code-head" data-find-skip data-cite-skip>
      <span className="cf-code-lang min-w-0 flex-1 truncate text-caption-sm" data-testid="code-lang">
        {lang}
      </span>
      <RunButton lang={lang} code={code} />
      <CopyCodeButton text={code.replace(/\n$/, "")} />
    </div>
  );
}
