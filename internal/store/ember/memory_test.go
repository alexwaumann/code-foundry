package ember

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAddNote(t *testing.T) {
	tests := []struct {
		name, memory, want string
	}{
		{"empty file", "", "# Memory\n\n## Notes\n\n- n\n"},
		{"no notes section", "# Memory\n\n## People\n- Sam", "# Memory\n\n## People\n- Sam\n\n## Notes\n\n- n\n"},
		{"empty notes section", "# Memory\n\n## Notes\n", "# Memory\n\n## Notes\n\n- n\n"},
		{"after the last note", "# Memory\n\n## Notes\n\n- a\n- b\n", "# Memory\n\n## Notes\n\n- a\n- b\n- n\n"},
		{"notes before another section", "# Memory\n\n## Notes\n\n- a\n\n## People\n- Sam\n",
			"# Memory\n\n## Notes\n\n- a\n- n\n\n## People\n- Sam\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := AddNote(tt.memory, "- n"); got != tt.want {
				t.Errorf("AddNote =\n%q\nwant\n%q", got, tt.want)
			}
		})
	}
}

func TestKeepNewNotes(t *testing.T) {
	before := "# Memory\n\n## Notes\n\n- 2026-10-19: old\n"
	current := "# Memory\n\n## Notes\n\n- 2026-10-19: old\n- 2026-10-20: new\n"
	mem := "# Memory\n\n## Prefs\n- tea\n\n## Notes\n\n- 2026-10-19: old\n"
	got := keepNewNotes(mem, before, current)
	if !strings.Contains(got, "- 2026-10-19: old\n- 2026-10-20: new\n") {
		t.Errorf("keepNewNotes = %q", got)
	}
	// A note the consolidation dropped on purpose stays dropped.
	if got := keepNewNotes("# Memory\n", before, before); strings.Contains(got, "old") {
		t.Errorf("a superseded note came back: %q", got)
	}
}

func TestRemember(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	line, err := e.s.Remember("  The user   prefers squash merges ")
	if err != nil || line != "- 2026-10-20: The user prefers squash merges" {
		t.Fatalf("Remember = %q, %v", line, err)
	}
	b, err := os.ReadFile(filepath.Join(e.dir, memoryFile))
	if err != nil || !strings.Contains(string(b), "## Notes\n\n"+line+"\n") || !strings.HasPrefix(string(b), "# Memory") {
		t.Errorf("MEMORY.md = %q, %v", b, err)
	}
	for _, bad := range []string{"", "   ", strings.Repeat("x", maxFact+1)} {
		if _, err := e.s.Remember(bad); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("Remember(%d bytes) err = %v", len(bad), err)
		}
	}
	_ = time.Now
}
