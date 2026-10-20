package ember

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/thread"
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
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence --output-format json --safe-mode --tools ",
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence --output-format json",
		"-p --model claude-opus-4-8[1m] --effort low --no-session-persistence --output-format json",
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

// A claude -p JSON result gives the answer and its usage; plain text is the answer.
func TestConsolidationResult(t *testing.T) {
	ok := `{"type":"result","subtype":"success","is_error":false,"result":"# Memory\n- a","total_cost_usd":0.1234,` +
		`"usage":{"input_tokens":5,"output_tokens":700,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},` +
		`"modelUsage":{"claude-opus-4-8":{"inputTokens":10,"outputTokens":800,"cacheReadInputTokens":15000,"cacheCreationInputTokens":2000,"costUSD":0.1234}}}`
	usageOnly := `{"type":"result","is_error":false,"result":"# M","total_cost_usd":0.01,` +
		`"usage":{"input_tokens":3,"output_tokens":4,"cache_read_input_tokens":5,"cache_creation_input_tokens":6}}`
	failed := `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"overloaded","total_cost_usd":0.002}`
	tests := []struct {
		name, out, answer, err string
		usage                  ConsolidationUsage
		ok                     bool
	}{
		{"plain text", "# Memory\n- a\n", "# Memory\n- a\n", "", ConsolidationUsage{}, false},
		{"another JSON", `{"type":"assistant"}`, `{"type":"assistant"}`, "", ConsolidationUsage{}, false},
		{"a result", ok, "# Memory\n- a", "", ConsolidationUsage{Calls: 1, InputTokens: 17010, OutputTokens: 800, CostUSD: 0.1234}, true},
		{"usage without modelUsage", usageOnly, "# M", "", ConsolidationUsage{Calls: 1, InputTokens: 14, OutputTokens: 4, CostUSD: 0.01}, true},
		{"an error result", failed, "", "overloaded", ConsolidationUsage{Calls: 1, CostUSD: 0.002}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			answer, u, ok, err := consolidationResult(tt.out)
			if answer != tt.answer || u != tt.usage || ok != tt.ok || (err == nil) != (tt.err == "") || (err != nil && !strings.Contains(err.Error(), tt.err)) {
				t.Errorf("consolidationResult = %q, %+v, %v, %v", answer, u, ok, err)
			}
		})
	}
}

// Each consolidation's usage is the status's last one and adds to its total, kept in
// state.json; a call that answers badly still counts (it was paid for).
func TestConsolidationUsageRecorded(t *testing.T) {
	t.Parallel()
	e := newEnv(t)
	e.set(on)
	r := e.resident()
	result := func(answer string, cost float64, out int64) string {
		b, _ := json.Marshal(map[string]any{"type": "result", "is_error": false, "result": answer, "total_cost_usd": cost,
			"modelUsage": map[string]any{"claude-opus-4-8": map[string]any{"inputTokens": 100, "outputTokens": out, "cacheReadInputTokens": 900}}})
		return string(b)
	}
	for i, answer := range []string{result("# Memory\n- one\n", 0.25, 300), result("no heading", 0.5, 200)} {
		e.advance(time.Minute)
		e.threads.PutItems(r.ID, thread.Item{ID: "u" + string(rune('1'+i)), Kind: thread.KindUserMessage, Text: "hi", CreatedAt: e.clock()})
		e.mu.Lock()
		e.answer = answer
		e.mu.Unlock()
		if _, err := e.s.Reseed(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	st := e.s.Snapshot().Status
	want := ConsolidationUsage{At: e.clock(), Calls: 1, InputTokens: 1000, OutputTokens: 200, CostUSD: 0.5}
	if st.LastConsolidationUsage != want {
		t.Errorf("last = %+v, want %+v", st.LastConsolidationUsage, want)
	}
	want = ConsolidationUsage{At: e.clock(), Calls: 2, InputTokens: 2000, OutputTokens: 500, CostUSD: 0.75}
	if st.ConsolidationUsageTotal != want {
		t.Errorf("total = %+v, want %+v", st.ConsolidationUsageTotal, want)
	}
	if p := loadState(slog.New(slog.DiscardHandler), e.dir); p.ConsolidationUsageTotal != want || p.LastConsolidationUsage == nil {
		t.Errorf("state.json = %+v", p)
	}
	if b, _ := os.ReadFile(filepath.Join(e.dir, memoryFile)); string(b) != "# Memory\n- one\n" {
		t.Errorf("MEMORY.md = %q", b)
	}
}
