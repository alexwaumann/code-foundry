package ember

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestValidMemory(t *testing.T) {
	tests := []struct {
		name, out, want, err string
	}{
		{"plain", "# Memory\n- a\n", "# Memory\n- a\n", ""},
		{"trimmed", "\n\n# Memory\n- a  \n\n", "# Memory\n- a\n", ""},
		{"in a fence", "```markdown\n# Memory\n- a\n```", "# Memory\n- a\n", ""},
		{"empty", "  ", "", "answered nothing"},
		{"a preamble", "Here it is:\n# Memory", "", "does not start"},
		{"too long", "# Memory\n" + strings.Repeat("x", maxMemory), "", "bytes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidMemory(tt.out)
			if got != tt.want || (err == nil) != (tt.err == "") || (err != nil && !strings.Contains(err.Error(), tt.err)) {
				t.Errorf("ValidMemory = %q, %v; want %q, %q", got, err, tt.want, tt.err)
			}
		})
	}
}

func TestConsolidationInput(t *testing.T) {
	msgs := []Message{{At: today, User: true, Text: "keep PRs small"}, {At: today.Add(time.Minute), Text: "Noted."}}
	changes := []Task{{ID: "t-00000001", Title: "Docs", State: StateDone, Outcome: "merged"}}
	got := ConsolidationInput("# Memory\n- tea", changes, msgs, today.Add(-time.Hour), utc)
	for _, w := range []string{
		"Output only the", "=== CURRENT MEMORY.md ===\n# Memory\n- tea\n", "=== TASK CHANGES since 2026-10-20 08:00 ===\n- t-00000001 [done] Docs — merged\n",
		"### 2026-10-20 09:00 · user\nkeep PRs small\n", "### 2026-10-20 09:01 · Ember\nNoted.\n", "=== end ===",
	} {
		if !strings.Contains(got, w) {
			t.Errorf("input lacks %q:\n%s", w, got)
		}
	}
	if got := ConsolidationInput("", nil, nil, time.Time{}, utc); !strings.Contains(got, "since the start ===\nNone.") {
		t.Errorf("empty input:\n%s", got)
	}
	var many []Message
	for i := range 400 {
		many = append(many, Message{At: today.Add(time.Duration(i) * time.Second), User: true, Text: strings.Repeat("m", 1500)})
	}
	big := ConsolidationInput("# Memory", nil, many, time.Time{}, utc)
	if len(big) > maxConsolidationInput || !strings.HasSuffix(big, "=== end ===\n") || !strings.Contains(big, "### 2026-10-20 09:06 · user") {
		t.Errorf("a big input: %d bytes", len(big))
	}
}

// ClaudeRunner runs claude with the hardened flags and the prompt on stdin, and falls
// back to the minimal flags for good when a flag is refused.
func TestClaudeRunner(t *testing.T) {
	dir := t.TempDir()
	argsLog := filepath.Join(dir, "args")
	script := filepath.Join(dir, "claude")
	body := `#!/bin/sh
echo "$@" >> "` + argsLog + `"
case "$*" in *--safe-mode*) echo "error: unknown option '--safe-mode'" >&2; exit 1;; esac
echo "# Memory"; cat
`
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	run := ClaudeRunner(script, dir, slog.New(slog.DiscardHandler))
	for range 2 {
		out, err := run(context.Background(), "claude-opus-4-8[1m]", "- from stdin")
		if err != nil || out != "# Memory\n- from stdin" {
			t.Fatalf("run = %q, %v", out, err)
		}
	}
	b, _ := os.ReadFile(argsLog)
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	want := []string{
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence --safe-mode --tools ",
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence",
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence",
	}
	if len(lines) != len(want) {
		t.Fatalf("calls = %q", lines)
	}
	for i := range want {
		if strings.TrimSpace(lines[i]) != strings.TrimSpace(want[i]) {
			t.Errorf("call %d = %q, want %q", i, lines[i], want[i])
		}
	}
}

func TestPruneConsolidations(t *testing.T) {
	e := newEnv(t)
	for i := range 7 {
		stamp := time.Date(2026, 10, 20, 10, i, 0, 0, utc).Format("20060102T150405Z")
		e.s.keepConsolidation(stamp+"-input.md", "in")
		e.s.keepConsolidation(stamp+"-output.md", "out")
	}
	e.s.pruneConsolidations()
	entries, _ := os.ReadDir(filepath.Join(e.dir, consolDir))
	if len(entries) != 2*keepConsolidations || entries[0].Name() != "20261020T100200Z-input.md" {
		t.Errorf("kept %d files, first %s", len(entries), entries[0].Name())
	}
}
