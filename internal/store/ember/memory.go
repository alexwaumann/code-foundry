package ember

import (
	"fmt"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// MEMORY.md's Notes: `code-foundry ember remember "<fact>"` appends a dated line under
// its "## Notes" heading at once; consolidation keeps those lines unless superseded.

// notesHeading is the heading remember appends under.
const notesHeading = "## Notes"

// maxFact caps one remembered fact.
const maxFact = 1000

// datedFact matches a date the caller already put in front of a fact ("2026-10-20: ",
// "- 2026-10-20 · "): Remember adds its own.
var datedFact = regexp.MustCompile(`^(?:- )?\d{4}-\d{2}-\d{2}\s*[:·]\s*`)

// Remember appends "- <date>: <fact>" under MEMORY.md's Notes (made when missing) and
// returns the line. A date already in front of the fact is dropped.
func (s *Store) Remember(fact string) (string, error) {
	fact = datedFact.ReplaceAllString(strings.Join(strings.Fields(fact), " "), "")
	switch {
	case fact == "":
		return "", fmt.Errorf("%w: an empty fact", ErrInvalidArgument)
	case len(fact) > maxFact:
		return "", fmt.Errorf("%w: the fact has %d bytes (at most %d)", ErrInvalidArgument, len(fact), maxFact)
	}
	if err := s.prepareHome(); err != nil {
		return "", err
	}
	line := "- " + s.opts.Now().In(s.opts.Location).Format("2006-01-02") + ": " + fact
	s.memMu.Lock()
	defer s.memMu.Unlock()
	mem := AddNote(s.readFile(memoryFile), line)
	if err := writeAtomic(filepath.Join(s.opts.Dir, memoryFile), []byte(mem)); err != nil {
		return "", err
	}
	s.log.Info("ember: remembered", "line", line)
	return line, nil
}

// AddNote returns memory with line appended at the end of its Notes section (before the
// next "## " heading), adding the section at the end when there is none.
func AddNote(memory, line string) string {
	lines := strings.Split(strings.TrimRight(memory, "\n"), "\n")
	if strings.TrimSpace(memory) == "" {
		lines = []string{"# Memory"}
	}
	start := slices.IndexFunc(lines, func(l string) bool { return strings.TrimSpace(l) == notesHeading })
	if start < 0 {
		return strings.Join(lines, "\n") + "\n\n" + notesHeading + "\n\n" + line + "\n"
	}
	end := len(lines)
	for i := start + 1; i < len(lines); i++ {
		if strings.HasPrefix(lines[i], "## ") || strings.HasPrefix(lines[i], "# ") {
			end = i
			break
		}
	}
	// After the section's last non-blank line.
	at := end
	for at > start+1 && strings.TrimSpace(lines[at-1]) == "" {
		at--
	}
	ins := []string{line}
	if at == start+1 {
		ins = []string{"", line} // a blank line after the heading
	}
	if at < len(lines) && strings.TrimSpace(lines[at]) != "" {
		ins = append(ins, "")
	}
	out := slices.Insert(slices.Clone(lines), at, ins...)
	return strings.Join(out, "\n") + "\n"
}

// notes are the lines of memory's Notes section that are list items.
func notes(memory string) []string {
	var out []string
	in := false
	for l := range strings.SplitSeq(memory, "\n") {
		switch {
		case strings.TrimSpace(l) == notesHeading:
			in = true
		case strings.HasPrefix(l, "#"):
			in = false
		case in && strings.HasPrefix(strings.TrimSpace(l), "- "):
			out = append(out, strings.TrimSpace(l))
		}
	}
	return out
}

// keepNewNotes adds to mem (a consolidation's new file) the Notes lines current has and
// before (the file the consolidation read) had not: facts remembered meanwhile.
func keepNewNotes(mem, before, current string) string {
	old := notes(before)
	for _, n := range notes(current) {
		if !slices.Contains(old, n) && !strings.Contains(mem, n) {
			mem = AddNote(mem, n)
		}
	}
	return mem
}
