package main

import (
	"context"
	"errors"
	"testing"
)

// A group name lists its commands: `help thread` (E4 4.10: "unknown command") on stdout,
// a bare `thread` on stderr with exit 2.
func TestHelpGroup(t *testing.T) {
	group := "thread commands (`code-foundry help <command>` for one):\n" +
		"  thread.new        New Thread\n" +
		"  thread.report     Report\n" +
		"  thread.send       Send to Thread\n" +
		"  thread.subscribe  Subscribe\n"
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string
		wantStderr string
	}{
		{name: "help of a group", args: []string{"help", "thread"}, wantStdout: group},
		{name: "a group alone", args: []string{"thread"}, wantErr: errUsage, wantStderr: group},
		{name: "help of an unknown word", args: []string{"help", "bogus"}, wantErr: errUsage,
			wantStderr: "code-foundry: unknown command \"bogus\" (run `code-foundry commands` to list commands)\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cl, stdout, stderr := fakeCommandCLI(t, &fakeArgCommands{})
			err := cl.dispatch(context.Background(), tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			if stdout.String() != tt.wantStdout || stderr.String() != tt.wantStderr {
				t.Errorf("stdout = %q\nstderr = %q\nwant %q and %q", stdout.String(), stderr.String(), tt.wantStdout, tt.wantStderr)
			}
		})
	}
}
