package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunFlags(t *testing.T) {
	notWav := filepath.Join(t.TempDir(), "x.wav")
	if err := os.WriteFile(notWav, []byte("not a wav"), 0o644); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name       string
		args       []string
		stdin      string
		wantCode   int
		wantStdout string
		wantStderr string
	}{
		{"version", []string{"--version"}, "", 0, "code-foundry-dictate dev\n", ""},
		{"transcribe needs a model", []string{"--transcribe", "x.wav"}, "", 2, "", "--transcribe needs --model"},
		{"unknown flag", []string{"--nope"}, "", 2, "", "flag provided but not defined"},
		{"transcribe rejects a non-wav", []string{"--transcribe", notWav, "--model", "/m.bin"}, "", 1, "", "not a RIFF/WAVE file"},
		{"serve until EOF", nil, "{\"id\":1,\"method\":\"status\"}\n", 0,
			"{\"event\":\"state\",\"params\":{\"state\":\"idle\"}}\n{\"id\":1,\"result\":{\"state\":\"idle\",\"model_loaded\":false,\"rss_bytes\":", ""},
		{"serve until shutdown", nil, "{\"id\":1,\"method\":\"shutdown\"}\n", 0,
			"{\"event\":\"state\",\"params\":{\"state\":\"idle\"}}\n{\"id\":1,\"result\":{}}\n", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			code := run(tt.args, strings.NewReader(tt.stdin), &stdout, &stderr)
			if code != tt.wantCode {
				t.Fatalf("exit %d, want %d; stderr:\n%s", code, tt.wantCode, stderr.String())
			}
			if !strings.HasPrefix(stdout.String(), tt.wantStdout) {
				t.Fatalf("stdout %q, want prefix %q", stdout.String(), tt.wantStdout)
			}
			if !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Fatalf("stderr %q, want %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}
