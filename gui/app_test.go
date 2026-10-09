package main

import "testing"

func TestRelaunchCommand(t *testing.T) {
	tests := []struct {
		name, exe string
		args      []string
		want      string
	}{
		{
			name: "installed GUI",
			exe:  "/Users/a/.code-foundry/app/Code Foundry",
			want: "while kill -0 42 2>/dev/null; do sleep 0.1; done; exec '/Users/a/.code-foundry/app/Code Foundry'",
		},
		{
			name: "arguments and spaces are kept",
			exe:  "/tmp/cf home/app/Code Foundry",
			args: []string{"--flag", "it's"},
			want: `while kill -0 42 2>/dev/null; do sleep 0.1; done; exec '/tmp/cf home/app/Code Foundry' '--flag' 'it'\''s'`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := relaunchCommand(42, tt.exe, tt.args); got != tt.want {
				t.Fatalf("got  %s\nwant %s", got, tt.want)
			}
		})
	}
}

func TestParseMarkedPath(t *testing.T) {
	tests := []struct{ in, want string }{
		{pathMarker + "/opt/homebrew/bin:/usr/bin" + pathMarker, "/opt/homebrew/bin:/usr/bin"},
		{"motd noise\n" + pathMarker + "/a:/b" + pathMarker + "\ntrailing", "/a:/b"},
		{"no marker", ""},
		{pathMarker + "/a:/b", ""},
	}
	for _, tt := range tests {
		if got := parseMarkedPath(tt.in); got != tt.want {
			t.Errorf("parseMarkedPath(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestShellQuote(t *testing.T) {
	if got := shellQuote("it's"); got != `'it'\''s'` {
		t.Fatalf("got %s", got)
	}
}
