/**
 * CSV and TSV as the Table preview reads them (RFC 4180, forgiving): fields split on the
 * delimiter, a field in double quotes may hold the delimiter, line breaks and `""` (one
 * quote); a quote inside an unquoted field is kept as text. Records end at LF, CRLF or a lone
 * CR. A leading byte order mark is dropped, a trailing line break ends the last record
 * without starting another, and blank lines (and a whitespace-only last line) are no
 * records. Pure.
 */

export interface CsvParse {
  /** Every record, the header first; rows keep their own length (ragged). */
  readonly records: string[][];
  /** The text ended inside a quoted field: the last record is cut short. */
  readonly openQuote: boolean;
  /** The text ended at the end of a record (a line break outside quotes, or nothing at all). */
  readonly endsClean: boolean;
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

/** Splits `text` into records of fields. `delimiter` is one character. */
export function parseCsv(text: string, delimiter: string): CsvParse {
  const delim = delimiter.charCodeAt(0);
  const records: string[][] = [];
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  // Whether the current record has begun (a field, a delimiter or a quote seen).
  let started = false;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (quoted) {
      if (c === QUOTE) {
        if (text.charCodeAt(i + 1) === QUOTE) {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      // Copy a run of plain characters at once.
      let j = text.indexOf('"', i);
      if (j < 0) j = n;
      field += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === delim) {
      row.push(field);
      field = "";
      started = true;
      i++;
      continue;
    }
    if (c === LF || c === CR) {
      // A blank line is no record (as most readers skip it); `""` alone is one empty field.
      if (started || field !== "") {
        row.push(field);
        records.push(row);
      }
      row = [];
      field = "";
      started = false;
      i += c === CR && text.charCodeAt(i + 1) === LF ? 2 : 1;
      continue;
    }
    if (c === QUOTE && field === "") {
      quoted = true;
      started = true;
      i++;
      continue;
    }
    // A plain run up to the next delimiter, quote or line break.
    let j = i + 1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if (d === delim || d === LF || d === CR || d === QUOTE) break;
      j++;
    }
    // A quote in the middle of an unquoted field is text.
    if (j < n && text.charCodeAt(j) === QUOTE && j > i) {
      field += text.slice(i, j + 1);
      i = j + 1;
    } else {
      field += text.slice(i, j);
      i = j;
    }
    started = true;
  }
  const openQuote = quoted;
  const endsClean = !started && field === "";
  if (started || field !== "") {
    row.push(field);
    // A last line of spaces alone is no record.
    if (!(row.length === 1 && row[0]?.trim() === "" && !openQuote)) records.push(row);
  }
  return { records, openQuote, endsClean };
}

/** The delimiter for a path: tab for .tsv, else a comma unless the header clearly uses `;` or tab. */
export function delimiterFor(path: string, text: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "tsv") return "\t";
  return sniffDelimiter(text);
}

/**
 * A .csv's delimiter, from its first line (outside quotes): a comma unless that line has
 * more `;` (Excel's in many locales) or more tabs than commas.
 */
export function sniffDelimiter(text: string): string {
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let quoted = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "\n" || c === "\r") break;
    else if (c === ",") commas++;
    else if (c === ";") semis++;
    else if (c === "\t") tabs++;
  }
  if (semis > commas && semis >= tabs) return ";";
  if (tabs > commas) return "\t";
  return ",";
}
