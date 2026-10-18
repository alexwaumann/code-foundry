/**
 * Citations: text quoted from one of Claude's answers into the composer
 * (docs/notes/citations.md). Pure functions only; the DOM side (the item's plain text,
 * ranges, highlights) is components/thread/cite/citeDom.ts.
 *
 * In the draft a citation is a tag token that names the citation by id; its body (the
 * quote, the comment, where it came from) lives in the draft's `citations`:
 *
 *   [Assistant quote](cf-cite://<citationId>)
 *
 * Sent, the token becomes a self-contained Markdown link (T3 Code's format, which Claude
 * reads as a quote with its source), stored as the message text and the composer text:
 *
 *   [Assistant quote](cf-cite://v1/<threadId>/<itemId>?text=…&start=12&end=40&prefix=…&suffix=…&comment=…)
 *
 * Every value is percent-encoded (including `!'()*`, so a `)` cannot end the link);
 * `comment` is left out when there is none. The bubble parses the link back into the
 * chip (splitCiteLinks). Offsets are into the item's rendered plain text; prefix and
 * suffix are the CITE_CONTEXT characters around the quote there, for re-anchoring when
 * the offsets drift (locateQuote).
 */

export const CITE_SCHEME = "cf-cite://";
/** The label of every citation token and link (the chip shows the quote instead). */
export const CITE_LABEL = "Assistant quote";
/** Characters of context kept on each side of the quote. */
export const CITE_CONTEXT = 32;
/** The chip label: at most this many words of the quote … */
export const CITE_LABEL_WORDS = 4;
/** … and at most this many characters, … */
export const CITE_LABEL_CHARS = 24;
/** … cut at the last word boundary within them when that keeps at least this many (else mid-word). */
export const CITE_LABEL_MIN_CHARS = 12;

/** Where a citation came from and what it says (everything the sent link carries). */
export interface CitationBody {
  /** The thread the quoted item was in when cited. */
  threadId: string;
  /** The quoted assistant text item. */
  itemId: string;
  /** The quote, as rendered (inline code without backticks, a newline between blocks). */
  text: string;
  /** The user's comment on it; "" for none. */
  comment: string;
  /** Offsets of the quote in the item's rendered plain text, end exclusive. */
  start: number;
  end: number;
  /** Up to CITE_CONTEXT characters before and after the quote in that text. */
  prefix: string;
  suffix: string;
}

/** A draft's citation: its body under the id its token names. */
export interface Citation extends CitationBody {
  id: string;
}

/** A fresh citation id: "c" and 12 hex digits. */
export function newCitationId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The draft token for a citation id. */
export function citeToken(id: string): string {
  return `[${CITE_LABEL}](${CITE_SCHEME}${id})`;
}

/**
 * The chip's label: the first CITE_LABEL_WORDS words of the quote, at most
 * CITE_LABEL_CHARS characters (cut at the last word boundary within them when that keeps
 * at least CITE_LABEL_MIN_CHARS, else mid-word), with an ellipsis when anything was cut.
 * "Quote" for an empty one.
 */
export function citeLabel(quote: string): string {
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Quote";
  let chars = Array.from(words.slice(0, CITE_LABEL_WORDS).join(" "));
  let cut = words.length > CITE_LABEL_WORDS;
  if (chars.length > CITE_LABEL_CHARS) {
    // A space right after the limit is a boundary too: the word before it fits whole.
    const space = chars.slice(0, CITE_LABEL_CHARS + 1).lastIndexOf(" ");
    chars = chars.slice(0, space >= CITE_LABEL_MIN_CHARS ? space : CITE_LABEL_CHARS);
    cut = true;
  }
  const label = chars.join("").trimEnd();
  return cut ? `${label}…` : label;
}

/**
 * encodeURIComponent plus the characters that would end a Markdown link (`(`, `)`) or read
 * oddly in it. A lone surrogate (which encodeURIComponent throws on) becomes U+FFFD.
 */
function encode(s: string): string {
  return encodeURIComponent(s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")).replace(/[!'()*]/g, (c) => `%${(c.codePointAt(0) ?? 0).toString(16).toUpperCase()}`);
}

function decode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** The link Claude gets for a citation (and the bubble reads back): see the header. */
export function citeLink(c: CitationBody): string {
  const q = [`text=${encode(c.text)}`, `start=${String(c.start)}`, `end=${String(c.end)}`, `prefix=${encode(c.prefix)}`, `suffix=${encode(c.suffix)}`];
  if (c.comment) q.push(`comment=${encode(c.comment)}`);
  return `[${CITE_LABEL}](${CITE_SCHEME}v1/${encode(c.threadId)}/${encode(c.itemId)}?${q.join("&")})`;
}

/** Groups: 1 thread id, 2 item id, 3 the query. Any label: Claude or a hand edit may change it. */
const CITE_LINK = /\[[^[\]\n]*\]\(cf-cite:\/\/v1\/([^\s/?()]+)\/([^\s/?()]+)\?([^\s()]*)\)/g;

const OFFSET = /^(0|[1-9][0-9]{0,8})$/;

/** A link's parts as a citation body, or null when they do not decode (the link stays text). */
function citeOf(thread: string, item: string, query: string): CitationBody | null {
  const threadId = decode(thread);
  const itemId = decode(item);
  if (!threadId || !itemId) return null;
  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const v = decode(pair.slice(eq + 1));
    if (v === null) return null;
    params.set(pair.slice(0, eq), v);
  }
  const text = params.get("text") ?? "";
  const start = params.get("start") ?? "";
  const end = params.get("end") ?? "";
  if (!text.trim() || !OFFSET.test(start) || !OFFSET.test(end) || Number(end) < Number(start)) return null;
  return { threadId, itemId, text, comment: params.get("comment") ?? "", start: Number(start), end: Number(end), prefix: params.get("prefix") ?? "", suffix: params.get("suffix") ?? "" };
}

/** One link (exactly, nothing around it) as a citation body, or null. */
export function parseCiteLink(link: string): CitationBody | null {
  const m = new RegExp(`^${CITE_LINK.source}$`).exec(link);
  return m ? citeOf(m[1] ?? "", m[2] ?? "", m[3] ?? "") : null;
}

export type CitePiece = { kind: "text"; text: string } | { kind: "cite"; cite: CitationBody };

/** A text with its citation links as citations, in order; links that do not decode stay text. */
export function splitCiteLinks(text: string): CitePiece[] {
  const out: CitePiece[] = [];
  let last = 0;
  const push = (t: string) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev?.kind === "text") prev.text += t;
    else out.push({ kind: "text", text: t });
  };
  for (const m of text.matchAll(CITE_LINK) as IterableIterator<RegExpExecArray>) {
    const cite = citeOf(m[1] ?? "", m[2] ?? "", m[3] ?? "");
    if (!cite) continue;
    push(text.slice(last, m.index));
    out.push({ kind: "cite", cite });
    last = m.index + m[0].length;
  }
  push(text.slice(last));
  return out;
}

/** The body of a quote taken from an item's plain text: the selected offsets, trimmed of surrounding whitespace, with its context. Null when only whitespace is selected. */
export function quoteAt(plain: string, start: number, end: number): Pick<CitationBody, "text" | "start" | "end" | "prefix" | "suffix"> | null {
  let s = Math.max(0, Math.min(start, end));
  let e = Math.min(plain.length, Math.max(start, end));
  while (s < e && /\s/.test(plain.charAt(s))) s++;
  while (e > s && /\s/.test(plain.charAt(e - 1))) e--;
  if (s >= e) return null;
  // The context never starts or ends inside a surrogate pair (an emoji cut in half does
  // not encode: encodeURIComponent throws on a lone surrogate).
  let from = Math.max(0, s - CITE_CONTEXT);
  if (from > 0 && isLow(plain.charCodeAt(from))) from++;
  let to = Math.min(plain.length, e + CITE_CONTEXT);
  if (to < plain.length && isLow(plain.charCodeAt(to))) to--;
  return { text: plain.slice(s, e), start: s, end: e, prefix: plain.slice(from, s), suffix: plain.slice(e, to) };
}

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The string without whitespace, and for each of its characters the index it had. */
function squashed(s: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s.charAt(i);
    if (/\s/.test(ch)) continue;
    text += ch;
    at.push(i);
  }
  return { text, at };
}

const squash = (s: string) => s.replace(/\s+/g, "");

function commonSuffix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a.charAt(a.length - 1 - n) === b.charAt(b.length - 1 - n)) n++;
  return n;
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a.charAt(n) === b.charAt(n)) n++;
  return n;
}

/**
 * Where a citation's quote is in an item's plain text now: its offsets when the text there
 * is still the quote and the prefix and suffix agree; else the occurrence of the quote
 * whose surroundings agree best with them (ties: the one nearest the old offsets); null
 * when the quote is not in the text. Whitespace is ignored throughout (the rendered text
 * can break lines differently).
 */
export function locateQuote(plain: string, c: Pick<CitationBody, "text" | "start" | "end" | "prefix" | "suffix">): { start: number; end: number } | null {
  const want = squash(c.text);
  if (!want) return null;
  const prefix = squash(c.prefix);
  const suffix = squash(c.suffix);
  const score = (s: number, e: number) =>
    commonSuffix(prefix, squash(plain.slice(Math.max(0, s - CITE_CONTEXT - 16), s))) + commonPrefix(suffix, squash(plain.slice(e, e + CITE_CONTEXT + 16)));
  const full = prefix.length + suffix.length;
  if (c.start >= 0 && c.end <= plain.length && c.start < c.end && squash(plain.slice(c.start, c.end)) === want && score(c.start, c.end) === full) {
    return { start: c.start, end: c.end };
  }
  const { text, at } = squashed(plain);
  let best: { start: number; end: number; score: number; dist: number } | null = null;
  for (let k = text.indexOf(want); k >= 0; k = text.indexOf(want, k + 1)) {
    const start = at[k] ?? 0;
    const end = (at[k + want.length - 1] ?? start) + 1;
    const sc = score(start, end);
    const dist = Math.abs(start - c.start);
    if (!best || sc > best.score || (sc === best.score && dist < best.dist)) best = { start, end, score: sc, dist };
  }
  return best && { start: best.start, end: best.end };
}

/**
 * The item a selection cites: both of its ends inside the same citable item (an assistant
 * answer, by id; null for an end outside every answer) and some text selected. Null
 * otherwise: a selection that leaves its answer (into a tool row, a bubble, another
 * answer, the header) cites nothing.
 */
export function citableItem(anchorItem: string | null, focusItem: string | null, selected: string): string | null {
  if (!anchorItem || anchorItem !== focusItem) return null;
  return selected.trim() ? anchorItem : null;
}

/** A box in viewport px. */
export interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type CiteSide = "below" | "above";

export interface CitePlaceInput {
  /** The quote's first and last line boxes. */
  first: Box;
  last: Box;
  /** Where the floating surface centres horizontally (the pointer's x, or the quote's end). */
  x: number;
  /** The floating surface's size. */
  width: number;
  height: number;
  /** The thread body (under the header): the edges it stays inside. */
  pane: Box;
  /** The top of the composer: there must be room above it to go below the quote. */
  floor: number;
  /** Keep this side (the comment popover keeps the side it opened on while its field grows). */
  side?: CiteSide;
}

export interface CitePlacement {
  left: number;
  top: number;
  side: CiteSide;
  /** The line it hangs from is in view (between the pane's top and the composer). */
  visible: boolean;
  /** The height it may grow to on its side, down to the pane's bottom or up to its top (less the edge gap). */
  room: number;
}

/** The gap between the quote's line and the floating surface. */
export const CITE_GAP = 6;
/** The gap kept to the pane's edges. */
export const CITE_EDGE = 12;

/**
 * Where the Cite button and the comment popover go (the sketch's rules): CITE_GAP under
 * the quote's last line, centred on `x`, clamped CITE_EDGE inside the pane's sides; above
 * its first line instead when the room left under it, above the composer, is too short
 * and there is room above (else it stays below). Hidden while that line is out of view.
 */
export function placeCite(p: CitePlaceInput): CitePlacement {
  const minLeft = p.pane.left + CITE_EDGE;
  const maxLeft = p.pane.right - CITE_EDGE - p.width;
  const left = Math.max(minLeft, Math.min(p.x - p.width / 2, maxLeft));
  const belowTop = p.last.bottom + CITE_GAP;
  const aboveTop = p.first.top - CITE_GAP - p.height;
  const fitsBelow = belowTop + p.height <= p.floor - CITE_EDGE;
  const fitsAbove = aboveTop >= p.pane.top + CITE_EDGE;
  const side: CiteSide = p.side ?? (fitsBelow || !fitsAbove ? "below" : "above");
  const line = side === "below" ? p.last : p.first;
  const visible = line.bottom > p.pane.top && line.top < p.floor;
  if (side === "below") return { left, top: belowTop, side, visible, room: p.pane.bottom - CITE_EDGE - belowTop };
  return { left, top: aboveTop, side, visible, room: p.first.top - CITE_GAP - (p.pane.top + CITE_EDGE) };
}
