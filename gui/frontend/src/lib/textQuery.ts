/**
 * Text search's query rules shared by the GUI's preview and the mock daemon
 * (docs/notes/file-search-5-text-mode.md): the daemon's smart case, and the query as a
 * JavaScript RegExp for matching a file's lines again. No imports: the mock loads it as is.
 */

/** The query fields these read (api/textSearch TextQueryView's). */
interface QueryShape {
  query: string;
  wholeWord: boolean;
  regex: boolean;
}

/** A span of a text, UTF-16 offsets, end exclusive. */
interface Span {
  start: number;
  end: number;
}

/**
 * The daemon's smart case (textsearch.Query.CaseSensitive): match case, or an upper-case
 * letter in the query; in a regex a letter after a backslash is not text (`\W`, `\S`, and
 * what `\p{…}` / `\x{…}` hold).
 */
export function smartCaseSensitive(text: string, matchCase: boolean, regex: boolean): boolean {
  if (matchCase) return true;
  const cps = Array.from(text);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] ?? "";
    if (regex && c === "\\") {
      i++; // the escaped character
      if (cps[i + 1] === "{") {
        const end = cps.indexOf("}", i + 1);
        if (end >= 0) i = end;
      }
      continue;
    }
    if (/\p{Lu}/u.test(c)) return true;
  }
  return false;
}

/**
 * The query as a global JavaScript RegExp with the daemon's rules: literal unless `regex`,
 * whole words as Unicode word boundaries, case as given. Null when JavaScript cannot compile
 * it (a regex in syntax only Rust's engine has): the preview then paints only the daemon's
 * own ranges of the selected line.
 */
export function queryRegExp(q: QueryShape, caseSensitive: boolean): RegExp | null {
  if (q.query === "") return null;
  let source = q.regex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (q.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  try {
    return new RegExp(source, `gu${caseSensitive ? "" : "i"}`);
  } catch {
    return null;
  }
}

/** Every match of `re` in a text, UTF-16 offsets; empty matches skipped. */
export function matchRanges(re: RegExp, text: string): Span[] {
  const out: Span[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === "") {
      re.lastIndex += (text.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}
