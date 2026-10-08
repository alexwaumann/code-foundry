package scripts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// nextVersion runs next-version.sh with args in dir and returns its trimmed stdout.
func nextVersion(t *testing.T, dir string, args ...string) (string, error) {
	t.Helper()
	script, err := filepath.Abs("next-version.sh")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", append([]string{script}, args...)...)
	cmd.Dir = dir
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func TestNextVersionRules(t *testing.T) {
	const rs = "\x1e\n"
	tests := []struct {
		name    string
		lastTag string
		commits []string
		want    string
	}{
		{"no commits", "v0.3.1", nil, ""},
		{"fix", "v0.3.1", []string{"fix: handle nil\n"}, "v0.3.2"},
		{"chore, docs, refactor are patches", "v0.3.1", []string{"chore: deps\n", "docs: notes\n", "refactor(api): split\n"}, "v0.3.2"},
		{"non-conventional is a patch", "v0.3.1", []string{"Update README\n"}, "v0.3.2"},
		{"feat is minor", "v0.3.1", []string{"fix: a\n", "feat: b\n"}, "v0.4.0"},
		{"feat with scope", "v0.3.1", []string{"feat(gui): footer\n\nlong body\n"}, "v0.4.0"},
		{"bang is major", "v0.3.1", []string{"feat!: drop v0 api\n"}, "v1.0.0"},
		{"bang with scope", "v1.2.3", []string{"fix(proto)!: rename\n"}, "v2.0.0"},
		{"BREAKING CHANGE footer", "v1.2.3", []string{"refactor: x\n\nBREAKING CHANGE: the socket moved\n"}, "v2.0.0"},
		{"BREAKING-CHANGE footer", "v1.2.3", []string{"chore: x\n\nBREAKING-CHANGE: y\n"}, "v2.0.0"},
		{"breaking text mid-line is not a footer", "v1.2.3", []string{"fix: mention BREAKING CHANGE: in text\n"}, "v1.2.4"},
		{"feature in body only is not feat", "v1.2.3", []string{"fix: x\n\nfeat: not a subject\n"}, "v1.2.4"},
		{"no tag yet", "", []string{"fix: a\n", "feat!: b\n"}, "v0.1.0"},
		{"no tag, no commits", "", nil, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := filepath.Join(t.TempDir(), "log")
			var b strings.Builder
			for _, c := range tt.commits {
				b.WriteString(c + rs)
			}
			if err := os.WriteFile(log, []byte(b.String()), 0o644); err != nil {
				t.Fatal(err)
			}
			got, err := nextVersion(t, ".", "--last-tag", tt.lastTag, "--log", log)
			if err != nil {
				t.Fatal(err)
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNextVersionFromGit(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commit := func(msg string) { git("commit", "-q", "--allow-empty", "-m", msg) }
	expect := func(want string) {
		t.Helper()
		got, err := nextVersion(t, dir)
		if err != nil || got != want {
			t.Fatalf("next-version = %q, %v; want %q", got, err, want)
		}
	}
	git("init", "-q", "-b", "main")
	commit("chore: init")
	expect("v0.1.0")
	git("tag", "v0.1.0")
	expect("") // nothing since the tag
	commit("fix: one")
	expect("v0.1.1")
	commit("feat: two")
	expect("v0.2.0")
	git("tag", "v0.2.0")
	git("tag", "v0.3.0-rc.1") // pre-release tags are not release tags
	git("tag", "nightly")
	commit("docs: three")
	expect("v0.2.1")
	// Version order, not tag age: a later-created lower tag does not win.
	git("tag", "v0.1.5")
	expect("v0.2.1")
	// A merge commit itself does not count; the merged commits do.
	git("checkout", "-q", "-b", "side")
	commit("feat!: big")
	git("checkout", "-q", "main")
	git("merge", "-q", "--no-ff", "-m", "Merge branch side", "side")
	expect("v1.0.0")
}
