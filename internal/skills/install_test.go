package skills

import (
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// tree lists every file under dir (slash paths relative to it) with its content.
func tree(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		rel, _ := filepath.Rel(dir, p)
		out[filepath.ToSlash(rel)] = string(b)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestInstall(t *testing.T) {
	v1 := Files{"a/SKILL.md": []byte("a1"), "a/reference/x.md": []byte("x1"), "b/SKILL.md": []byte("b1")}
	tests := []struct {
		name string
		// before is written into dir before Install (relative paths, content).
		before  map[string]string
		version string
		files   Files
		want    map[string]string
	}{
		{
			name: "fresh", version: "v1.0.0", files: v1,
			want: map[string]string{
				".claude/skills/a/SKILL.md": "a1", ".claude/skills/a/reference/x.md": "x1", ".claude/skills/b/SKILL.md": "b1",
				"VERSION": "v1.0.0\n",
			},
		},
		{
			name: "rewrite drops a skill and a file no longer shipped",
			before: map[string]string{
				".claude/skills/a/SKILL.md": "old", ".claude/skills/a/reference/gone.md": "gone",
				".claude/skills/old-skill/SKILL.md": "old", ".claude/settings.json": "{}", "VERSION": "v0.9.0\n",
			},
			version: "v1.0.0", files: Files{"a/SKILL.md": []byte("a2")},
			want: map[string]string{".claude/skills/a/SKILL.md": "a2", "VERSION": "v1.0.0\n"},
		},
		{
			name: "leftovers of an interrupted install and an older layout go",
			before: map[string]string{
				".new-123/skills/a/SKILL.md": "half", ".new-456-old/skills/a/SKILL.md": "older",
				".new-version-789": "v0", "skills/a/SKILL.md": "older layout", "CLAUDE.md": "no",
			},
			version: "dev", files: Files{"b/SKILL.md": []byte("b1")},
			want: map[string]string{".claude/skills/b/SKILL.md": "b1", "VERSION": "dev\n"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "claude")
			for p, c := range tt.before {
				f := filepath.Join(dir, filepath.FromSlash(p))
				if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f, []byte(c), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := Install(dir, tt.version, tt.files); err != nil {
				t.Fatal(err)
			}
			got := tree(t, dir)
			if !maps.Equal(got, tt.want) {
				t.Errorf("tree = %q\nwant  %q", got, tt.want)
			}
			// Nothing but the two entries is left in dir.
			entries, _ := os.ReadDir(dir)
			var names []string
			for _, e := range entries {
				names = append(names, e.Name())
			}
			if !slices.Equal(names, []string{".claude", "VERSION"}) {
				t.Errorf("dir has %q", names)
			}
		})
	}
}

// A bad path is refused before anything is touched.
func TestInstallRefusesBadPaths(t *testing.T) {
	for _, p := range []string{"", "SKILL.md", "/abs/SKILL.md", "../x/SKILL.md", "a/../../x", "a//b", "a/./b"} {
		t.Run(p, func(t *testing.T) {
			dir := filepath.Join(t.TempDir(), "claude")
			if err := Install(dir, "v1", Files{"a/SKILL.md": []byte("a")}); err != nil {
				t.Fatal(err)
			}
			err := Install(dir, "v2", Files{p: []byte("x"), "b/SKILL.md": []byte("b")})
			if err == nil || !strings.Contains(err.Error(), "bad file path") {
				t.Fatalf("Install(%q) = %v", p, err)
			}
			if got := tree(t, dir); !maps.Equal(got, map[string]string{".claude/skills/a/SKILL.md": "a", "VERSION": "v1\n"}) {
				t.Errorf("tree after a refusal = %q", got)
			}
		})
	}
	if err := Install("", "v1", nil); err == nil {
		t.Error("Install with no dir succeeded")
	}
}
