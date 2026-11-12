package scripts

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// checkCommits runs check-commits.sh over subjects and returns its stderr and whether it
// passed.
func checkCommits(t *testing.T, subjects ...string) (string, bool) {
	t.Helper()
	script, err := filepath.Abs("check-commits.sh")
	if err != nil {
		t.Fatal(err)
	}
	log := filepath.Join(t.TempDir(), "log")
	if err := os.WriteFile(log, []byte(strings.Join(subjects, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", script, "--log", log)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	err = cmd.Run()
	return stderr.String(), err == nil
}

func TestCheckCommits(t *testing.T) {
	tests := []struct {
		subject string
		ok      bool
	}{
		{"feat(pages): a page can save a file", true},
		{"fix: handle nil", true},
		{"refactor(api)!: remove the unused RPCs", true},
		{"feat!: drop the old socket", true},
		{"build(e2e): one mock per worker", true},
		{"chore(plugin sdk): tag v0.5.1", true},
		{"revert: feat(gui): footer", true},
		{"Update README", false},
		{"Docs: the service lists without the removed RPCs", false},
		{"e2e: emit intents through a mock control endpoint", false},
		{"feature(gui): footer", false},
		{"feat(GUI): footer", false},
		{"feat(): footer", false},
		{"feat:footer", false},
		{"feat(gui) : footer", false},
		{"fix: " + strings.Repeat("x", 67), true},
		{"fix: " + strings.Repeat("x", 68), false},
	}
	for _, tt := range tests {
		t.Run(tt.subject, func(t *testing.T) {
			stderr, ok := checkCommits(t, tt.subject)
			if ok != tt.ok {
				t.Fatalf("passed = %v, want %v\n%s", ok, tt.ok, stderr)
			}
			if !ok && !strings.Contains(stderr, tt.subject) {
				t.Errorf("the refusal does not name the subject:\n%s", stderr)
			}
		})
	}
}

// One bad subject among good ones fails the branch and is the only one named.
func TestCheckCommitsNamesOnlyTheBadOnes(t *testing.T) {
	stderr, ok := checkCommits(t, "fix: a", "Update README", "feat(gui): b")
	if ok {
		t.Fatal("passed with a bad subject")
	}
	if !strings.Contains(stderr, "Update README") || strings.Contains(stderr, "fix: a\n") {
		t.Errorf("stderr = %s", stderr)
	}
	if _, ok := checkCommits(t); !ok {
		t.Error("no commits should pass")
	}
}
