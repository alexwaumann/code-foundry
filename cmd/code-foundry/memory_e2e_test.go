package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

// The memory.* verbs against a real daemon: the CLI goes through the daemon, which owns
// <home>/memory/.
func TestCLIMemory(t *testing.T) {
	c := startTestDaemon(t)
	r := runCLI(c, "daemon", "status", "--json")
	var status struct {
		Home string `json:"home"`
	}
	if err := json.Unmarshal([]byte(r.stdout), &status); err != nil || status.Home == "" {
		t.Fatalf("daemon status: %v %q", err, r.stdout)
	}
	dir := paths.New(status.Home).Memory()

	for _, tt := range []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string
		wantStderr string
	}{
		{"show empty", []string{"memory", "show"}, nil, "No preferences remembered", ""},
		{"show empty json", []string{"memory.show", "--json"}, nil, `{"entries":[]}`, ""},
		{"add positional", []string{"memory", "add", "Always open PRs as drafts"}, nil,
			`Remembered: "Always open PRs as drafts". New threads will follow it; threads already open get it on their next message after a restart.` + "\n", ""},
		{"several words", []string{"memory", "add", "Never", "open", "the", "side", "panel", "on", "your", "own."}, nil,
			`Remembered: "Never open the side panel on your own".`, ""},
		{"add a third", []string{"memory", "add", "Draft commit messages first", "--json"}, nil,
			`{"entry":{"index":3,"id":"draft-commit-messages-first","text":"Draft commit messages first","created":"20`, ""},
		{"add from the user's terminal records no thread", []string{"memory", "add", "Draft commit messages first", "--json"}, nil,
			`"thread_id":"","thread_name":"","injected":true,"left_out":""},"added":false}`, ""},
		{"duplicate", []string{"memory", "add", "always open prs as drafts"}, nil,
			`Already remembered: "Always open PRs as drafts" (nothing changed).` + "\n", ""},
		{"multi-line", []string{"memory", "add", "one\ntwo"}, errUsage, "", "one line"},
		{"missing text", []string{"memory", "add"}, errUsage, "", `missing required argument "text"`},
		{"show", []string{"memory", "show"}, nil,
			"1. Always open PRs as drafts\n2. Never open the side panel on your own\n3. Draft commit messages first\n", ""},
		{"show json", []string{"memory", "show", "--json"}, nil,
			`{"index":3,"id":"draft-commit-messages-first","text":"Draft commit messages first","created":"20`, ""},
		{"ambiguous", []string{"memory", "remove", "draft"}, errUsage, "", `"draft" is in 2 entries; give the number of one:`},
		{"no match", []string{"memory", "remove", "rebase"}, errUsage, "", `no entry contains "rebase"`},
		{"remove by substring", []string{"memory", "remove", "side", "panel"}, nil,
			`Forgot: "Never open the side panel on your own".` + "\n", ""},
		{"remove by an id that is gone", []string{"memory", "remove", "--id", "never-open-the-side-panel-on-your-own"}, errUsage, "",
			"there is no entry never-open-the-side-panel-on-your-own now"},
		{"no letter or digit", []string{"memory", "add", "*", "!!"}, errUsage, "", "an entry needs at least one letter or digit"},
		{"remove by id", []string{"memory", "remove", "--id", "draft-commit-messages-first"}, nil, `Forgot: "Draft commit messages first".`, ""},
		{"clear needs --yes", []string{"memory", "clear"}, errUsage, "", "Re-run with --yes to confirm."},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := runCLI(c, tt.args...)
			if !errors.Is(r.err, tt.wantErr) {
				t.Fatalf("err = %v, want %v\nstderr: %s", r.err, tt.wantErr, r.stderr)
			}
			if !strings.Contains(r.stdout, tt.wantStdout) {
				t.Errorf("stdout = %q, want containing %q", r.stdout, tt.wantStdout)
			}
			if !strings.Contains(r.stderr, tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", r.stderr, tt.wantStderr)
			}
		})
	}

	if b, err := os.ReadFile(filepath.Join(dir, "MEMORY.md")); err != nil || string(b) != "- [Always open PRs as drafts](always-open-prs-as-drafts.md)\n" {
		t.Errorf("index = %q, %v", b, err)
	}
	if b, err := os.ReadFile(filepath.Join(dir, "always-open-prs-as-drafts.md")); err != nil ||
		!strings.HasPrefix(string(b), "---\ncreated: ") || !strings.HasSuffix(string(b), "\n---\nAlways open PRs as drafts\n") {
		t.Errorf("entry file = %q, %v", b, err)
	}
	if r := runCLI(c, "memory", "clear", "--yes"); r.err != nil || r.stdout != "Forgot 1 preference.\n" {
		t.Errorf("clear --yes = %v %q %q", r.err, r.stdout, r.stderr)
	}
	if des, err := os.ReadDir(dir); err != nil || len(des) != 1 {
		t.Errorf("memory directory after clear: %v, %v", des, err)
	}
	// A full memory is a state, not a usage error: exit 1, its message, no pointer to help.
	for i := range 40 {
		if r := runCLI(c, "memory", "add", "preference", string(rune('a'+i%26)), string(rune('a'+i/26))); r.err != nil {
			t.Fatalf("add %d: %v %s", i, r.err, r.stderr)
		}
	}
	if r := runCLI(c, "memory", "add", "one too many"); r.err == nil || errors.Is(r.err, errUsage) ||
		!strings.Contains(r.stderr, "at most 40 entries") || strings.Contains(r.stderr, "for usage") {
		t.Errorf("41st add = %v, stderr %q", r.err, r.stderr)
	}
	if r := runCLI(c, "help", "memory", "remove"); !strings.Contains(r.stdout, "code-foundry memory.remove [<entry>] [flags]") {
		t.Errorf("help memory remove = %q", r.stdout)
	}
}
