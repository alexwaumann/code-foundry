package update

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/scripts"
)

func TestScriptInstaller(t *testing.T) {
	fake := []byte(`#!/bin/bash
echo "args: $*"
echo "repo: $CODE_FOUNDRY_RELEASE_REPO"
echo "dir: ${CODE_FOUNDRY_RELEASE_DIR:-none}"
echo ""
if [ "$FAIL" = 1 ]; then echo "error: checksum mismatch" >&2; echo "failed: $*" >&2; exit 3; fi
echo "==> done"
`)
	tests := []struct {
		name     string
		run      func(i ScriptInstaller, progress func(string)) error
		fail     bool
		wantErr  string
		wantLine []string
	}{
		{
			name: "download stages only",
			run: func(i ScriptInstaller, p func(string)) error {
				return i.Download(context.Background(), "v0.2.0", p)
			},
			wantLine: []string{
				"args: --version v0.2.0 --stage-only --yes --skip-path --skip-link --app-dir /tmp/apps",
				"repo: owner/name",
				"dir: /tmp/rel",
				"==> done",
			},
		},
		{
			name: "full install passes no mode",
			run: func(i ScriptInstaller, p func(string)) error {
				return i.InstallFull(context.Background(), "v0.2.0", p)
			},
			wantLine: []string{
				"args: --version v0.2.0 --yes --skip-path --skip-link --app-dir /tmp/apps",
				"repo: owner/name",
				"dir: /tmp/rel",
				"==> done",
			},
		},
		{
			name: "download failure carries the last lines",
			run: func(i ScriptInstaller, p func(string)) error {
				return i.Download(context.Background(), "v0.2.0", p)
			},
			fail:    true,
			wantErr: "exit status 3: dir: /tmp/rel / error: checksum mismatch / failed: --version v0.2.0 --stage-only",
		},
		{
			name: "install applies the stage",
			run: func(i ScriptInstaller, _ func(string)) error {
				return i.Install(context.Background(), "v0.2.0")
			},
			fail:    true, // the error's last line carries the arguments
			wantErr: "failed: --version v0.2.0 --apply-staged --yes --skip-path --skip-link --app-dir /tmp/apps",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.fail {
				t.Setenv("FAIL", "1")
			} else {
				t.Setenv("FAIL", "0")
			}
			i := ScriptInstaller{Script: fake, Repo: "owner/name", ReleaseDir: "/tmp/rel", AppDir: "/tmp/apps", Gh: "/opt/homebrew/bin/gh"}
			var lines []string
			err := tt.run(i, func(l string) { lines = append(lines, l) })
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(lines, "\n") != strings.Join(tt.wantLine, "\n") {
				t.Fatalf("lines:\n%s\nwant:\n%s", strings.Join(lines, "\n"), strings.Join(tt.wantLine, "\n"))
			}
		})
	}
}

func TestEmbeddedInstallerParses(t *testing.T) {
	if len(scripts.InstallSh) == 0 {
		t.Fatal("installer not embedded")
	}
	f, err := os.CreateTemp(t.TempDir(), "install-*.sh")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.Write(scripts.InstallSh); err != nil {
		t.Fatal(err)
	}
	_ = f.Close()
	// macOS ships bash 3.2 at /bin/bash; the installer must parse with it.
	if out, err := exec.Command("/bin/bash", "-n", f.Name()).CombinedOutput(); err != nil {
		t.Fatalf("bash -n: %v\n%s", err, out)
	}
}
