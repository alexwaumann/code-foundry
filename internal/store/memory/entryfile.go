package memory

import (
	"strconv"
	"strings"
	"time"
)

// IndexFile is the directory's index: one "- [<text>](<file>)" line per entry, in
// order, rewritten after every write. It is never read: the entry files are the memory.
const IndexFile = "MEMORY.md"

// CreatedLayout is created as written (frontmatter, the memory.* commands' JSON): RFC
// 3339 in UTC to the millisecond. The entries are ordered by it, and seconds would put
// two adds in one second (a model saving two preferences in one command) in file-name
// order.
const CreatedLayout = "2006-01-02T15:04:05.000Z07:00"

// maxSlug caps an entry file's name before ".md" and a de-duplicating suffix.
const maxSlug = 48

// latin maps the common Latin letters with diacritics (and the ligatures) to the ASCII
// a slug keeps of them: "naïve café" is naive-cafe. Built from latinTable.
var latin = func() map[rune]string {
	m := map[rune]string{}
	for group := range strings.SplitSeq(latinTable, " ") {
		letters, ascii, _ := strings.Cut(group, ":")
		for _, r := range letters {
			m[r] = ascii
		}
	}
	return m
}()

const latinTable = "àáâãäåāăą:a çćĉċč:c ďđð:d èéêëēĕėęě:e ĝğġģ:g ĥħ:h ìíîïĩīĭįı:i ĵ:j ķ:k ĺļľŀł:l " +
	"ñńņňŉ:n òóôõöøōŏő:o ŕŗř:r śŝşšș:s ţťŧț:t ùúûüũūŭůűų:u ŵ:w ýÿŷ:y źżž:z ß:ss æ:ae œ:oe þ:th"

// slug is an entry file's name for text, before ".md": lowercase ASCII letters and
// digits (a Latin letter with a diacritic as its plain letter), every other run a dash,
// at most maxSlug bytes (cut at a dash when one is past half way). "entry" when nothing
// is left (a text in another script; Clean refuses one with no letter or digit).
func slug(text string) string {
	var b strings.Builder
	dash := false
	for _, r := range strings.ToLower(text) {
		ascii, ok := latin[r]
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9':
			b.WriteRune(r)
			dash = false
		case ok:
			b.WriteString(ascii)
			dash = false
		case b.Len() > 0 && !dash:
			b.WriteByte('-')
			dash = true
		}
	}
	s := strings.TrimRight(b.String(), "-")
	if len(s) > maxSlug {
		s = s[:maxSlug]
		if i := strings.LastIndexByte(s, '-'); i > maxSlug/2 {
			s = s[:i]
		}
		s = strings.TrimRight(s, "-")
	}
	if s == "" {
		return "entry"
	}
	return s
}

// fileName is the first of "<slug>.md", "<slug>-2.md", ... that taken (lowercased
// names) does not hold. "memory.md" is never one: on a case-insensitive volume it is
// the index.
func fileName(text string, taken map[string]bool) string {
	base := slug(text)
	for n := 1; ; n++ {
		name := base + ".md"
		if n > 1 {
			name = base + "-" + strconv.Itoa(n) + ".md"
		}
		if k := strings.ToLower(name); !taken[k] && k != strings.ToLower(IndexFile) {
			return name
		}
	}
}

// renderEntry is an entry file: frontmatter with created and, for an entry a thread
// added, the thread's id and its name then, and the text on one line.
func renderEntry(text string, created time.Time, by Origin) string {
	var b strings.Builder
	b.WriteString("---\ncreated: ")
	b.WriteString(created.UTC().Format(CreatedLayout))
	b.WriteByte('\n')
	if by.ThreadID != "" {
		b.WriteString("thread: " + yamlValue(by.ThreadID) + "\n")
		if by.ThreadName != "" {
			b.WriteString("thread_name: " + yamlValue(by.ThreadName) + "\n")
		}
	}
	b.WriteString("---\n")
	b.WriteString(text)
	b.WriteByte('\n')
	return b.String()
}

// yamlValue is v as a YAML scalar: plain when it can be, else double-quoted (Go's
// escapes are YAML's for what a thread name holds).
func yamlValue(v string) string {
	plain := v != "" && v == strings.TrimSpace(v) && !strings.ContainsAny(v, ":#\"'\\\n\r\t{}[],&*!|>%@`") &&
		!strings.HasPrefix(v, "-") && !strings.HasPrefix(v, "?")
	if plain {
		return v
	}
	return strconv.Quote(v)
}

// parsed is an entry file read back.
type parsed struct {
	text               string
	created            time.Time // zero: none or not a time
	threadID, threadNm string
}

// parseEntry reads an entry file, written by the store or by hand. Frontmatter is a
// first line "---" up to the next "---" line; without the closing line the whole file
// is the text. Unknown keys and a created that is not a time are ignored. The text is
// what is left: comments, headings and blank lines dropped, the rest joined into one
// line and normalised (Normalize); "" when nothing is.
func parseEntry(file string) parsed {
	file = strings.ToValidUTF8(file, "")
	file = strings.ReplaceAll(file, "\r\n", "\n")
	var p parsed
	body := file
	if rest, ok := strings.CutPrefix(file, "---\n"); ok {
		if fm, after, ok := cutFrontmatter(rest); ok {
			body = after
			for line := range strings.SplitSeq(fm, "\n") {
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				v = unquote(strings.TrimSpace(v))
				switch strings.TrimSpace(k) {
				case "created":
					if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
						p.created = t.UTC()
					}
				case "thread":
					p.threadID = v
				case "thread_name":
					p.threadNm = v
				}
			}
		}
	}
	p.text = Normalize(strings.Join(lines(body), " "))
	return p
}

// cutFrontmatter splits s (a file after its opening "---" line) at its closing "---"
// line.
func cutFrontmatter(s string) (fm, after string, ok bool) {
	if rest, ok := strings.CutPrefix(s, "---\n"); ok || s == "---" {
		return "", rest, true
	}
	if i := strings.Index(s, "\n---\n"); i >= 0 {
		return s[:i], s[i+len("\n---\n"):], true
	}
	if before, ok := strings.CutSuffix(s, "\n---"); ok {
		return before, "", true
	}
	return "", "", false
}

// unquote is a YAML scalar's value: a double-quoted one unescaped, a single-quoted one
// unwrapped, a plain one as it is.
func unquote(v string) string {
	if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
		if u, err := strconv.Unquote(v); err == nil {
			return u
		}
		return v[1 : len(v)-1]
	}
	if len(v) >= 2 && v[0] == '\'' && v[len(v)-1] == '\'' {
		return strings.ReplaceAll(v[1:len(v)-1], "''", "'")
	}
	return v
}

// renderIndex is IndexFile for entries: "- [<text>](<file>)" each, brackets in the
// text escaped, a file name with spaces or brackets (one made by hand) in <>.
func renderIndex(entries []Entry) string {
	esc := strings.NewReplacer(`\`, `\\`, "[", `\[`, "]", `\]`)
	var b strings.Builder
	for _, e := range entries {
		b.WriteString("- [")
		b.WriteString(esc.Replace(e.Text))
		b.WriteString("](")
		if strings.ContainsAny(e.File, " ()<>") {
			b.WriteString("<" + e.File + ">")
		} else {
			b.WriteString(e.File)
		}
		b.WriteString(")\n")
	}
	return b.String()
}
