package pluginscaffold_test

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/pluginscaffold"
	"github.com/alexwaumann/code-foundry/plugins"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func template(t *testing.T) fs.FS {
	t.Helper()
	sub, err := fs.Sub(plugins.Minimal, plugins.MinimalRoot)
	if err != nil {
		t.Fatal(err)
	}
	return sub
}

// tempHome is a temporary folder with its symlinks resolved, as the daemon's home is.
func tempHome(t *testing.T) string {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return home
}

func TestNameAndTarget(t *testing.T) {
	home := tempHome(t)
	busy := filepath.Join(home, "busy")
	if err := os.MkdirAll(filepath.Join(busy, pluginscaffold.DirPrefix+"taken"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(busy, pluginscaffold.DirPrefix+"taken", "x"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(busy, pluginscaffold.DirPrefix+"empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	link := filepath.Join(home, "out")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name, plugin, parent, owner string
		wantErr                     string // "" succeeds
	}{
		{"plain", "hello", home, "", ""},
		{"hyphenated", "pr-board", home, "octo", ""},
		{"reserved", "new", home, "", "is reserved"},
		{"reserved list", "logs", home, "", "is reserved"},
		{"uppercase", "Upper", home, "", "must match"},
		{"digit first", "2fa", home, "", "cannot carry commands or surfaces"},
		{"double hyphen", "a--b", home, "", "cannot carry commands or surfaces"},
		{"trailing hyphen", "ab-", home, "", "cannot carry commands or surfaces"},
		{"empty", "", home, "", "must match"},
		{"bad owner", "hello2", home, "oc/to", "owner"},
		{"relative", "hello3", "rel", "", "not an absolute path"},
		{"exists, not empty", "taken", busy, "", "is not empty"},
		{"exists, empty", "empty", busy, "", ""},
		{"missing parents", "deep", filepath.Join(home, "a", "b"), "", ""},
		{"outside home", "away", outside, "", "outside your home directory"},
		{"symlink out of home", "away2", link, "", "outside your home directory"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := pluginscaffold.Scaffold(context.Background(), pluginscaffold.Request{
				Template: template(t), Name: tt.plugin, Parent: tt.parent, Owner: tt.owner, Pin: "main", Home: home,
			})
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) || !errors.Is(err, pluginscaffold.ErrInvalid) {
					t.Fatalf("err = %v, want ErrInvalid with %q", err, tt.wantErr)
				}
				if tt.plugin != "taken" && tt.plugin != "" {
					if _, err := os.Stat(filepath.Join(tt.parent, pluginscaffold.DirPrefix+tt.plugin)); !errors.Is(err, fs.ErrNotExist) {
						t.Errorf("a refused request left %s/%s: %v", tt.parent, pluginscaffold.DirPrefix+tt.plugin, err)
					}
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if want := filepath.Join(tt.parent, pluginscaffold.DirPrefix+tt.plugin); res.Dir != want {
				t.Errorf("dir %s, want %s", res.Dir, want)
			}
			if want := pluginscaffold.Module(tt.plugin, tt.owner); res.Module != want {
				t.Errorf("module %s, want %s", res.Module, want)
			}
		})
	}
}

func TestModuleAndTitle(t *testing.T) {
	if got := pluginscaffold.Module("pr-board", "octo"); got != "github.com/octo/code-foundry-plugin-pr-board" {
		t.Errorf("Module = %s", got)
	}
	if got := pluginscaffold.Module("pr-board", ""); got != "code-foundry-plugin-pr-board" {
		t.Errorf("bare Module = %s", got)
	}
	for in, want := range map[string]string{"hello": "Hello", "pr-board": "Pr Board", "a1-b2-c": "A1 B2 C"} {
		if got := pluginscaffold.Title(in); got != want {
			t.Errorf("Title(%q) = %q, want %q", in, got, want)
		}
	}
}

// Every template file is written with the name in place of minimal, and plugin.json is
// a valid manifest of that name.
func TestFilesRenamed(t *testing.T) {
	home := tempHome(t)
	res, err := pluginscaffold.Scaffold(context.Background(), pluginscaffold.Request{
		Template: template(t), Name: "pr-board", Parent: home, Pin: "main", Home: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	var want []string
	_ = fs.WalkDir(template(t), ".", func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			want = append(want, p)
		}
		return err
	})
	if !slices.Equal(res.Files, want) {
		t.Errorf("files %v, want %v", res.Files, want)
	}
	for _, f := range []string{".gitignore", ".github/workflows/ci.yml", ".github/workflows/release.yml"} {
		if !slices.Contains(res.Files, f) {
			t.Errorf("%s not written", f)
		}
	}
	for _, p := range res.Files {
		b, err := os.ReadFile(filepath.Join(res.Dir, p))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(string(b)), "minimal") {
			t.Errorf("%s still says minimal", p)
		}
	}
	b, err := os.ReadFile(filepath.Join(res.Dir, pluginsdk.ManifestFile))
	if err != nil {
		t.Fatal(err)
	}
	m, warnings, err := pluginsdk.LoadManifest(b)
	if err != nil || len(warnings) > 0 {
		t.Fatalf("plugin.json: %v %v", err, warnings)
	}
	if m.Name != "pr-board" || m.DisplayName != "Pr Board" || m.Exec[0] != "bin/pr-board" {
		t.Errorf("manifest %+v", m)
	}
}

// The go step gets the three commands in the folder; a failure keeps the files, drops
// what it made of the module and lists the commands to finish by hand.
func TestGoStep(t *testing.T) {
	tests := []struct {
		name    string
		fail    bool
		wantErr string
	}{
		{"ok", false, ""},
		{"fails", true, "exit status 1: go: no network"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := tempHome(t)
			var gotDir, gotScript string
			goStep := func(_ context.Context, dir, script string) ([]byte, error) {
				gotDir, gotScript = dir, script
				if err := os.WriteFile(filepath.Join(dir, "go.mod"), []byte("module x\n"), 0o644); err != nil {
					t.Fatal(err)
				}
				if tt.fail {
					return []byte("go: no network\n"), errors.New("exit status 1")
				}
				return nil, nil
			}
			res, err := pluginscaffold.Scaffold(context.Background(), pluginscaffold.Request{
				Template: template(t), Name: "hello", Parent: home, Owner: "octo", Pin: "v0.4.0", Home: home, Go: goStep,
			})
			if err != nil {
				t.Fatal(err)
			}
			cmds := pluginscaffold.GoCommands("github.com/octo/code-foundry-plugin-hello", "v0.4.0")
			if gotDir != res.Dir || gotScript != strings.Join(cmds, " && ") {
				t.Errorf("go step ran %q in %s", gotScript, gotDir)
			}
			if want := "go get github.com/alexwaumann/code-foundry/pluginsdk@v0.4.0"; cmds[1] != want {
				t.Errorf("go get = %q, want %q", cmds[1], want)
			}
			if res.GoError != tt.wantErr {
				t.Errorf("GoError = %q, want %q", res.GoError, tt.wantErr)
			}
			if _, err := os.Stat(filepath.Join(res.Dir, "main.go")); err != nil {
				t.Errorf("main.go: %v", err)
			}
			_, modErr := os.Stat(filepath.Join(res.Dir, "go.mod"))
			if tt.fail {
				if !slices.Equal(res.Finish, cmds) {
					t.Errorf("Finish = %v, want %v", res.Finish, cmds)
				}
				if !errors.Is(modErr, fs.ErrNotExist) {
					t.Errorf("go.mod kept after a failed go step: %v", modErr)
				}
			} else if res.Finish != nil || modErr != nil {
				t.Errorf("Finish = %v, go.mod: %v", res.Finish, modErr)
			}
		})
	}
}

// A scaffolded plugin builds and passes its tests against this checkout's SDK.
func TestScaffoldBuilds(t *testing.T) {
	if testing.Short() {
		t.Skip("builds and tests a scaffolded plugin")
	}
	_, self, _, _ := runtime.Caller(0)
	sdk := filepath.Join(filepath.Dir(self), "..", "..", "pluginsdk")
	home := tempHome(t)
	goStep := func(ctx context.Context, dir, _ string) ([]byte, error) {
		// The real step fetches the SDK; here it is this checkout's.
		script := "go mod init github.com/octo/code-foundry-plugin-pr-board && " +
			"go mod edit -require " + pluginscaffold.SDKModule + "@v0.0.0 -replace " + pluginscaffold.SDKModule + "=" + sdk + " && " +
			"go mod tidy && go build ./... && go test ./..."
		cmd := exec.CommandContext(ctx, "sh", "-c", script)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GOFLAGS=-mod=mod", "GOWORK=off")
		return cmd.CombinedOutput()
	}
	res, err := pluginscaffold.Scaffold(context.Background(), pluginscaffold.Request{
		Template: template(t), Name: "pr-board", Parent: home, Owner: "octo", Pin: "main", Home: home, Go: goStep,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.GoError != "" {
		t.Fatal(res.GoError)
	}
}
