package plugin

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

func TestBackoff(t *testing.T) {
	tests := []struct {
		n    int
		want time.Duration
	}{{1, time.Second}, {2, 2 * time.Second}, {3, 4 * time.Second}, {6, 32 * time.Second}, {7, 60 * time.Second}, {40, 60 * time.Second}}
	for _, tt := range tests {
		if got := backoff(tt.n, time.Second, time.Minute); got != tt.want {
			t.Errorf("backoff(%d) = %s, want %s", tt.n, got, tt.want)
		}
	}
}

func TestParsePasswordLine(t *testing.T) {
	tests := []struct {
		out  string
		want string
		ok   bool
	}{
		{`password: "plain value"`, "plain value", true},
		{"keychain: \"/x\"\npassword: 0x706C2261696E5C78  \"pl\"ain\\134x\"\n", `pl"ain\x`, true},
		{`password: 0x6C310A6C32  "l1\012l2"`, "l1\nl2", true},
		{`password: 0xZZ  "x"`, "", false},
		{"no password line", "", false},
	}
	for _, tt := range tests {
		got, ok := parsePasswordLine(tt.out)
		if got != tt.want || ok != tt.ok {
			t.Errorf("parsePasswordLine(%q) = %q %v, want %q %v", tt.out, got, ok, tt.want, tt.ok)
		}
	}
}

func TestLogBufferRotatesAndTails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "logs", "p.log")
	now := func() time.Time { return time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC) }
	b := newLogBuffer(path, 200, 3, now)
	defer b.close()
	tail, ch, cancel := b.subscribe(0)
	if len(tail) != 0 {
		t.Fatalf("tail %v", tail)
	}
	for i := range 10 {
		b.add("stderr", "", strings.Repeat("x", 30)+string(rune('a'+i)))
	}
	b.add("log", "warn", "careful\n")
	got := b.tail(0)
	if len(got) != 3 || got[2].Text != "careful" || got[2].Seq != 11 || got[2].Level != "warn" {
		t.Fatalf("tail %+v", got)
	}
	if len(b.tail(2)) != 2 {
		t.Error("tail(2)")
	}
	if first := <-ch; first.Seq != 1 {
		t.Errorf("follower got %+v first", first)
	}
	cancel()
	cancel()
	cur, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	old, err := os.ReadFile(path + ".1")
	if err != nil {
		t.Fatal("no rotation:", err)
	}
	if len(cur) > 200 || len(old) > 200 {
		t.Errorf("sizes %d %d", len(cur), len(old))
	}
	if !strings.HasSuffix(string(cur), "2026-10-18T09:00:00.000Z log warn careful\n") {
		t.Errorf("format: %q", cur)
	}
}

func TestConsentText(t *testing.T) {
	m := pluginsdk.Manifest{Name: "hello", DisplayName: "Hello", Version: "0.1.0", Exec: []string{"bin/hello"}}
	if got := ConsentText(m); got != "Enable Hello 0.1.0? It runs bin/hello as you and asks for no permissions." {
		t.Errorf("no permissions: %q", got)
	}
	m.Permissions = pluginsdk.Permissions{Commands: []string{"thread.send"}, Secrets: true}
	want := "Enable Hello 0.1.0? It runs bin/hello as you and may:\n  - run Code Foundry commands: thread.send\n  - keep secrets in your Keychain (its own, under code-foundry-plugin)"
	if got := ConsentText(m); got != want {
		t.Errorf("got %q", got)
	}
}

func TestManagementVerb(t *testing.T) {
	tests := map[string]bool{
		"plugin.enable": true, "plugin.secrets.list": true, "plugin.dev": true,
		"plugin.hello.greet": false, "thread.send": false, "pluginx.enable": false,
	}
	for name, want := range tests {
		if got := managementVerb(name); got != want {
			t.Errorf("managementVerb(%q) = %v", name, got)
		}
	}
}

func TestShortDuration(t *testing.T) {
	for d, want := range map[time.Duration]string{10 * time.Minute: "10m", time.Hour: "1h", 90 * time.Second: "1m30s", 2 * time.Second: "2s"} {
		if got := shortDuration(d); got != want {
			t.Errorf("shortDuration(%s) = %q, want %q", d, got, want)
		}
	}
}
