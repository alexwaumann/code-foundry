package main

import (
	"bytes"
	"errors"
	"testing"

	"connectrpc.com/connect"
)

func TestInvokeFailed(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantErr    error // errUsage, errReported, or nil for a returned error
		wantText   string
		wantStderr string
	}{
		{"caller mistake", connect.NewError(connect.CodeInvalidArgument, errors.New("bad")), errUsage, "",
			"code-foundry repo.create: bad\nRun `code-foundry help repo.create` for usage.\n"},
		{"one line from the tool", connect.NewError(connect.CodeUnknown, errors.New("GraphQL: Name already exists on this account")), nil,
			"repo.create: GraphQL: Name already exists on this account (unknown)", ""},
		{"several lines from the tool, as is", connect.NewError(connect.CodeUnknown, errors.New("To https://github.com/me/x.git\n ! [rejected] main -> main\nerror: failed to push")),
			errReported, "", "code-foundry repo.create failed:\nTo https://github.com/me/x.git\n ! [rejected] main -> main\nerror: failed to push\n"},
		{"other codes", connect.NewError(connect.CodeDeadlineExceeded, errors.New("took too long\nreally")), nil,
			"repo.create: took too long\nreally (deadline_exceeded)", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			err := cl.invokeFailed("repo.create", tt.err)
			switch {
			case tt.wantErr != nil && !errors.Is(err, tt.wantErr):
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			case tt.wantErr == nil && (err == nil || err.Error() != tt.wantText):
				t.Fatalf("err = %v, want %q", err, tt.wantText)
			}
			if stderr.String() != tt.wantStderr {
				t.Errorf("stderr = %q, want %q", stderr.String(), tt.wantStderr)
			}
		})
	}
}
