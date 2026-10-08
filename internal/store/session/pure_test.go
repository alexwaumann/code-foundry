package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// Screens captured from Claude Code 2.1.294 through terminal.Store.ScreenText (120x40).
const (
	trustScreenNo = `
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/cf2a-trust1

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ No, exit
   Yes, I trust this folder

 Enter to confirm · Esc to cancel`
	trustScreenYes = `
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
 Accessing workspace:

 /private/tmp/cf2a-trust1

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

   No, exit
 ❯ Yes, I trust this folder

 Enter to confirm · Esc to cancel`
	promptScreen = ` ▐▛███▛█   Claude Code v2.1.294
▝▜██████▀  Opus 5.5 with low effort · Claude Max
 ▝▝   ▝▝   /private/tmp/cf2a-trust2
                                                                                                       ○ low · /effort
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "how do I log an error?"
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  /private/tmp/cf2a-trust2
  Opus 5.5 (low) · 0 tokens
  -- INSERT -- ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents`
	// A conversation that merely quotes the option text is not the dialog.
	quotedScreen = `❯ what does "Yes, I trust this folder" do?
⏺ It accepts the dialog.`
)

func TestParseTrustDialog(t *testing.T) {
	tests := []struct {
		name   string
		screen string
		want   trustDialog
	}{
		{"default selection is No", trustScreenNo, trustDialog{Visible: true}},
		{"Yes selected after Down", trustScreenYes, trustDialog{Visible: true, YesSelected: true}},
		{"Claude prompt", promptScreen, trustDialog{}},
		{"empty", "", trustDialog{}},
		{"quoted in conversation", quotedScreen, trustDialog{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseTrustDialog(tt.screen); got != tt.want {
				t.Errorf("parseTrustDialog = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestPromptReady(t *testing.T) {
	tests := map[string]bool{
		promptScreen:   true,
		trustScreenNo:  false,
		trustScreenYes: false,
		"":             false,
		" ▐▛███▛█   Claude Code v2.1.294\n\n": false,
		"⏺ pong\n────\n❯ \n────":              true,
	}
	for screen, want := range tests {
		if got := promptReady(screen); got != want {
			t.Errorf("promptReady(%q) = %v, want %v", screen, got, want)
		}
	}
}

func TestSetTrusted(t *testing.T) {
	tests := []struct {
		name        string
		in          string
		wantChanged bool
		wantEntry   map[string]any
	}{
		{"empty object", `{}`, true, map[string]any{"hasTrustDialogAccepted": true}},
		{"null projects", `{"projects":null}`, true, map[string]any{"hasTrustDialogAccepted": true}},
		{"other projects kept", `{"projects":{"/other":{"hasTrustDialogAccepted":false}}}`, true, map[string]any{"hasTrustDialogAccepted": true}},
		{"existing entry merged", `{"projects":{"/w":{"allowedTools":["Bash"],"hasTrustDialogAccepted":false,"lastCost":1.25}}}`, true,
			map[string]any{"allowedTools": []any{"Bash"}, "hasTrustDialogAccepted": true, "lastCost": 1.25}},
		{"already trusted", `{"projects":{"/w":{"hasTrustDialogAccepted":true}}}`, false, map[string]any{"hasTrustDialogAccepted": true}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, changed, err := setTrusted([]byte(tt.in), "/w")
			if err != nil {
				t.Fatal(err)
			}
			if changed != tt.wantChanged {
				t.Errorf("changed = %v, want %v", changed, tt.wantChanged)
			}
			var doc struct {
				Projects map[string]map[string]any `json:"projects"`
			}
			if err := json.Unmarshal(out, &doc); err != nil {
				t.Fatalf("output is not JSON: %v\n%s", err, out)
			}
			got, _ := json.Marshal(doc.Projects["/w"])
			want, _ := json.Marshal(tt.wantEntry)
			if string(got) != string(want) {
				t.Errorf("entry = %s, want %s", got, want)
			}
			if strings.Contains(tt.in, "/other") && doc.Projects["/other"] == nil {
				t.Error("other project entry lost")
			}
		})
	}
	if _, _, err := setTrusted([]byte(`not json`), "/w"); err == nil {
		t.Error("setTrusted accepted invalid JSON")
	}
}

func TestSetTrustedPreservesUnrelatedValues(t *testing.T) {
	in := `{"numStartups": 12, "tips": "<b>&amp;</b>", "big": 12345678901234567890, "projects": {}}`
	out, _, err := setTrusted([]byte(in), "/w")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"numStartups": 12`, `"tips": "<b>&amp;</b>"`, `"big": 12345678901234567890`} {
		if !strings.Contains(string(out), want) {
			t.Errorf("output lost %s:\n%s", want, out)
		}
	}
}

func TestTrustWorktreeFile(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "claude.json")
	if err := os.WriteFile(cfg, []byte(`{"projects":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	wt := filepath.Join(dir, "wt")
	if err := os.Mkdir(wt, 0o755); err != nil {
		t.Fatal(err)
	}
	changed, err := trustWorktree(cfg, wt)
	if err != nil || !changed {
		t.Fatalf("trustWorktree = %v, %v", changed, err)
	}
	if changed, err := trustWorktree(cfg, wt); err != nil || changed {
		t.Fatalf("second trustWorktree = %v, %v; want unchanged", changed, err)
	}
	data, _ := os.ReadFile(cfg)
	if !strings.Contains(string(data), realPath(wt)) {
		t.Errorf("config does not key the real path %s:\n%s", realPath(wt), data)
	}
	if fi, _ := os.Stat(cfg); fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
	if _, err := os.Stat(cfg + ".lock"); !os.IsNotExist(err) {
		t.Errorf("lock dir left behind: %v", err)
	}
	// A stale lock (older than 10s) is taken over; a fresh one blocks until timeout.
	if err := os.Mkdir(cfg+".lock", 0o700); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(cfg+".lock", old, old); err != nil {
		t.Fatal(err)
	}
	if _, err := trustWorktree(cfg, filepath.Join(dir, "other")); err != nil {
		t.Errorf("stale lock not taken over: %v", err)
	}
}

func TestProjectSlug(t *testing.T) {
	tests := map[string]string{
		"/Users/alex/projects/code-foundry": "-Users-alex-projects-code-foundry",
		"/Users/alex/.t3/projects/sat-prep": "-Users-alex--t3-projects-sat-prep",
		"/private/tmp/cf2a_slug test.v2":    "-private-tmp-cf2a-slug-test-v2",
	}
	for in, want := range tests {
		if got := projectSlug(in); got != want {
			t.Errorf("projectSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestLaunchArgv(t *testing.T) {
	tests := []struct {
		name   string
		l      launch
		model  string
		effort string
		want   string
		id     string
	}{
		{"new", launch{newID: "N"}, "opus", "high", "claude --session-id N --model opus --effort high", "N"},
		{"new defaults", launch{newID: "N"}, "", "", "claude --session-id N", "N"},
		{"resume", launch{resume: "R"}, "opus", "", "claude --resume R --model opus", "R"},
		{"resume ignores newID", launch{resume: "R", newID: "N"}, "", "low", "claude --resume R --effort low", "R"},
		{"fork", launch{resume: "R", fork: true, newID: "N"}, "sonnet", "max", "claude --resume R --fork-session --session-id N --model sonnet --effort max", "N"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := strings.Join(tt.l.argv("claude", tt.model, tt.effort), " "); got != tt.want {
				t.Errorf("argv = %q, want %q", got, tt.want)
			}
			if got := tt.l.claudeID(); got != tt.id {
				t.Errorf("claudeID = %q, want %q", got, tt.id)
			}
		})
	}
}

func TestValidateModelEffort(t *testing.T) {
	tests := []struct {
		model, effort string
		ok            bool
	}{
		{"", "", true},
		{"opus", "high", true},
		{"claude-opus-5-5[1m]", "xhigh", true},
		{"--dangerously-skip-permissions", "", false},
		{"opus fable", "", false},
		{"opus", "extreme", false},
	}
	for _, tt := range tests {
		if err := validateModelEffort(tt.model, tt.effort); (err == nil) != tt.ok {
			t.Errorf("validateModelEffort(%q, %q) = %v, want ok=%v", tt.model, tt.effort, err, tt.ok)
		}
	}
}

func TestSlugify(t *testing.T) {
	tests := map[string]string{
		"pong-reply-request":                 "pong-reply-request",
		"  Fix Login Bug \n":                 "fix-login-bug",
		"`add-dark-mode-toggle`":             "add-dark-mode-toggle",
		"\n\nRefactor the API client layer!": "refactor-the-api-client-layer",
		"one two three four five six seven":  "one-two-three-four-five",
		"":                                   "",
		"!!!":                                "",
	}
	for in, want := range tests {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestFirstUserText(t *testing.T) {
	tests := []struct {
		name string
		line string
		want string
		ok   bool
	}{
		{"string content", `{"type":"user","message":{"role":"user","content":"reply with the single word pong"}}`, "reply with the single word pong", true},
		{"text blocks", `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix the bug"}]}}`, "fix the bug", true},
		{"tool result", `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]}}`, "", false},
		{"meta", `{"type":"user","isMeta":true,"message":{"role":"user","content":"x"}}`, "", false},
		{"sidechain", `{"type":"user","isSidechain":true,"message":{"role":"user","content":"x"}}`, "", false},
		{"slash command", `{"type":"user","message":{"role":"user","content":"<command-name>/model</command-name>"}}`, "", false},
		{"assistant", `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"pong"}]}}`, "", false},
		{"mode line", `{"type":"mode","mode":"normal"}`, "", false},
		{"garbage", `{`, "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := firstUserText([]byte(tt.line))
			if got != tt.want || ok != tt.ok {
				t.Errorf("firstUserText = %q, %v; want %q, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}

func TestTailerSplitsLinesAcrossReads(t *testing.T) {
	dir := t.TempDir()
	paths := ClaudePaths{Dir: filepath.Join(dir, "claude")}
	cwd := filepath.Join(dir, "wt")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	tl := newTailer(paths, cwd)
	defer tl.close()
	tl.follow("abc", false)
	if lines, found := tl.poll(); found || len(lines) != 0 {
		t.Fatalf("poll before file exists = %v, %v", lines, found)
	}
	pdir := paths.projectDir(cwd)
	if err := os.MkdirAll(pdir, 0o755); err != nil {
		t.Fatal(err)
	}
	f, err := os.Create(filepath.Join(pdir, "abc.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	_, _ = f.WriteString("{\"a\":1}\n{\"b\":")
	lines, found := tl.poll()
	if !found || len(lines) != 1 || string(lines[0]) != `{"a":1}` {
		t.Fatalf("poll = %q, %v", lines, found)
	}
	_, _ = f.WriteString("2}\n\n{\"c\":3}\n")
	lines, found = tl.poll()
	got := []string{}
	for _, l := range lines {
		got = append(got, string(l))
	}
	if found || !slices.Equal(got, []string{`{"b":2}`, `{"c":3}`}) {
		t.Fatalf("poll = %q, %v", got, found)
	}
	// Resuming starts at the end: existing lines are not replayed.
	tl2 := newTailer(paths, cwd)
	defer tl2.close()
	tl2.follow("abc", true)
	if lines, found := tl2.poll(); !found || len(lines) != 0 {
		t.Fatalf("fromEnd poll = %q, %v", lines, found)
	}
	_, _ = f.WriteString("{\"d\":4}\n")
	if lines, _ := tl2.poll(); len(lines) != 1 || string(lines[0]) != `{"d":4}` {
		t.Fatalf("fromEnd poll after append = %q", lines)
	}
}

func TestPidSessionID(t *testing.T) {
	dir := t.TempDir()
	paths := ClaudePaths{Dir: dir}
	if got := pidSessionID(paths, 42); got != "" {
		t.Errorf("missing file = %q", got)
	}
	_ = os.MkdirAll(filepath.Join(dir, "sessions"), 0o755)
	_ = os.WriteFile(paths.pidFile(42), []byte(`{"pid":42,"sessionId":"s1","cwd":"/x"}`), 0o644)
	if got := pidSessionID(paths, 42); got != "s1" {
		t.Errorf("pidSessionID = %q, want s1", got)
	}
	_ = os.WriteFile(paths.pidFile(43), []byte(`{"pid":7,"sessionId":"s1"}`), 0o644)
	if got := pidSessionID(paths, 43); got != "" {
		t.Errorf("mismatched pid = %q", got)
	}
}
