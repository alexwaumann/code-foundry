package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/model"
)

// fakeClaude writes an executable shell script standing in for claude into a temp
// dir. Each run records its arguments (NUL-separated) in call<N>, then runs body,
// which sees $refused=1 when the hardened flags (--safe-mode) are present.
func fakeClaude(t *testing.T, body string) (bin, dir string) {
	t.Helper()
	dir = t.TempDir()
	bin = filepath.Join(dir, "claude")
	script := `#!/bin/sh
d="$(dirname "$0")"
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$d/count"
printf '%s\0' "$@" > "$d/call$n"
refused=0
for a in "$@"; do [ "$a" = "--safe-mode" ] && refused=1; [ "$a" = "--" ] && break; done
` + body + "\n"
	if err := os.WriteFile(bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin, dir
}

// fakeCalls returns the argument lists of every fake claude run, in order, with
// the prompt (the argument after "--") replaced by "<prompt>".
func fakeCalls(t *testing.T, dir string) [][]string {
	t.Helper()
	var calls [][]string
	for i := 1; ; i++ {
		b, err := os.ReadFile(filepath.Join(dir, "call"+strconv.Itoa(i)))
		if errors.Is(err, os.ErrNotExist) {
			return calls
		}
		if err != nil {
			t.Fatal(err)
		}
		args := strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
		if j := slices.Index(args, "--"); j >= 0 && j == len(args)-2 {
			if !strings.Contains(args[j+1], "Request:\n-fix the login bug") {
				t.Errorf("prompt = %q", args[j+1])
			}
			args[j+1] = "<prompt>"
		}
		calls = append(calls, args)
	}
}

func TestClaudeNamer(t *testing.T) {
	hardened := append(namingArgs("opus", false), "--", "<prompt>")
	minimal := append(namingArgs("opus", true), "--", "<prompt>")
	tests := []struct {
		name string
		body string
		// calls: the fake claude runs made by two Namer calls in a row.
		calls   [][]string
		wantErr []string // substrings of the first call's error; nil for success
		warn    bool     // a refusal warning is logged
	}{
		{
			name:  "success",
			body:  "printf '\\n**Fix the login bug**\\n'",
			calls: [][]string{hardened, hardened},
		},
		{
			name: "enterprise MCP config refusal, then success",
			body: `if [ $refused = 1 ]; then echo "You cannot use --strict-mcp-config when an enterprise MCP config is present" >&2; exit 1; fi
echo "Fix the login bug"`,
			// The second Namer call goes straight to the minimal command.
			calls: [][]string{hardened, minimal, minimal},
			warn:  true,
		},
		{
			name: "unknown option, then success",
			body: `if [ $refused = 1 ]; then echo "error: unknown option '--safe-mode'" >&2; exit 1; fi
echo '"Fix the login bug."'`,
			calls: [][]string{hardened, minimal, minimal},
			warn:  true,
		},
		{
			name:    "no title in the answer",
			body:    `echo '""'; echo '  '`,
			calls:   [][]string{hardened, hardened},
			wantErr: []string{"no usable name"},
		},
		{
			name:    "hard failure",
			body:    `echo "API Error: 500 Internal server error" ; exit 1`,
			calls:   [][]string{hardened, hardened},
			wantErr: []string{"exit status 1", "API Error: 500 Internal server error"},
		},
		{
			name: "refusal, then the minimal command fails too",
			body: `if [ $refused = 1 ]; then echo "--mcp-config is disabled by your organization's managed settings (disableSideloadFlags)." >&2; exit 1; fi
echo "API Error: 429 rate limited"; exit 1`,
			calls:   [][]string{hardened, minimal, minimal},
			wantErr: []string{"API Error: 429", "disableSideloadFlags"},
			warn:    true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bin, dir := fakeClaude(t, tt.body)
			var logs bytes.Buffer
			namer := ClaudeNamer(bin, t.TempDir(), slog.New(slog.NewTextHandler(&logs, nil)))
			ctx := WithNamingModel(withNamingSession(context.Background(), "s123"), "opus")
			for i := range 2 {
				name, err := namer(ctx, "-fix the login bug")
				if tt.wantErr == nil {
					if err != nil || name != "Fix the login bug" {
						t.Fatalf("call %d = %q, %v", i, name, err)
					}
					continue
				}
				if err == nil {
					t.Fatalf("call %d = %q, want an error", i, name)
				}
				if i == 0 {
					for _, w := range tt.wantErr {
						if !strings.Contains(err.Error(), w) {
							t.Errorf("err = %v, want it to contain %q", err, w)
						}
					}
					if isRateLimit(err) != strings.Contains(tt.body, "429") {
						t.Errorf("isRateLimit(%v) = %v", err, isRateLimit(err))
					}
				}
			}
			if got := fakeCalls(t, dir); !slices.EqualFunc(got, tt.calls, slices.Equal) {
				t.Errorf("calls =\n%q\nwant\n%q", got, tt.calls)
			}
			if got := strings.Contains(logs.String(), "level=WARN"); got != tt.warn {
				t.Errorf("warned = %v, want %v; logs:\n%s", got, tt.warn, logs.String())
			}
			if !strings.Contains(logs.String(), "session=s123") || !strings.Contains(logs.String(), `"naming command finished"`) {
				t.Errorf("logs miss the session or the command:\n%s", logs.String())
			}
		})
	}
}

func TestIsFlagRefused(t *testing.T) {
	tests := []struct {
		msg  string
		want bool
	}{
		{"You cannot use --strict-mcp-config when an enterprise MCP config is present", true},
		{"You cannot dynamically configure MCP servers when an enterprise MCP config is present", true},
		{"error: unknown option '--safe-mode'", true},
		{"--mcp-config is disabled by your organization's managed settings (disableSideloadFlags). Plugins, ...", true},
		{"--chrome is blocked by your organization's MCP policy (an enterprise MCP config or a deniedMcpServers entry).", true},
		{"--safe-mode is not allowed by your administrator", true},
		{"API Error: 403 Request not allowed", false},
		{"API Error: 500 Internal server error", false},
		{"API Error: 429 rate limited", false},
		{"Error: Input must be provided either through stdin or as a prompt argument when using --print", false},
	}
	for _, tt := range tests {
		err := fmt.Errorf("claude -p: exit status 1: %s", tt.msg)
		if got := isFlagRefused(err); got != tt.want {
			t.Errorf("isFlagRefused(%q) = %v, want %v", tt.msg, got, tt.want)
		}
	}
	if isFlagRefused(nil) {
		t.Error("isFlagRefused(nil) = true")
	}
}

func TestNamingArgs(t *testing.T) {
	tests := []struct {
		name    string
		model   string
		minimal bool
		want    string
	}{
		{"hardened", "opus", false, `-p --model opus --effort low --no-session-persistence --safe-mode --tools "" -- <prompt>`},
		{"minimal", "opus", true, `-p --model opus --effort low --no-session-persistence -- <prompt>`},
		{"default model, hardened", model.NamingDefault, false, `-p --model sonnet --effort low --no-session-persistence --safe-mode --tools "" -- <prompt>`},
		{"default model, minimal", model.NamingDefault, true, `-p --model sonnet --effort low --no-session-persistence -- <prompt>`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := namingCommand(namingArgs(tt.model, tt.minimal)); got != tt.want {
				t.Errorf("namingCommand = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNamingModel(t *testing.T) {
	tests := []struct {
		name string
		ctx  context.Context
		want string
	}{
		{"unset", context.Background(), "sonnet"},
		{"empty", WithNamingModel(context.Background(), ""), "sonnet"},
		{"unknown", WithNamingModel(context.Background(), "gpt-5"), "sonnet"},
		{"set", WithNamingModel(context.Background(), "haiku"), "haiku"},
		{"pinned", WithNamingModel(context.Background(), "claude-opus-4-8"), "claude-opus-4-8"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := NamingModel(tt.ctx); got != tt.want {
				t.Errorf("NamingModel = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestClaudeNamerModel checks the model reaches the command per call: no
// WithNamingModel names with the default, and a later call can pick another model.
func TestClaudeNamerModel(t *testing.T) {
	bin, dir := fakeClaude(t, `echo fix-login-bug`)
	namer := ClaudeNamer(bin, t.TempDir(), slog.New(slog.DiscardHandler))
	for _, ctx := range []context.Context{context.Background(), WithNamingModel(context.Background(), "haiku")} {
		if _, err := namer(ctx, "-fix the login bug"); err != nil {
			t.Fatal(err)
		}
	}
	want := [][]string{
		append(namingArgs("sonnet", false), "--", "<prompt>"),
		append(namingArgs("haiku", false), "--", "<prompt>"),
	}
	if got := fakeCalls(t, dir); !slices.EqualFunc(got, want, slices.Equal) {
		t.Errorf("calls =\n%q\nwant\n%q", got, want)
	}
}
