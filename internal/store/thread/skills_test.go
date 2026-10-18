package thread

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The skills dir is every spawn's first --add-dir, before the attachments dir: the
// first spawn and an effort restart alike. New creates it.
func TestSkillsDirFirstAddDir(t *testing.T) {
	skills, att := filepath.Join(t.TempDir(), "claude"), filepath.Join(t.TempDir(), "attachments")
	re := newFixtureEnv(t, "text-table", func(o *Options) { o.SkillsDir, o.AttachmentsDir = skills, att })
	if fi, err := os.Stat(skills); err != nil || !fi.IsDir() {
		t.Fatalf("skills dir not created: %v", err)
	}
	s := re.create(CreateOptions{Effort: "low", PermissionMode: PermissionSupervised})
	re.waitFor(s.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	want := []string{skills, att}
	if got := addDirs(re.argvOf()); !slices.Equal(got, want) {
		t.Errorf("first spawn --add-dir = %q, want %q", got, want)
	}
	if _, err := re.m.SetEffort(re.ctx(), s.ID, "high"); err != nil {
		t.Fatal(err)
	}
	argv := re.waitArgv("the restart", func(a []string) bool { return argOf(a, "--effort") == "high" })
	if got := addDirs(argv); !slices.Equal(got, want) {
		t.Errorf("effort restart --add-dir = %q, want %q", got, want)
	}

	// Without a skills dir nothing is added for it.
	off := newFixtureEnv(t, "text-table", func(o *Options) { o.AttachmentsDir = att })
	p := off.create(CreateOptions{})
	off.waitFor(p.ID, "idle", func(s Thread) bool { return s.Status == StatusIdle })
	if got := addDirs(off.argvOf()); !slices.Equal(got, []string{att}) {
		t.Errorf("no skills dir: --add-dir = %q", got)
	}
}
