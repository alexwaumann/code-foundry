package plugin

import (
	"context"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestKeychainAccount: the account names exactly one (plugin, key) pair, and anything
// that could leave the plugin's namespace (or be syntax on `security -i`'s command line)
// is refused before the security CLI runs.
func TestKeychainAccount(t *testing.T) {
	tests := []struct {
		plugin, key string
		want        string // "" = refused
	}{
		{"hello", "word", "hello/word"},
		{"gh-actions", "token.v2_A-1", "gh-actions/token.v2_A-1"},
		{"1password", strings.Repeat("k", 128), "1password/" + strings.Repeat("k", 128)},
		{"hello", "../other/word", ""},
		{"hello", "other/word", ""},
		{"hello", "", ""},
		{"hello", "wörd", ""},
		{"hello", strings.Repeat("k", 129), ""},
		{"hello", "a\x00b", ""},
		{"hello", "a b", ""},
		{"hello", "a\nadd-generic-password -s x -a y -w z", ""},
		{"hello", `a"b`, ""},
		{"hello", "-w", "hello/-w"}, // a word to security, after -a: harmless
		{"", "word", ""},
		{"../hello", "word", ""},
		{"hello/x", "word", ""},
		{"Hello", "word", ""},
		{"hello world", "word", ""},
		{strings.Repeat("a", 65), "word", ""},
	}
	for _, tt := range tests {
		got, err := keychainAccount(tt.plugin, tt.key)
		if tt.want == "" {
			if err == nil {
				t.Errorf("keychainAccount(%q, %q) = %q, want an error", tt.plugin, tt.key, got)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("keychainAccount(%q, %q) = %q, %v; want %q", tt.plugin, tt.key, got, err, tt.want)
		}
	}
	// Injective: splitting an account at its only "/" gives back the pair, so two
	// different pairs never share an account.
	for _, tt := range tests {
		if tt.want == "" {
			continue
		}
		p, k, ok := strings.Cut(tt.want, "/")
		if !ok || p != tt.plugin || k != tt.key || strings.Contains(k, "/") {
			t.Errorf("account %q does not split back into (%q, %q)", tt.want, tt.plugin, tt.key)
		}
	}
}

func TestKeychainServiceFor(t *testing.T) {
	def := "/Users/ada/.code-foundry"
	if got := KeychainServiceFor(def, def); got != KeychainService {
		t.Errorf("default home: %q", got)
	}
	if got := KeychainServiceFor(def+"/", def); got != KeychainService {
		t.Errorf("default home with a slash: %q", got)
	}
	a, b := KeychainServiceFor("/Users/ada/tmp/cf-a", def), KeychainServiceFor("/Users/ada/tmp/cf-b", def)
	if a == KeychainService || b == KeychainService || a == b || !strings.HasPrefix(a, KeychainService+"-") {
		t.Errorf("other homes: %q, %q", a, b)
	}
	if !servicePattern.MatchString(a) {
		t.Errorf("%q is not one word for security -i", a)
	}
	if got := KeychainServiceFor("/Users/ada/tmp/cf-a", ""); got != a {
		t.Errorf("unknown default home: %q, want %q", got, a)
	}
}

// TestKeychainArgv runs Keychain against a fake security that records its argv and
// stdin: the value is never in argv (ps would show it), only hex-encoded on stdin, and a
// bad account never reaches the CLI.
func TestKeychainArgv(t *testing.T) {
	dir := t.TempDir()
	rec := filepath.Join(dir, "calls")
	fake := filepath.Join(dir, "security")
	script := "#!/bin/sh\n" +
		"{ printf 'ARGV'; for a in \"$@\"; do printf ' [%s]' \"$a\"; done; printf '\\n'; " +
		"if [ \"$1\" = -i ]; then printf 'STDIN '; cat; fi; } >> '" + rec + "'\n" +
		"case \"$1\" in find-generic-password) printf 'password: \"%s\"\\n' sw0rdfish >&2;; esac\n"
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	k := Keychain{Security: fake, Service: "code-foundry-plugin-test"}
	ctx := context.Background()
	const value = "sw0rdfish and more"
	if err := k.Set(ctx, "hello", "word", value); err != nil {
		t.Fatal(err)
	}
	if v, ok, err := k.Get(ctx, "hello", "word"); err != nil || !ok || v != "sw0rdfish" {
		t.Fatalf("Get = %q %v %v", v, ok, err)
	}
	if err := k.Delete(ctx, "hello", "word"); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"../x", "a\nb", "a b"} {
		if err := k.Set(ctx, "hello", bad, value); err == nil {
			t.Errorf("Set key %q: no error", bad)
		}
		if _, _, err := k.Get(ctx, "hello", bad); err == nil {
			t.Errorf("Get key %q: no error", bad)
		}
		if err := k.Delete(ctx, "hello", bad); err == nil {
			t.Errorf("Delete key %q: no error", bad)
		}
	}
	if err := (Keychain{Security: fake, Service: "bad service"}).Set(ctx, "hello", "word", value); err == nil {
		t.Error("Set with a service of two words: no error")
	}
	b, err := os.ReadFile(rec)
	if err != nil {
		t.Fatal(err)
	}
	got := string(b)
	want := "ARGV [-i]\nSTDIN add-generic-password -U -s code-foundry-plugin-test -a hello/word -X " + hex.EncodeToString([]byte(value)) + "\n" +
		"ARGV [find-generic-password] [-s] [code-foundry-plugin-test] [-a] [hello/word] [-g]\n" +
		"ARGV [delete-generic-password] [-s] [code-foundry-plugin-test] [-a] [hello/word]\n"
	if got != want {
		t.Errorf("security calls:\n%s\nwant:\n%s", got, want)
	}
	for _, line := range strings.Split(got, "\n") {
		if strings.HasPrefix(line, "ARGV") && strings.Contains(line, "sw0rdfish") {
			t.Errorf("the value is in argv: %s", line)
		}
	}
	if strings.Contains(got, "-A") || strings.Contains(got, "-T") {
		t.Error("the item would trust more applications than its creator")
	}
}
