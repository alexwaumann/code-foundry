package main

import (
	"encoding/json"
	"strings"
	"testing"
)

// daemon.capabilities against a real daemon: the index names every group, and
// --group memory reads the memory the CLI just wrote.
func TestCLICapabilities(t *testing.T) {
	c := startTestDaemon(t)

	r := runCLI(c, "daemon", "capabilities")
	if r.err != nil {
		t.Fatalf("daemon capabilities: %v %s", r.err, r.stderr)
	}
	lines := strings.Split(strings.TrimSuffix(r.stdout, "\n"), "\n")
	if len(lines) > 15 || !strings.HasPrefix(lines[0], "Code Foundry test") {
		t.Errorf("index:\n%s", r.stdout)
	}
	for _, g := range []string{"build", "commands", "pages", "panel", "rendering", "skills", "plugins", "settings", "memory", "presence"} {
		if !strings.Contains(r.stdout, "\n"+g+" ") {
			t.Errorf("index lacks the %s group:\n%s", g, r.stdout)
		}
	}
	if strings.Contains(r.stdout, "unavailable") {
		t.Errorf("a group is unavailable on a real daemon:\n%s", r.stdout)
	}

	var idx struct {
		Groups []struct {
			Name  string `json:"name"`
			Count *int   `json:"count"`
		} `json:"groups"`
	}
	if r := runCLI(c, "daemon.capabilities", "--json"); r.err != nil || json.Unmarshal([]byte(r.stdout), &idx) != nil || len(idx.Groups) != 10 {
		t.Fatalf("--json = %v %q", r.err, r.stdout)
	}
	// The shipped skills, the entry skill first.
	if r := runCLI(c, "daemon", "capabilities", "--group", "skills"); r.err != nil ||
		!strings.Contains(r.stdout, "\n  code-foundry  ") || !strings.Contains(r.stdout, "/claude/.claude/skills/code-foundry/SKILL.md") {
		t.Errorf("--group skills = %v %q", r.err, r.stdout)
	}

	if r := runCLI(c, "memory", "add", "Always open PRs as drafts"); r.err != nil {
		t.Fatalf("memory add: %v %s", r.err, r.stderr)
	}
	r = runCLI(c, "daemon", "capabilities", "--group", "memory")
	if r.err != nil || !strings.HasPrefix(r.stdout, "memory: 1 standing preferences remembered.") || !strings.Contains(r.stdout, "  memory.add ") {
		t.Errorf("--group memory = %v %q", r.err, r.stdout)
	}
	r = runCLI(c, "daemon", "capabilities", "--group", "memory", "--json")
	var mem struct {
		Count    int `json:"count"`
		Commands []struct {
			Name string `json:"name"`
		} `json:"commands"`
	}
	if r.err != nil || json.Unmarshal([]byte(r.stdout), &mem) != nil || mem.Count != 1 || len(mem.Commands) != 4 {
		t.Errorf("--group memory --json = %v %q", r.err, r.stdout)
	}
	if r := runCLI(c, "daemon", "capabilities", "--group", "nope"); r.err == nil || !strings.Contains(r.stderr, "build") {
		t.Errorf("--group nope = %v %q", r.err, r.stderr)
	}
}
