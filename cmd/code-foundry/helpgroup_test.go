package main

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// showGroupCommands adds a group whose bare name runs its .show (theme) and a domain
// whose only command is its .show (usage).
type showGroupCommands struct{ fakeArgCommands }

func (f *showGroupCommands) List(ctx context.Context, req *connect.Request[v1.ListCommandsRequest]) (*connect.Response[v1.ListCommandsResponse], error) {
	res, err := f.fakeArgCommands.List(ctx, req)
	if err != nil {
		return nil, err
	}
	res.Msg.Commands = append(res.Msg.Commands,
		&v1.Command{Name: "theme.show", Title: "Show Theme File", Category: "Settings", Available: true, Description: "Print a theme's file."},
		&v1.Command{Name: "theme.save", Title: "Save Theme File", Category: "Settings", Available: true},
		&v1.Command{Name: "theme.delete", Title: "Delete Theme", Category: "Settings", Available: true},
		&v1.Command{Name: "usage.show", Title: "Show Usage", Category: "View", Available: true, Description: "Print what threads cost."},
	)
	return res, nil
}

// A group name lists its commands: `help thread` (E4 4.10: "unknown command") on stdout,
// a bare `thread` on stderr with exit 2. A group whose bare name runs its .show lists its
// commands for `help theme` and `theme --help` (theme-fuzz-daemon, model 7); a domain with
// only a .show still prints that command's help.
func TestHelpGroup(t *testing.T) {
	group := "thread commands (`code-foundry help <command>` for one):\n" +
		"  thread.new        New Thread\n" +
		"  thread.report     Report\n" +
		"  thread.send       Send to Thread\n" +
		"  thread.subscribe  Subscribe\n"
	themes := "theme commands (`code-foundry help <command>` for one):\n" +
		"  theme.delete  Delete Theme\n" +
		"  theme.save    Save Theme File\n" +
		"  theme.show    Show Theme File\n"
	tests := []struct {
		name       string
		args       []string
		wantErr    error
		wantStdout string // a prefix when it ends in "…"
		wantStderr string
	}{
		{name: "help of a group", args: []string{"help", "thread"}, wantStdout: group},
		{name: "a group alone", args: []string{"thread"}, wantErr: errUsage, wantStderr: group},
		{name: "help of an unknown word", args: []string{"help", "bogus"}, wantErr: errUsage,
			wantStderr: "code-foundry: unknown command \"bogus\" (run `code-foundry commands` to list commands)\n"},
		{name: "help of a group with a show", args: []string{"help", "theme"}, wantStdout: themes},
		{name: "a group with a show, --help", args: []string{"theme", "--help"},
			wantStdout: themes + "(`code-foundry theme` alone runs theme.show)\n"},
		{name: "a group with a show, -h", args: []string{"theme", "-h"},
			wantStdout: themes + "(`code-foundry theme` alone runs theme.show)\n"},
		{name: "the show command's own help", args: []string{"theme", "show", "--help"}, wantStdout: "theme.show - Show Theme File…"},
		{name: "a domain with only a show", args: []string{"usage", "--help"}, wantStdout: "usage.show - Show Usage…"},
		{name: "help of a domain with only a show", args: []string{"help", "usage"}, wantStdout: "usage.show - Show Usage…"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cl, stdout, stderr := fakeCommandCLI(t, &showGroupCommands{})
			err := cl.dispatch(context.Background(), tt.args)
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("err = %v, want %v", err, tt.wantErr)
			}
			okOut := stdout.String() == tt.wantStdout
			if prefix, ok := strings.CutSuffix(tt.wantStdout, "…"); ok {
				okOut = strings.HasPrefix(stdout.String(), prefix)
			}
			if !okOut || stderr.String() != tt.wantStderr {
				t.Errorf("stdout = %q\nstderr = %q\nwant %q and %q", stdout.String(), stderr.String(), tt.wantStdout, tt.wantStderr)
			}
		})
	}
}
