package ripgrep_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/ripgrep"
	"github.com/alexwaumann/code-foundry/internal/ripgrep/ripgreptest"
)

func TestFind(t *testing.T) {
	type setup struct {
		exeDir, pathDir, other string
	}
	tests := []struct {
		name      string
		installed bool
		prepare   func(t *testing.T, s setup) (env string)
		want      func(s setup) ripgrep.Binary
		wantErr   string // substring; the error wraps ErrMissing
	}{
		{
			name: "bundled beside the executable",
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.exeDir, ripgrep.BinName, "", 0)
				ripgreptest.Fake(t, s.pathDir, "rg", "", 0)
				return ""
			},
			want: func(s setup) ripgrep.Binary {
				return ripgrep.Binary{Path: filepath.Join(s.exeDir, ripgrep.BinName), Source: ripgrep.SourceBundled}
			},
		},
		{
			name:      "bundled in an install",
			installed: true,
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.exeDir, ripgrep.BinName, "", 0)
				return ""
			},
			want: func(s setup) ripgrep.Binary {
				return ripgrep.Binary{Path: filepath.Join(s.exeDir, ripgrep.BinName), Source: ripgrep.SourceBundled}
			},
		},
		{
			name: "the environment wins",
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.exeDir, ripgrep.BinName, "", 0)
				return ripgreptest.Fake(t, s.other, "my-rg", "", 0)
			},
			want: func(s setup) ripgrep.Binary {
				return ripgrep.Binary{Path: filepath.Join(s.other, "my-rg"), Source: ripgrep.SourceEnv}
			},
		},
		{
			name: "an environment path that is not there",
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.exeDir, ripgrep.BinName, "", 0)
				return filepath.Join(s.other, "nope")
			},
			wantErr: ripgrep.EnvBin + "=",
		},
		{
			name: "dev: code-foundry-rg on PATH before rg",
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.pathDir, "rg", "", 0)
				ripgreptest.Fake(t, s.pathDir, ripgrep.BinName, "", 0)
				return ""
			},
			want: func(s setup) ripgrep.Binary {
				return ripgrep.Binary{Path: filepath.Join(s.pathDir, ripgrep.BinName), Source: ripgrep.SourcePath}
			},
		},
		{
			name: "dev: rg on PATH",
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.pathDir, "rg", "", 0)
				return ""
			},
			want: func(s setup) ripgrep.Binary {
				return ripgrep.Binary{Path: filepath.Join(s.pathDir, "rg"), Source: ripgrep.SourcePath}
			},
		},
		{
			name:      "an install never falls back to PATH",
			installed: true,
			prepare: func(t *testing.T, s setup) string {
				ripgreptest.Fake(t, s.pathDir, "rg", "", 0)
				return ""
			},
			wantErr: "no ",
		},
		{
			name: "not executable",
			prepare: func(t *testing.T, s setup) string {
				p := ripgreptest.Fake(t, s.exeDir, ripgrep.BinName, "", 0)
				if err := os.Chmod(p, 0o644); err != nil {
					t.Fatal(err)
				}
				return ""
			},
			wantErr: ripgrep.BinName,
		},
		{
			name: "a directory of that name",
			prepare: func(t *testing.T, s setup) string {
				if err := os.Mkdir(filepath.Join(s.exeDir, ripgrep.BinName), 0o755); err != nil {
					t.Fatal(err)
				}
				return ""
			},
			wantErr: ripgrep.BinName,
		},
		{
			name:    "nothing anywhere",
			prepare: func(*testing.T, setup) string { return "" },
			wantErr: "no ",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := setup{exeDir: t.TempDir(), pathDir: t.TempDir(), other: t.TempDir()}
			env := tt.prepare(t, s)
			l := ripgrep.Locator{
				ExeDir:    s.exeDir,
				Installed: tt.installed,
				Getenv: func(k string) string {
					if k == ripgrep.EnvBin {
						return env
					}
					return ""
				},
				LookPath: func(name string) (string, error) {
					p := filepath.Join(s.pathDir, name)
					if _, err := os.Stat(p); err != nil {
						return "", err
					}
					return p, nil
				},
			}
			got, err := l.Find()
			if tt.wantErr != "" {
				if !errors.Is(err, ripgrep.ErrMissing) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Find() = %+v, %v; want ErrMissing containing %q", got, err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if want := tt.want(s); got != want {
				t.Fatalf("Find() = %+v, want %+v", got, want)
			}
		})
	}
}

func TestFindUnknownExeDir(t *testing.T) {
	l := ripgrep.Locator{Installed: true, Getenv: func(string) string { return "" }}
	if _, err := l.Find(); !errors.Is(err, ripgrep.ErrMissing) {
		t.Fatalf("err = %v, want ErrMissing", err)
	}
}

func TestDefaultInstalled(t *testing.T) {
	// The test binary runs from a build directory with no VERSION beside it.
	if l := ripgrep.Default(); l.ExeDir == "" || l.Installed {
		t.Fatalf("Default() = %+v, want a known directory that is not an install", l)
	}
}

func TestCheck(t *testing.T) {
	tests := []struct {
		name    string
		out     string
		exit    int
		want    string
		wantErr string
	}{
		{name: "the shipped version", out: ripgreptest.VersionOutput(ripgrep.Version), want: ripgrep.Version},
		{name: "another version", out: ripgreptest.VersionOutput("14.1.1"), want: "14.1.1"},
		{name: "not ripgrep", out: "grep (BSD grep) 2.6.0", wantErr: "not ripgrep's version line"},
		{name: "silent", out: "", wantErr: "printed nothing"},
		{name: "fails", exit: 3, wantErr: "exit status 3"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := ripgreptest.Fake(t, t.TempDir(), ripgrep.BinName, tt.out, tt.exit)
			got, err := ripgrep.Binary{Path: p, Source: ripgrep.SourceBundled}.Check(context.Background())
			if tt.wantErr != "" {
				if !errors.Is(err, ripgrep.ErrBroken) || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("Check() = %q, %v; want ErrBroken containing %q", got, err, tt.wantErr)
				}
				return
			}
			if err != nil || got != tt.want {
				t.Fatalf("Check() = %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestParseVersion(t *testing.T) {
	tests := []struct {
		out, want string
	}{
		{"ripgrep 15.2.0 (rev e89fff89ac)\n\nfeatures:+pcre2\n", "15.2.0"},
		{"ripgrep 14.1.1\n", "14.1.1"},
		{"ripgrep 13.0.0 (rev af6b6c543b) -SIMD -AVX (compiled)\n", "13.0.0"},
		{"ripgrep 15.2.0-dev", "15.2.0"},
		{"  ripgrep 15.2.0  \n", "15.2.0"},
		{"ripgrep 15.2", ""},
		{"ripgrep 15.2.0x", ""},
		{"ugrep 7.0.0", ""},
		{"\nripgrep 15.2.0", ""},
	}
	for _, tt := range tests {
		got, err := ripgrep.ParseVersion(tt.out)
		if got != tt.want || (err == nil) != (tt.want != "") {
			t.Errorf("ParseVersion(%q) = %q, %v; want %q", tt.out, got, err, tt.want)
		}
	}
}

// The Go pin and the fetch script's pin are the same version.
func TestVersionMatchesFetchScript(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "scripts", "ripgrep.sh"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^RG_VERSION="([^"]+)"$`).FindSubmatch(b)
	if m == nil {
		t.Fatal("scripts/ripgrep.sh has no RG_VERSION line")
	}
	if got := string(m[1]); got != ripgrep.Version {
		t.Fatalf("scripts/ripgrep.sh pins %s, ripgrep.Version is %s", got, ripgrep.Version)
	}
}
