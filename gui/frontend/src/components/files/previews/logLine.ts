/**
 * One log line read for the log preview (LogBody.tsx): its level, its leading timestamp and
 * its trailing `key=value` fields, each found on its own, so a line that matches nothing is
 * plain text. Lines are plain (escape sequences already gone: ansi.ts). Pure.
 *
 * Levels: `level=WARN` (logfmt, slog text), `"level":"warn"` or a number in a JSON line
 * (slog JSON, zap, pino, bunyan), `[ERROR]` in brackets anywhere near the start, or a bare
 * upper-case TRACE/DEBUG/INFO/WARN/WARNING/ERROR/FATAL as one of the first words.
 */

/** 0 none, then trace … fatal: an index into LEVEL_NAMES. */
export type Level = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const TRACE: Level = 1;
export const DEBUG: Level = 2;
export const INFO: Level = 3;
export const WARN: Level = 4;
export const ERROR: Level = 5;
export const FATAL: Level = 6;

/** What the level column shows. */
export const LEVEL_NAMES = ["", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;

const WORDS: Record<string, Level> = {
  trace: TRACE,
  trc: TRACE,
  debug: DEBUG,
  dbg: DEBUG,
  info: INFO,
  inf: INFO,
  information: INFO,
  notice: INFO,
  warn: WARN,
  wrn: WARN,
  warning: WARN,
  error: ERROR,
  err: ERROR,
  eror: ERROR,
  critical: ERROR,
  crit: ERROR,
  dpanic: ERROR,
  fatal: FATAL,
  ftl: FATAL,
  panic: FATAL,
  emerg: FATAL,
  alert: FATAL,
};

/** A level's word in any case ("warn", "WARNING", "Error"); slog's "WARN+2" counts as WARN. 0 when it is none. */
export function levelOfWord(word: string): Level {
  const m = /^[A-Za-z]+/.exec(word);
  return m ? (WORDS[m[0].toLowerCase()] ?? 0) : 0;
}

/** pino's and bunyan's numbers: 10 trace, 20 debug, 30 info, 40 warn, 50 error, 60 fatal. */
export function levelOfNumber(n: number): Level {
  if (!Number.isFinite(n) || n < 10) return 0;
  if (n >= 60) return FATAL;
  return ([0, TRACE, DEBUG, INFO, WARN, ERROR] as const)[Math.floor(n / 10)] ?? 0;
}

/** How far into a line a level is looked for (a JSON line's key, a logfmt pair, a bracket). */
const HEAD = 320;

const JSON_LEVEL = /"(?:level|lvl|severity|levelname|log\.level)"\s*:\s*(?:"([^"]*)"|(-?\d+))/;
const KV_LEVEL = /(?:^|\s)(?:level|lvl|severity)=(?:"?)([A-Za-z]+)/;
const BRACKET = /\[(trace|trc|debug|dbg|info|inf|notice|warn|wrn|warning|error|err|critical|crit|fatal|ftl|panic)\]/i;
// A bare upper-case level as one of the first four words (after a timestamp: "- name - ERROR -").
const BARE = /^\s*(?:\S+\s+){0,3}?\[?(TRACE|TRC|DEBUG|DBG|INFO|INF|NOTICE|WARN|WRN|WARNING|ERROR|ERR|CRITICAL|FATAL|FTL|PANIC)\b\]?/;

/** The level a line says it has, 0 when it says none. */
export function detectLevel(line: string): Level {
  const head = line.length > HEAD ? line.slice(0, HEAD) : line;
  const first = firstChar(head);
  if (first === "{") {
    const m = JSON_LEVEL.exec(line);
    if (m) return m[2] !== undefined ? levelOfNumber(Number(m[2])) : levelOfWord(m[1] ?? "");
    return 0;
  }
  if (head.includes("=")) {
    const m = KV_LEVEL.exec(head);
    if (m) {
      const l = levelOfWord(m[1] ?? "");
      if (l) return l;
    }
  }
  const t = timeAt(head);
  const rest = t ? head.slice(t.end) : head;
  const b = BRACKET.exec(rest.length > 80 ? rest.slice(0, 80) : rest);
  if (b) return levelOfWord(b[1] ?? "");
  const m = BARE.exec(rest);
  return m ? levelOfWord(m[1] ?? "") : 0;
}

function firstChar(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    if (c !== " " && c !== "\t") return c;
  }
  return "";
}

/** A leading timestamp: where it ends (with the space after it), its short form and as written. */
export interface LogTime {
  readonly end: number;
  readonly short: string;
  readonly full: string;
}

// [ISO date T|space | syslog "Nov 14 " | Go's "2026/11/14 "] HH:MM:SS[.frac][zone], maybe in brackets.
const TIME = /^\[?((?:\d{4}-\d\d-\d\d[T ]|[A-Z][a-z]{2} [ \d]\d |\d{4}\/\d\d\/\d\d )?(\d\d:\d\d:\d\d)(?:[.,](\d+))?(?:Z|[+-]\d\d(?::?\d\d)?)?)\]?(?![\w:])\s*/;

/** The timestamp a line starts with, or null. */
export function timeAt(line: string): LogTime | null {
  const c = line.charCodeAt(0);
  // A digit, "[", or a month's capital: anything else starts no timestamp.
  if (!((c >= 48 && c <= 57) || c === 91 || (c >= 65 && c <= 90))) return null;
  const m = TIME.exec(line);
  if (!m) return null;
  const full = m[1] ?? "";
  const frac = m[3];
  const short = (m[2] ?? "") + (frac ? `.${frac.slice(0, 3)}` : "");
  return { end: m[0].length, short, full };
}

/** A timestamp value from a JSON or logfmt field: a string with a time in it, or epoch seconds or milliseconds. */
export function timeOfValue(v: unknown): Omit<LogTime, "end"> | null {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e11 ? v : v * 1000;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return { short: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`, full: d.toISOString() };
  }
  if (typeof v !== "string") return null;
  const m = /(\d\d:\d\d:\d\d)(?:[.,](\d+))?/.exec(v);
  if (!m) return null;
  return { short: (m[1] ?? "") + (m[2] ? `.${m[2].slice(0, 3)}` : ""), full: v };
}

const JSON_TIME = /"(?:time|ts|timestamp|@timestamp|t|date)"\s*:\s*(?:"([^"]*)"|(\d+(?:\.\d+)?))/;
const KV_TIME = /^(?:time|ts|t|timestamp)=("[^"]*"|\S+)/;

/** The short form of the time an entry starts with: a leading timestamp, a logfmt time first, a JSON line's time key. */
export function entryTime(line: string): string | null {
  const c = line.charCodeAt(0);
  if (c === 123) {
    const m = JSON_TIME.exec(line);
    return m ? (timeOfValue(m[2] !== undefined ? Number(m[2]) : (m[1] ?? ""))?.short ?? null) : null;
  }
  if (c === 116) {
    const m = KV_TIME.exec(line);
    if (m) return timeOfValue(unquote(m[1] ?? ""))?.short ?? null;
  }
  return timeAt(line)?.short ?? null;
}

/** Whether a line starts an entry: a timestamp, a logfmt time, or a JSON object. Others continue the one above. */
export function startsEntry(line: string): boolean {
  const c = line.charCodeAt(0);
  if (c === 123) return true;
  if (c === 116 && /^(?:time|ts|t)=/.test(line)) return true;
  return timeAt(line) !== null;
}

/** A `key=value` field: [keyFrom, eq) is the key, (eq, to) the value, in the line's text. */
export interface Field {
  readonly from: number;
  readonly eq: number;
  readonly to: number;
}

const KEY = /^[A-Za-z_][\w.\-/@]*=/;

/** The line's words from `from`, by spaces, a double-quoted stretch (with \" in it) staying one word. */
export function words(text: string, from = 0): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let i = from;
  while (i < text.length) {
    while (i < text.length && (text.charAt(i) === " " || text.charAt(i) === "\t")) i++;
    if (i >= text.length) break;
    const start = i;
    let quoted = false;
    for (; i < text.length; i++) {
      const c = text.charAt(i);
      if (quoted && c === "\\") i++;
      else if (c === '"') quoted = !quoted;
      else if (!quoted && (c === " " || c === "\t")) break;
    }
    out.push({ from: start, to: Math.min(i, text.length) });
  }
  return out;
}

/** The `key=value` words at the end of the text from `from` (a message's fields), and where they start. */
export function trailingFields(text: string, from = 0): { at: number; fields: Field[] } {
  const ws = words(text, from);
  let k = ws.length;
  while (k > 0) {
    const w = ws[k - 1];
    if (!w || !KEY.test(text.slice(w.from, w.to))) break;
    k--;
  }
  const fields = ws.slice(k).map((w) => ({ from: w.from, eq: text.indexOf("=", w.from), to: w.to }));
  return { at: fields[0]?.from ?? text.length, fields };
}

/** A logfmt value without its quotes and escapes. */
function unquote(v: string): string {
  if (v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v;
  try {
    return JSON.parse(v) as string;
  } catch {
    return v.slice(1, -1);
  }
}

/** A line laid out for a row: the time and level columns, the message, then the fields (dimmed). */
export interface LogLineView {
  /** The row's text, from which `from` on is shown after the columns; a JSON or logfmt line's is rebuilt. */
  readonly text: string;
  readonly time: Omit<LogTime, "end"> | null;
  /** The level this line says (its column); 0 when it says none. */
  readonly level: Level;
  /** Where the message starts in `text` (after a timestamp and a level word that came first). */
  readonly from: number;
  /** Where the trailing fields start; text.length when there are none. */
  readonly fieldsAt: number;
  readonly fields: readonly Field[];
  /** Whether `text` is the line as written (its ANSI runs still line up), not rebuilt. */
  readonly asWritten: boolean;
}

const TIME_KEYS = ["time", "ts", "timestamp", "@timestamp", "t", "date"];
const LEVEL_KEYS = ["level", "lvl", "severity", "levelname", "log.level"];
const MSG_KEYS = ["msg", "message", "@message", "event"];

const fieldText = (k: string, v: unknown) => {
  const s = typeof v === "string" ? (/[\s"=]/.test(v) || v === "" ? JSON.stringify(v) : v) : JSON.stringify(v);
  return `${k}=${s}`;
};

/** A rebuilt row: message, then the fields as `k=v`. */
function rebuilt(time: LogLineView["time"], level: Level, msg: string, pairs: string[]): LogLineView {
  const head = msg.replace(/\s+/g, " ");
  const text = pairs.length ? `${head}${head ? " " : ""}${pairs.join(" ")}` : head;
  const { at, fields } = trailingFields(text, head.length);
  return { text, time, level, from: 0, fieldsAt: pairs.length ? at : text.length, fields: pairs.length ? fields : [], asWritten: false };
}

function jsonView(line: string): LogLineView | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  const pick = (keys: string[]) => keys.find((k) => k in rec);
  const tk = pick(TIME_KEYS);
  const lk = pick(LEVEL_KEYS);
  const mk = pick(MSG_KEYS);
  const lv = lk === undefined ? undefined : rec[lk];
  const level = typeof lv === "number" ? levelOfNumber(lv) : typeof lv === "string" ? levelOfWord(lv) : 0;
  const mv = mk === undefined ? undefined : rec[mk];
  const msg = typeof mv === "string" ? mv : mv === undefined ? "" : JSON.stringify(mv);
  const pairs = Object.entries(rec)
    .filter(([k]) => k !== tk && k !== mk && (k !== lk || level === 0))
    .map(([k, v]) => fieldText(k, v));
  return rebuilt(tk === undefined ? null : timeOfValue(rec[tk]), level, msg, pairs);
}

function logfmtView(line: string): LogLineView | null {
  const ws = words(line);
  if (ws.length === 0) return null;
  const pairs: { k: string; raw: string; v: string }[] = [];
  for (const w of ws) {
    const s = line.slice(w.from, w.to);
    if (!KEY.test(s)) return null;
    const eq = s.indexOf("=");
    pairs.push({ k: s.slice(0, eq), raw: s, v: unquote(s.slice(eq + 1)) });
  }
  const find = (keys: string[]) => pairs.find((p) => keys.includes(p.k));
  const t = find(["time", "ts", "t", "timestamp"]);
  const l = find(["level", "lvl", "severity"]);
  const m = find(["msg", "message"]);
  if (!t && !l && !m) return null;
  const level = l ? levelOfWord(l.v) : 0;
  const rest = pairs.filter((p) => p !== t && p !== m && (p !== l || level === 0)).map((p) => p.raw);
  return rebuilt(t ? timeOfValue(t.v) : null, level, m?.v ?? "", rest);
}

// The first word after the timestamp, when it is the line's level: "[warn]", "ERROR:", "INFO -".
const LEAD_LEVEL = /^(?:\[([A-Za-z]+)\]|([A-Z]+)):?(?:\s+-)?(?:\s+|$)/;

/**
 * A line laid out for a row. `structured`: a `.log` line, whose timestamp, level and fields
 * are looked for; otherwise (terminal output) the whole line is the message.
 */
export function viewLine(line: string, structured: boolean): LogLineView {
  const plain: LogLineView = { text: line, time: null, level: 0, from: 0, fieldsAt: line.length, fields: [], asWritten: true };
  if (!structured || line === "") return plain;
  const first = firstChar(line.length > 8 ? line.slice(0, 8) : line);
  if (first === "{" && line.trimEnd().endsWith("}")) {
    const j = jsonView(line.trim());
    if (j) return j;
  }
  if (/^[A-Za-z_][\w.\-/@]*=/.test(line)) {
    const l = logfmtView(line);
    if (l) return l;
  }
  const t = timeAt(line);
  // A continuation (no timestamp, indented) stays as written.
  if (!t && (line.startsWith(" ") || line.startsWith("\t"))) return plain;
  let from = t?.end ?? 0;
  const level = detectLevel(line);
  const lead = LEAD_LEVEL.exec(line.slice(from));
  // Moved to the level column only when it is the level the line was found to have.
  if (lead && level !== 0 && levelOfWord(lead[1] ?? lead[2] ?? "") === level) from += lead[0].length;
  if (!t && level === 0) return plain;
  const { at, fields } = trailingFields(line, from);
  return { text: line, time: t ? { short: t.short, full: t.full } : null, level, from, fieldsAt: at, fields, asWritten: true };
}
