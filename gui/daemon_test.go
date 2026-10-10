package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDaemonBinary(t *testing.T) {
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	onPath := t.TempDir()
	bin := filepath.Join(onPath, "code-foundry")
	if err := os.WriteFile(bin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name    string
		env     string
		path    string
		want    string
		wantErr bool
	}{
		{"env override wins", "/opt/cf/code-foundry", onPath, "/opt/cf/code-foundry", false},
		{"found on PATH", "", onPath, bin, false},
		{"not found", "", t.TempDir(), "", true},
		// Spawning the GUI as the daemon would open a window per spawn, forever.
		{"env pointing at this executable is rejected", self, onPath, "", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Setenv(EnvDaemonBinary, tt.env)
			t.Setenv("PATH", tt.path)
			t.Chdir(t.TempDir()) // no ../bin/code-foundry next to the working directory
			got, err := daemonBinary()
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("daemonBinary() = %q, want %q", got, tt.want)
			}
		})
	}
}
