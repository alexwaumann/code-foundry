package skill

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// scripted answers every call with out and err.
type scripted struct {
	out []byte
	err error
}

func (s scripted) Run(context.Context, ...string) ([]byte, error) { return s.out, s.err }

func TestRunPluginOp(t *testing.T) {
	failed := func(line string) error {
		return &ClaudeError{Args: []string{"plugin"}, Msg: "✘ Failed", Stdout: []byte(line + "\n")}
	}
	tests := []struct {
		name        string
		out         string
		err         error
		wantMsg     string // the result's message, or the error's
		wantErr     bool
		wantNotFond bool
	}{
		{name: "ok", out: `{"command":"enable","outcome":"ok","message":"Successfully enabled plugin: x (scope: user)"}` + "\n",
			wantMsg: "Successfully enabled plugin: x (scope: user)"},
		{name: "ok after other output", out: "warning: something\n" + `{"outcome":"ok","message":"done"}`, wantMsg: "done"},
		{name: "already in that state", err: failed(`{"outcome":"failed","message":"already enabled","failureCode":"already_in_goal_state","alreadyInGoalState":true}`),
			wantMsg: "already enabled"},
		{name: "not found", err: failed(`{"outcome":"failed","message":"Plugin \"x\" not found","failureCode":"not_found"}`),
			wantMsg: `Plugin "x" not found`, wantErr: true, wantNotFond: true},
		{name: "not installed", err: failed(`{"outcome":"failed","message":"not installed","failureCode":"not_installed"}`),
			wantMsg: "not installed", wantErr: true, wantNotFond: true},
		{name: "other failure", err: failed(`{"outcome":"failed","message":"network down","failureCode":"fetch_failed"}`),
			wantMsg: "network down", wantErr: true},
		{name: "failed outcome with exit 0", out: `{"outcome":"failed","message":"nope"}`, wantMsg: "nope", wantErr: true},
		{name: "failure without a result line", err: &ClaudeError{Args: []string{"plugin", "install"}, Msg: "boom"},
			wantMsg: "claude plugin install: boom", wantErr: true},
		{name: "not run", err: errors.New("run claude: no such file"), wantMsg: "run claude: no such file", wantErr: true},
		{name: "garbage", out: "Installed!\n", wantMsg: "no result line", wantErr: true},
		{name: "broken json", out: "{nope\n", wantMsg: "read the result", wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := runPluginOp(context.Background(), scripted{out: []byte(tt.out), err: tt.err}, "enable", "x@m")
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v", err)
			}
			if err != nil {
				var pe *PluginError
				if !errors.As(err, &pe) || !strings.Contains(err.Error(), tt.wantMsg) || errors.Is(err, ErrNotFound) != tt.wantNotFond {
					t.Errorf("err = %#v (%v)", err, err)
				}
				if tt.err != nil && !errors.Is(err, tt.err) {
					t.Errorf("err does not wrap %v", tt.err)
				}
				return
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q", res.Message)
			}
		})
	}
}
