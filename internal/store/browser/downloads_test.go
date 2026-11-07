package browser

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
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
		{"bidi override", "report\u202Efdp.exe", "reportfdp.exe"},
		{"zero width", "in\u200Bvoice.pdf", "invoice.pdf"},
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
	for _, want := range []string{"FileSystemAccess", "WebAuth", "WebShare", "EyeDropperAPI", "DocumentPictureInPictureAPI", "FedCm", "pictureInPictureEnabled=false", "--max-old-space-size=", "--log-level=2"} {
		if !strings.Contains(args, want) {
			t.Fatalf("%s is on: %s", want, args)
		}
	}
}

func TestTheProfileRefusesWhatLeavesTheWeb(t *testing.T) {
	read := func(t *testing.T, profile string) map[string]any {
		t.Helper()
		b, err := os.ReadFile(filepath.Join(profile, "Default", "Preferences"))
		if err != nil {
			t.Fatal(err)
		}
		var got map[string]any
		if err := json.Unmarshal(b, &got); err != nil {
			t.Fatal(err)
		}
		return got
	}
	check := func(t *testing.T, got map[string]any) {
		t.Helper()
		if got["printing"].(map[string]any)["enabled"] != false {
			t.Fatalf("printing %v", got["printing"])
		}
		policy := got["policy"].(map[string]any)
		if b := policy["url_blocklist"].([]any); len(b) != 1 || b[0] != "*" {
			t.Fatalf("blocklist %v", b)
		}
		allowed := policy["url_allowlist"].([]any)
		for _, scheme := range []any{"mailto:*", "file://*", "*"} {
			if slices.Contains(allowed, scheme) {
				t.Fatalf("allowed %v", scheme)
			}
		}
	}
	for _, tt := range []struct{ name, before string }{
		{"a new profile", ""},
		{"one a user has used", `{"printing":{"enabled":true,"x":1},"session":{"restore_on_startup":1}}`},
		{"one that does not parse", `{"printing`},
	} {
		t.Run(tt.name, func(t *testing.T) {
			profile := t.TempDir()
			if tt.before != "" {
				if err := os.MkdirAll(filepath.Join(profile, "Default"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(profile, "Default", "Preferences"), []byte(tt.before), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := hardenProfile(profile); err != nil {
				t.Fatal(err)
			}
			got := read(t, profile)
			check(t, got)
			if tt.name == "one a user has used" {
				if got["printing"].(map[string]any)["x"] != 1.0 || got["session"] == nil {
					t.Fatalf("lost what was there: %v", got)
				}
			}
		})
	}
}

func TestWhatTheMemoryWatchKills(t *testing.T) {
	gib := 1 << 20 // ps says KiB
	busy := func(pid, group, rss int, cpu float64) string {
		return fmt.Sprintf(" %d %d %d %.1f\n", pid, group, rss, cpu)
	}
	ps := func(pid, group, rss int) string { return busy(pid, group, rss, 1) }
	hot := busy(100, 100, gib/4, 198) + busy(101, 100, gib/4, 197) + busy(102, 100, gib/4, 1)
	tests := []struct {
		name    string
		polls   []string
		helpers []int
		browser bool
	}{
		{"all calm", []string{ps(100, 100, gib/4) + ps(101, 100, gib)}, nil, false},
		{"a renderer past its limit", []string{ps(100, 100, gib/4) + ps(101, 100, 5*gib) + ps(102, 100, gib)}, []int{101}, false},
		{"Chrome itself", []string{ps(100, 100, 7*gib) + ps(101, 100, gib)}, nil, true},
		{"someone else's memory", []string{ps(100, 100, gib/4) + ps(900, 900, 50*gib) + ps(901, 1, 50*gib)}, nil, false},
		{"lines that say nothing", []string{"nonsense\n 1 2\n x y z w\n" + ps(101, 100, 5*gib)}, []int{101}, false},
		{"growing fast", []string{ps(101, 100, gib/4), ps(101, 100, gib), ps(101, 100, 3*gib/2)}, []int{101}, false},
		{"growing fast but small", []string{ps(101, 100, gib/8), ps(101, 100, 7*gib/8)}, nil, false},
		{"growing slowly", []string{ps(101, 100, 3*gib), ps(101, 100, 3*gib+1), ps(101, 100, 3*gib+2)}, nil, false},
		{
			"growing, but over longer than the window",
			[]string{ps(101, 100, gib), ps(101, 100, gib+gib/8), ps(101, 100, gib+gib/4), ps(101, 100, gib+3*gib/8), ps(101, 100, gib+gib/2-1), ps(101, 100, gib+5*gib/8), ps(101, 100, gib+3*gib/4-2)},
			nil, false,
		},
		{
			"Chrome swelling, with a page at work",
			[]string{ps(100, 100, gib/4) + busy(101, 100, gib/4, 195) + busy(102, 100, gib/4, 3), ps(100, 100, gib) + busy(101, 100, gib/4, 198) + busy(102, 100, gib/4, 3)},
			[]int{101}, false,
		},
		{
			"Chrome swelling, with nobody at work",
			[]string{ps(100, 100, gib/4) + busy(101, 100, gib/4, 2), ps(100, 100, gib) + busy(101, 100, gib/4, 2)},
			nil, false,
		},
		{
			"Chrome out of time, with a page at work",
			[]string{hot, hot, hot},
			[]int{101}, false,
		},
		{"a crowd of renderers", []string{ps(100, 100, gib/4) + func() string {
			out := ""
			for i := range 130 {
				out += ps(200+i, 100, gib/10)
			}
			return out
		}()}, nil, true},
		{"Chrome out of time for a moment", []string{hot, hot}, nil, false},
		{"Chrome out of time, but not in a row", []string{hot, hot, ps(100, 100, gib/4) + busy(101, 100, gib/4, 195), hot, hot}, nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := memoryWatch{pid: 100}
			var helpers []int
			var browser bool
			for _, poll := range tt.polls {
				helpers, browser = w.read(poll)
			}
			if !slices.Equal(helpers, tt.helpers) || browser != tt.browser {
				t.Fatalf("%v %v", helpers, browser)
			}
		})
	}
}

func TestOneSwellIsBlamedOnOnePage(t *testing.T) {
	gib := 1 << 20
	w := memoryWatch{pid: 100}
	poll := func(browser int) []int {
		helpers, _ := w.read(fmt.Sprintf("100 100 %d 90.0\n101 100 1000 150.0\n", browser))
		return helpers
	}
	poll(gib / 4)
	if got := poll(gib); !slices.Equal(got, []int{101}) {
		t.Fatalf("first %v", got)
	}
	if got := poll(gib); got != nil {
		t.Fatalf("Chrome's size alone blamed another: %v", got)
	}
}
