package browser

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/version"
)

func TestSafeName(t *testing.T) {
	for _, tt := range []struct{ name, in, want string }{
		{"plain", "report.pdf", "report.pdf"},
		{"a path", "../../escape.txt", "_.._escape.txt"},
		{"a backslash path", `..\evil.txt`, "_evil.txt"},
		{"hidden", ".zshrc", "zshrc"},
		{"only dots", "...", "download"},
		{"empty", "", "download"},
		{"bidi override", "report‮fdp.exe", "reportfdp.exe"},
		{"zero width", "in​voice.pdf", "invoice.pdf"},
		{"control", "a\x00b\nc.txt", "abc.txt"},
		{"a mac separator", "a:b.txt", "a_b.txt"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if got := safeName(tt.in); got != tt.want {
				t.Fatalf("safeName(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
	long := safeName(strings.Repeat("x", 500) + ".txt")
	if len(long) > maxLabel || !strings.HasSuffix(long, ".txt") {
		t.Fatalf("a long name became %q", long)
	}
}

func TestMoveIntoNeverOverwrites(t *testing.T) {
	dir := t.TempDir()
	staged := filepath.Join(t.TempDir(), "guid")
	for i, want := range []string{"a.txt", "a (1).txt", "a (2).txt"} {
		if err := os.WriteFile(staged, []byte{byte(i)}, 0o600); err != nil {
			t.Fatal(err)
		}
		got, err := moveInto(staged, dir, "a.txt")
		if err != nil || filepath.Base(got) != want {
			t.Fatalf("got %q, %v", got, err)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.txt")); len(b) != 1 || b[0] != 0 {
		t.Fatalf("the first file became %v", b)
	}
}

func TestChromeBinIsADevBuildsAlone(t *testing.T) {
	stand := filepath.Join(t.TempDir(), "stand-in")
	t.Setenv(EnvChromeBin, stand)
	home := t.TempDir()
	was := version.Version
	t.Cleanup(func() { version.Version = was })

	version.Version = "dev"
	if got, err := FindChrome(home); err != nil || got != stand {
		t.Fatalf("dev: %q, %v", got, err)
	}
	for _, v := range []string{"v1.2.3", "v1.2.3-tip.4"} {
		version.Version = v
		if got, err := FindChrome(home); err == nil && got == stand {
			t.Fatalf("%s took the program from the environment", v)
		}
	}
}

func TestSystemPanelsAreOffInEveryChrome(t *testing.T) {
	args := strings.Join(chromeArgs("/p"), " ")
	for _, want := range []string{"FileSystemAccess", "WebAuth", "WebShare", "EyeDropperAPI"} {
		if !strings.Contains(args, want) {
			t.Fatalf("%s is on: %s", want, args)
		}
	}
}
