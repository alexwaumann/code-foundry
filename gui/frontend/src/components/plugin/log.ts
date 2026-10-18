import type { LogData, LogLine } from "@/api/plugin";

/** A log's lines: its lines, or its text split (a trailing newline ends the last line). */
export function logLines(log: LogData): LogLine[] {
  if (log.lines && log.lines.length > 0) return log.lines;
  if (!log.text) return [];
  const parts = log.text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts.map((text) => ({ text }));
}
