import { memo, useMemo, type ReactNode } from "react";
import { Check, Circle, CircleDot } from "lucide-react";
import type { ToolCallView } from "@/api/thread";
import { grammarForPath, highlightLines, shellTokens } from "@/lib/highlight";
import { obj, parseObject, relPath, str, toolDiff, type Json } from "@/lib/toolSummary";
import { ThreadMarkdown, TokenSpans } from "./Code";
import { CopyButton } from "./CodeActions";
import { ToolDiffView } from "./ToolDiffView";

/** Lines of tool output shown before the rest is cut (the block scrolls within its max height). */
const OUTPUT_LINES = 400;

function clip(text: string, max = OUTPUT_LINES): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… ${String(lines.length - max)} more lines`;
}

/** Lines a failing test run or compiler prints that the sketch shows red. */
const FAIL_LINE = /^(--- FAIL|FAIL\b|panic:|fatal:|error[:[]|Error:|ERROR\b)/;

/** A command and its output, like a terminal: "$ cmd", then the output (failure lines red). */
function BashDetail({ t }: { t: ToolCallView }) {
  const input = parseObject(t.inputJson);
  const result = parseObject(t.resultJson);
  const command = str(input, "command");
  const stdout = str(result, "stdout");
  const stderr = str(result, "stderr");
  // The structured result splits the streams; the text result has "Exit code N" first on failure.
  const output = (stdout || stderr ? [stdout, stderr].filter(Boolean).join("\n") : t.output.replace(/^Exit code \d+\n?/, "")).replace(/\n+$/, "");
  const lines = clip(output).split("\n");
  return (
    <div className="term selectable" data-testid="thread-bash">
      <div className="cmd cf-code">
        <span className="pr">$ </span>
        <TokenSpans tokens={shellTokens(command)} />
        {command && (
          <div className="cf-code-actions">
            <CopyButton text={command} label="Copy command" />
          </div>
        )}
      </div>
      {output && (
        <div className="out">
          {lines.map((l, i) => (
            <div key={i} className={FAIL_LINE.test(l) ? "t-red" : undefined}>
              {l || "​"}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** A file's content (Read), highlighted, with its line numbers; an image read shows the image. */
function ReadDetail({ t, cwd }: { t: ToolCallView; cwd: string }) {
  const input = parseObject(t.inputJson);
  const result = parseObject(t.resultJson);
  const file = obj(result, "file");
  const path = str(input, "file_path");
  const image = str(result, "type") === "image" ? str(file, "base64") : "";
  const content = str(file, "content");
  const start = typeof file.startLine === "number" ? file.startLine : 1;
  const lines = highlightLines(clip(content, 200), grammarForPath(path));
  if (image) return <img className="max-h-80 rounded-md border" src={`data:${str(file, "type") || "image/png"};base64,${image}`} alt={relPath(path, cwd)} />;
  if (!content) return <Output text={t.output} />;
  return (
    <div className="diff selectable">
      {lines.map((l, i) => (
        <div key={i} className="l" style={{ gridTemplateColumns: "44px 1fr" }}>
          <span className="o">{start + i}</span>
          <span>
            <TokenSpans tokens={l} />
          </span>
        </div>
      ))}
    </div>
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Grep's pattern as a RegExp to mark matches with (literal when it does not compile here). */
function patternRegExp(pattern: string, ignoreCase: boolean): RegExp {
  try {
    return new RegExp(pattern, ignoreCase ? "gi" : "g");
  } catch {
    return new RegExp(escapeRegExp(pattern), "g");
  }
}

/** "path:line:text" lines (Grep content mode) with the pattern marked; a list of paths otherwise. */
function GrepDetail({ t, cwd }: { t: ToolCallView; cwd: string }) {
  const input = parseObject(t.inputJson);
  const pattern = str(input, "pattern");
  const re = patternRegExp(pattern, input["-i"] === true);
  const lines = clip(t.output.replace(/\n+$/, ""), 100).split("\n");
  const mark = (s: string): ReactNode[] => {
    if (!pattern) return [s];
    const out: ReactNode[] = [];
    let last = 0;
    for (const m of s.matchAll(re)) {
      if (!m[0]) break;
      out.push(s.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>);
      last = m.index + m[0].length;
    }
    out.push(s.slice(last));
    return out;
  };
  return (
    <div className="matches selectable" data-testid="thread-matches">
      {lines.map((l, i) => {
        const m = /^(.+?):(\d+):(.*)$/.exec(l);
        if (!m) return <div key={i}>{l.startsWith("/") ? <span className="t-sky">{relPath(l, cwd)}</span> : l}</div>;
        return (
          <div key={i}>
            <span className="t-sky">{relPath(m[1] ?? "", cwd)}</span>
            <span className="opacity-70">:{m[2]}</span>
            {"  "}
            {mark(m[3] ?? "")}
          </div>
        );
      })}
    </div>
  );
}

/** Claude's todo list (TodoWrite) with each item's state. */
function TodoDetail({ t }: { t: ToolCallView }) {
  const todos = (parseObject(t.inputJson).todos ?? []) as Json[];
  if (!Array.isArray(todos)) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-body-sm">
      {todos.map((td, i) => {
        const status = str(td, "status");
        const Icon = status === "completed" ? Check : status === "in_progress" ? CircleDot : Circle;
        return (
          <li key={i} className={status === "completed" ? "flex items-center gap-2 text-muted-foreground line-through" : "flex items-center gap-2"}>
            <Icon className="size-3.5 shrink-0" aria-hidden />
            {str(td, "content")}
          </li>
        );
      })}
    </ul>
  );
}

/** Plain output in a scrolling mono block. */
function Output({ text, label }: { text: string; label?: string }) {
  if (!text.trim()) return null;
  return (
    <div className="term selectable">
      {label && <div className="cmd text-muted-foreground">{label}</div>}
      <div className="out" style={label ? undefined : { borderTop: 0 }}>
        {clip(text.replace(/\n+$/, ""))}
      </div>
    </div>
  );
}

/** A file change (Edit, MultiEdit, Write, NotebookEdit) as a diff; its output when there is none. */
function EditDetail({ t, cwd }: { t: ToolCallView; cwd: string }) {
  const diff = useMemo(() => toolDiff(t), [t]);
  if (!diff) return <Output text={t.output} />;
  return <ToolDiffView diff={diff} cwd={cwd} />;
}

/** An ended Agent call's detail: the report its subagent handed back (lib/toolSummary `agentReport`). */
export function AgentReport({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="subresult selectable" data-testid="thread-agent-report">
      <ThreadMarkdown>{text}</ThreadMarkdown>
    </div>
  );
}

/** A tool row's expanded detail. */
export const ToolDetail = memo(function ToolDetail({ t, cwd }: { t: ToolCallView; cwd: string }) {
  switch (t.name) {
    case "Bash":
      return <BashDetail t={t} />;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return <EditDetail t={t} cwd={cwd} />;
    case "Read":
      return <ReadDetail t={t} cwd={cwd} />;
    case "Grep":
    case "Glob":
    case "LS":
      return <GrepDetail t={t} cwd={cwd} />;
    case "TodoWrite":
      return <TodoDetail t={t} />;
    default: {
      const input = parseObject(t.inputJson);
      const shown = Object.keys(input).length > 0 ? JSON.stringify(input, null, 2) : t.inputJson;
      return (
        <div className="flex flex-col gap-1.5">
          <Output text={shown} label="Input" />
          <Output text={t.output} label="Output" />
        </div>
      );
    }
  }
});
