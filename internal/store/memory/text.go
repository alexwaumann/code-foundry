package memory

import (
	"fmt"
	"strings"
	"unicode/utf8"
)

// Clean checks that text can be an entry and normalises it (Normalize): one line, not
// empty, at most MaxEntryChars characters.
func Clean(text string) (string, error) {
	if strings.ContainsAny(strings.TrimSpace(text), "\n\r") {
		return "", fmt.Errorf("%w: an entry is one line; add each preference on its own", ErrInvalidArgument)
	}
	text = Normalize(text)
	if text == "" {
		return "", fmt.Errorf("%w: an empty entry", ErrInvalidArgument)
	}
	if n := utf8.RuneCountInString(text); n > MaxEntryChars {
		return "", fmt.Errorf("%w: an entry is at most %d characters and this one has %d; say it shorter or split it in two",
			ErrInvalidArgument, MaxEntryChars, n)
	}
	return text, nil
}

// Normalize is an entry as stored: trimmed, each run of white space one space, without
// a leading "- " (a list item's) and without a sentence's full stop (an ellipsis stays,
// so normalising twice changes nothing). "" when nothing is left.
func Normalize(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if text == "-" {
		return ""
	}
	text = strings.TrimPrefix(text, "- ")
	if !strings.HasSuffix(text, "..") {
		text = strings.TrimSuffix(text, ".")
	}
	return strings.TrimSpace(text)
}

// Parse reads the entries of a file of "- <text>" lines (the single memory.md before
// the directory, legacy.go), edited by hand or not: CRLF line ends, blank lines,
// markdown headings and <!-- --> comments are skipped; every other line is an entry,
// normalised (Normalize). An entry repeated (any case) counts once.
func Parse(file string) []string {
	var out []string
	seen := map[string]bool{}
	for _, line := range lines(file) {
		t := Normalize(line)
		if k := strings.ToLower(t); t != "" && !seen[k] {
			seen[k] = true
			out = append(out, t)
		}
	}
	return out
}

// lines are file's lines with line ends unified, invalid UTF-8, <!-- --> comments,
// markdown headings and blank lines dropped.
func lines(file string) []string {
	file = strings.ToValidUTF8(file, "")
	file = strings.ReplaceAll(file, "\r\n", "\n")
	file = strings.ReplaceAll(file, "\r", "\n")
	file = stripComments(file)
	var out []string
	for line := range strings.SplitSeq(file, "\n") {
		if heading(line) || strings.TrimSpace(line) == "" {
			continue
		}
		out = append(out, line)
	}
	return out
}

// stripComments drops every <!-- ... --> from file (one left open runs to the end). A
// comment's line breaks stay, so the lines around it stay apart.
func stripComments(file string) string {
	var b strings.Builder
	for {
		i := strings.Index(file, "<!--")
		if i < 0 {
			b.WriteString(file)
			return b.String()
		}
		b.WriteString(file[:i])
		j := strings.Index(file[i+len("<!--"):], "-->")
		if j < 0 {
			return b.String()
		}
		end := i + len("<!--") + j + len("-->")
		b.WriteString(strings.Repeat("\n", strings.Count(file[i:end], "\n")))
		file = file[end:]
	}
}

// heading reports a markdown heading line: one to six #, then white space or nothing.
func heading(line string) bool {
	line = strings.TrimSpace(line)
	n := len(line) - len(strings.TrimLeft(line, "#"))
	return n >= 1 && n <= 6 && (len(line) == n || line[n] == ' ' || line[n] == '\t')
}

// Render is entries as the prompt lists them: one "- <text>" line each. Its length is
// what MaxBytes caps.
func Render(texts []string) string {
	var b strings.Builder
	for _, t := range texts {
		b.WriteString("- ")
		b.WriteString(t)
		b.WriteByte('\n')
	}
	return b.String()
}
