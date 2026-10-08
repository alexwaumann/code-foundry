package update

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/awaumann/code-foundry/scripts"
)

func TestScriptInstaller(t *testing.T) {
	fake := []byte(`#!/bin/bash
echo "args: $*"
echo "repo: $CODE_FOUNDRY_RELEASE_REPO"
echo "dir: ${CODE_FOUNDRY_RELEASE_DIR:-none}"
echo ""
if [ "$FAIL" = 1 ]; then echo "error: checksum mismatch" >&2; exit 3; fi
echo "==> done"
`)
	tests := []struct {
		name     string
		fail     bool
		wantErr  string
		wantLine []string
	}{
		{
			name: "success",
			wantLine: []string{
				"args: --version v0.2.0 --yes --skip-path --app-dir /tmp/apps",
				"repo: owner/name",
				"dir: /tmp/rel",
				"==> done",
			},
		},
		{name: "failure carries the last lines", fail: true, wantErr: "exit status 3: repo: owner/name / dir: /tmp/rel / error: checksum mismatch"},
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
			err := i.Install(context.Background(), "v0.2.0", func(l string) { lines = append(lines, l) })
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
