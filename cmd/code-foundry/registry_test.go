package main

import (
	"bytes"
	"errors"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// failed is an Invoke error with a CommandFailed detail, as the daemon sends a command's
// own failure.
func failed(code connect.Code, msg string) error {
	ce := connect.NewError(code, errors.New(msg))
	if d, err := connect.NewErrorDetail(&v1.CommandFailed{Command: "project.create"}); err == nil {
		ce.AddDetail(d)
	}
	return ce
}

func TestInvokeFailed(t *testing.T) {
	tests := []struct {
		name       string
		err        error
		wantErr    error // errUsage, errReported, or nil for a returned error
		wantText   string
		wantStderr string
	}{
		{"caller mistake", connect.NewError(connect.CodeInvalidArgument, errors.New("bad")), errUsage, "",
			"code-foundry project.create: bad\nRun `code-foundry help project.create` for usage.\n"},
		{"one line from the tool", connect.NewError(connect.CodeUnknown, errors.New("GraphQL: Name already exists on this account")), nil,
			"project.create: GraphQL: Name already exists on this account (unknown)", ""},
		{"several lines from the tool, as is", connect.NewError(connect.CodeUnknown, errors.New("To https://github.com/me/x.git\n ! [rejected] main -> main\nerror: failed to push")),
			errReported, "", "code-foundry project.create failed:\nTo https://github.com/me/x.git\n ! [rejected] main -> main\nerror: failed to push\n"},
		{"a plugin's error: its words, exit 1", failed(connect.CodeFailedPrecondition, "no run selected"), errReported, "",
			"code-foundry project.create: no run selected\n"},
		{"a plugin's invalid argument: exit 1, no help pointer", failed(connect.CodeInvalidArgument, "project.create: unknown run 12"), errReported, "",
			"code-foundry project.create: unknown run 12\n"},
		{"a plugin down: exit 1", failed(connect.CodeFailedPrecondition, "not available in this context: plugin x is failed (boom); run `code-foundry plugin restart x`"),
			errReported, "", "code-foundry project.create: not available in this context: plugin x is failed (boom); run `code-foundry plugin restart x`\n"},
		{"other codes", connect.NewError(connect.CodeDeadlineExceeded, errors.New("took too long\nreally")), nil,
			"project.create: took too long\nreally (deadline_exceeded)", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stderr bytes.Buffer
			cl := &cli{stderr: &stderr}
			err := cl.invokeFailed("project.create", tt.err)
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
