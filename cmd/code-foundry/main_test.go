package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
)

func TestDispatch(t *testing.T) {
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string
		wantStderr string
	}{
		{"no args prints GUI hint", nil, nil, "code-foundry gui", ""},
		{"help", []string{"help"}, nil, "Commands:", ""},
		{"unknown", []string{"bogus"}, errUsage, "", `unknown command "bogus"`},
		{"version", []string{"version"}, nil, "", ""},
		{"version extra args", []string{"version", "x"}, errUsage, "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			err := dispatch(context.Background(), tt.args, &stdout, &stderr)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if !strings.Contains(stdout.String(), tt.wantStdout) {
				t.Errorf("stdout = %q, want containing %q", stdout.String(), tt.wantStdout)
			}
			if !strings.Contains(stderr.String(), tt.wantStderr) {
				t.Errorf("stderr = %q, want containing %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}

func TestFormatVersion(t *testing.T) {
	tests := []struct{ v, commit, want string }{
		{"dev", "", "dev"},
		{"1.0.0", "abc", "1.0.0 (abc)"},
		{"1.0.0", "0123456789abcdef", "1.0.0 (0123456789ab)"},
		{"1.0.0", "0123456789abcdef-dirty", "1.0.0 (0123456789ab-dirty)"},
	}
	for _, tt := range tests {
		if got := formatVersion(tt.v, tt.commit); got != tt.want {
			t.Errorf("formatVersion(%q, %q) = %q, want %q", tt.v, tt.commit, got, tt.want)
		}
	}
}
