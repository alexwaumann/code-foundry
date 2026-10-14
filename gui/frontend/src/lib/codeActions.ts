/**
 * What a code block in a thread offers beyond Copy: the command line its "Run in
 * terminal" button types (terminal.new --run), for shell blocks in Claude's replies.
 * See docs/notes/code-block-actions.md.
 */

/** Fence languages whose body is a script to run as is (lower case). */
const SCRIPT_LANGS = new Set(["bash", "sh", "shell", "zsh"]);

/** A prompt in a transcript: "$ " at the start of the line (the only one we read; "#" is a comment in scripts, "%" too rare). */
const PROMPT = /^\$ /;

/**
 * The command line "Run in terminal" types for a fenced block, or null when it offers
 * none. Shell blocks (bash, sh, shell, zsh) run as written; when every non-blank line
 * starts with "$ " (a transcript fenced as bash), the prompts are dropped. A `console`
 * block is a transcript: only its "$ " lines run (prompt dropped, a "\" continuation
 * kept with them), output lines are left out; one without any "$ " line is ambiguous
 * and offers nothing. Trailing blank lines are dropped; an empty block offers nothing.
 */
export function runnableCommand(lang: string, code: string): string | null {
  const l = lang.trim().toLowerCase();
  const lines = code.replace(/\r\n/g, "\n").replace(/\s+$/, "").split("\n");
  let out: string[];
  if (SCRIPT_LANGS.has(l)) {
    const filled = lines.filter((x) => x.trim() !== "");
    out = filled.length > 0 && filled.every((x) => PROMPT.test(x)) ? lines.map((x) => x.replace(PROMPT, "")) : lines;
  } else if (l === "console") {
    out = transcriptCommands(lines);
  } else {
    return null;
  }
  const cmd = out.join("\n").trim();
  return cmd === "" ? null : cmd;
}

/** A console transcript's commands: "$ " lines without the prompt, with their "\" continuation lines. */
function transcriptCommands(lines: readonly string[]): string[] {
  const out: string[] = [];
  let continued = false;
  for (const line of lines) {
    if (continued) {
      out.push(line);
    } else if (PROMPT.test(line)) {
      out.push(line.replace(PROMPT, ""));
    } else {
      continue;
    }
    continued = line.endsWith("\\");
  }
  return out;
}

/**
 * Whether a fenced block is still being written: its message streams and nothing but
 * (maybe) its closing fence follows the block's code. Only the last block of a streaming
 * message can be.
 */
export function isStreamingBlock(text: string, code: string, streaming: boolean): boolean {
  if (!streaming) return false;
  const body = code.replace(/\n$/, "");
  const at = text.lastIndexOf(body);
  if (at < 0) return true; // the markdown changed it (tabs, entities): err on the side of waiting
  return /^\s*(`{3,}|~{3,})?\s*$/.test(text.slice(at + body.length));
}
