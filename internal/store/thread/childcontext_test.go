package thread

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/paths"
)

func TestAllowedTools(t *testing.T) {
	protocol := []string{
		"Bash(code-foundry thread report:*)",
		"Bash(code-foundry thread reports:*)",
		"Bash(code-foundry thread get:*)",
		"Bash(code-foundry thread list:*)",
		"Bash(code-foundry thread read:*)",
		"Bash(code-foundry project list:*)",
	}
	tests := []struct {
		name    string
		granted []string
		want    []string
	}{
		{"a fresh spawn", nil, protocol},
		{"an effort restart's grants after them", []string{"Bash(mkdir -p sub)", "Edit"}, append(slices.Clone(protocol), "Bash(mkdir -p sub)", "Edit")},
		{"a grant that repeats one", []string{"Bash(code-foundry thread list:*)", "Edit"}, append(slices.Clone(protocol), "Edit")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := allowedTools(tt.granted); !slices.Equal(got, tt.want) {
				t.Errorf("allowedTools = %q\nwant %q", got, tt.want)
			}
		})
	}
	// The package list is not changed by a merge.
	if !slices.Equal(ProtocolAllowedTools, protocol) {
		t.Errorf("ProtocolAllowedTools = %q", ProtocolAllowedTools)
	}
}

func TestThreadTmp(t *testing.T) {
	tests := []struct {
		name, root, id, want string
	}{
		{"under the root", "/Users/a/.code-foundry/tmp", "s-1a2b3c", "/Users/a/.code-foundry/tmp/s-1a2b3c"},
		{"no root", "", "s-1a2b3c", ""},
		{"no id", "/x/tmp", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := threadTmp(tt.root, tt.id); got != tt.want {
				t.Errorf("threadTmp = %q, want %q", got, tt.want)
			}
		})
	}
}

// Every spawn gets the protocol rules and its own TMPDIR, made at spawn; removing the
// thread removes it, and New removes those of threads that are gone.
func TestSpawnChildContext(t *testing.T) {
	root := filepath.Join(t.TempDir(), "tmp")
	pagesRoot := filepath.Join(t.TempDir(), "pages")
	withRoot := func(o *Options) { o.TmpRoot, o.PagesRoot = root, pagesRoot }
	e := newEnv(t, withRoot)
	s := e.connected(CreateOptions{PermissionMode: PermissionSupervised})
	spec := e.spec(s.ID)
	i := slices.Index(spec.Argv, "--allowedTools")
	if i < 0 || !slices.Equal(spec.Argv[i+1:min(i+1+len(ProtocolAllowedTools), len(spec.Argv))], ProtocolAllowedTools) {
		t.Errorf("argv = %q, want the protocol rules", spec.Argv)
	}
	dir := filepath.Join(root, s.ID)
	if !slices.Contains(spec.Env, "TMPDIR="+dir) {
		t.Errorf("env = %q, want TMPDIR=%s", spec.Env, dir)
	}
	pages := filepath.Join(pagesRoot, s.ID)
	if !slices.Contains(spec.Env, paths.EnvPages+"="+pages) || !slices.Contains(addDirs(spec.Argv), pages) {
		t.Errorf("env = %q, argv = %q; want %s=%s and --add-dir for it", spec.Env, spec.Argv, paths.EnvPages, pages)
	}
	for _, d := range []string{dir, pages} {
		if fi, err := os.Stat(d); err != nil || !fi.IsDir() {
			t.Fatalf("%s not made: %v", d, err)
		}
		if err := os.WriteFile(filepath.Join(d, "bench.html"), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	kept := e.connected(CreateOptions{})
	if err := e.m.Remove(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	for _, d := range []string{dir, pages} {
		if _, err := os.Stat(d); !os.IsNotExist(err) {
			t.Errorf("%s after remove: %v", d, err)
		}
	}

	var strays []string
	for _, r := range []string{root, pagesRoot} {
		stray := filepath.Join(r, "s-gone")
		if err := os.MkdirAll(filepath.Join(stray, "prof"), 0o700); err != nil {
			t.Fatal(err)
		}
		strays = append(strays, stray)
	}
	e.restart(withRoot)
	for _, stray := range strays {
		if _, err := os.Stat(stray); !os.IsNotExist(err) {
			t.Errorf("a gone thread's %s after New: %v", stray, err)
		}
	}
	for _, r := range []string{root, pagesRoot} {
		if _, err := os.Stat(filepath.Join(r, kept.ID)); err != nil {
			t.Errorf("a thread's directory after New: %v", err)
		}
	}
}
