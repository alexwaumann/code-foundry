import { Check, Copy, Play } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { isStreamingBlock, runnableCommand } from "@/lib/codeActions";
import { useCopied } from "@/lib/useCopied";
import { runInThreadTerminal } from "@/stores/bottomActions";
import { useCommandsStore } from "@/stores/commands";
import { useCodeRun } from "./codeContext";
import "./codeActions.css";

/**
 * An icon button that copies `text` and shows a check with "Copied" for a moment. The
 * thread's code blocks and Bash commands (codeActions.css: shown on hover or focus).
 */
export function CopyButton({ text, label = "Copy code" }: { text: string; label?: string }) {
  const { copied, copy } = useCopied();
  return (
    <Tip label={copied ? null : label}>
      <button
        type="button"
        className="cf-code-btn"
        aria-label={copied ? "Copied" : label}
        data-copied={copied || undefined}
        data-testid="code-copy"
        onClick={() => {
          void copy(text);
        }}
      >
        {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        {copied && <span>Copied</span>}
      </button>
    </Tip>
  );
}

/** Whether terminal.new is offered for the current context (the visible thread's). */
function useCanStartShell(): boolean {
  return useCommandsStore((s) => s.commands.some((c) => c.name === "terminal.new" && c.available));
}

/**
 * "Run in terminal" for a shell block in Claude's reply: a new shell in the thread's
 * bottom panel runs the command (terminal.new --run) and stays open. Only when the block
 * is runnable (lib/codeActions), finished, and terminal.new is available.
 */
function RunButton({ lang, code }: { lang: string; code: string }) {
  const run = useCodeRun();
  const can = useCanStartShell();
  const command = run ? runnableCommand(lang, code) : null;
  if (!run || !can || command === null || isStreamingBlock(run.text, code, run.streaming)) return null;
  return (
    <Tip label="Run in terminal">
      <button
        type="button"
        className="cf-code-btn"
        aria-label="Run in terminal"
        data-testid="code-run"
        onClick={() => {
          void runInThreadTerminal(run.threadId, command);
        }}
      >
        <Play aria-hidden />
      </button>
    </Tip>
  );
}

/** A fenced block's buttons, top right: Run in terminal (shell blocks in replies) and Copy. */
export function CodeActions({ lang, code }: { lang: string; code: string }) {
  return (
    <div className="cf-code-actions">
      <RunButton lang={lang} code={code} />
      <CopyButton text={code.replace(/\n$/, "")} />
    </div>
  );
}
