package main

import (
	"strings"
	"testing"
)

func TestRelaunchCommand(t *testing.T) {
	env := map[string]string{"CODE_FOUNDRY_HOME": "/tmp/cf home", "CODE_FOUNDRY_RELEASE_DIR": "/tmp/rel"}
	got, err := relaunchCommand(42, "/Users/a/Applications/CodeFoundry.app", func(k string) string { return env[k] })
	if err != nil {
		t.Fatal(err)
	}
	want := "while kill -0 42 2>/dev/null; do sleep 0.1; done; exec /usr/bin/open --env 'CODE_FOUNDRY_HOME=/tmp/cf home' --env 'CODE_FOUNDRY_RELEASE_DIR=/tmp/rel' '/Users/a/Applications/CodeFoundry.app'"
	if got != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	dev, err := relaunchCommand(42, "", func(string) string { return "" })
	if err != nil || !strings.Contains(dev, "; exec '") {
		t.Fatalf("dev relaunch %q, %v", dev, err)
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
