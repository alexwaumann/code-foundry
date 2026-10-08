package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/internal/command"
	"github.com/awaumann/code-foundry/internal/command/commandtest"
	"github.com/awaumann/code-foundry/internal/version"
)

func newUpdateRegistry(t *testing.T, u *commandtest.Update, s *commandtest.Session, restart func()) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterUpdate(reg, command.UpdateDeps{
		Update: u, Session: s, Restart: restart,
		Daemon: command.DaemonInfo{Version: version.Info{Version: "v0.1.0"}},
	}); err != nil {
		t.Fatal(err)
	}
	return reg
}

func TestAppUpdateAvailabilityAndTitle(t *testing.T) {
	st := func(s v1.UpdateState, target string) *v1.UpdateStatus {
		return &v1.UpdateStatus{State: s, TargetVersion: target, Enabled: true, CurrentVersion: "v0.1.0"}
	}
	tests := []struct {
		name      string
		status    *v1.UpdateStatus
		err       error
		available bool
		title     string
	}{
		{"idle", st(v1.UpdateState_UPDATE_STATE_IDLE, ""), nil, false, "Update Code Foundry"},
		{"available", st(v1.UpdateState_UPDATE_STATE_AVAILABLE, "v0.2.0"), nil, true, "Update to v0.2.0"},
		{"failed retries", st(v1.UpdateState_UPDATE_STATE_FAILED, "v0.2.0"), nil, true, "Update to v0.2.0"},
		{"downloading", st(v1.UpdateState_UPDATE_STATE_DOWNLOADING, "v0.2.0"), nil, false, "Update Code Foundry"},
		{"installed", st(v1.UpdateState_UPDATE_STATE_INSTALLED, "v0.2.0"), nil, false, "Update Code Foundry"},
		{"service down", nil, errors.New("unimplemented"), false, "Update Code Foundry"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := newUpdateRegistry(t, &commandtest.Update{Status: tt.status, Err: tt.err}, &commandtest.Session{}, nil)
			var got *command.Listed
			for _, l := range reg.List(command.Context{}, true) {
				if l.Name == "app.update" {
					got = &l
				}
			}
			if got == nil {
				t.Fatal("app.update not listed")
			}
			if got.Available != tt.available || got.Title != tt.title {
				t.Fatalf("available=%v title=%q, want %v %q", got.Available, got.Title, tt.available, tt.title)
			}
			_, err := reg.Invoke(context.Background(), command.Context{}, "app.update", nil)
			if tt.available != (err == nil) {
				t.Fatalf("Invoke err = %v", err)
			}
			if !tt.available && !errors.Is(err, command.ErrUnavailable) {
				t.Fatalf("Invoke err = %v, want ErrUnavailable", err)
			}
		})
	}
}

func TestAppUpdateCommands(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		command string
		status  *v1.UpdateStatus
		deliver int32
		want    string
	}{
		{"check up to date", "app.update.check", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, Enabled: true, CurrentVersion: "v0.1.0"}, 0, "Code Foundry v0.1.0 is up to date"},
		{"check finds one", "app.update.check", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_AVAILABLE, Enabled: true, TargetVersion: "v0.2.0"}, 0, "v0.2.0 available"},
		{"update", "app.update", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_AVAILABLE, Enabled: true, TargetVersion: "v0.2.0"}, 0, "installing v0.2.0"},
		{"relaunch with a window", "app.relaunch", nil, 1, "relaunching the app"},
		{"relaunch without a window", "app.relaunch", nil, 0, "no app window is connected; open it with `code-foundry gui`"},
		{"version disabled", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, DisabledReason: "dev build"}, 0, "Code Foundry v0.1.0; updates disabled (dev build)"},
		{"version installed", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, Enabled: true, TargetVersion: "v0.2.0"}, 0, "Code Foundry v0.1.0; v0.2.0 installed; daemon restart pending"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := newUpdateRegistry(t, &commandtest.Update{Status: tt.status, Delivered: tt.deliver}, &commandtest.Session{}, nil)
			res, err := reg.Invoke(ctx, command.Context{}, tt.command, nil)
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.want {
				t.Fatalf("message %q, want %q", res.Message, tt.want)
			}
		})
	}
}

func TestDaemonRestart(t *testing.T) {
	ctx := context.Background()
	live := &v1.Session{Id: "s1", State: v1.SessionState_SESSION_STATE_CONNECTED}
	dead := &v1.Session{Id: "s2", State: v1.SessionState_SESSION_STATE_DISCONNECTED}
	tests := []struct {
		name     string
		session  *v1.Session
		status   v1.UpdateState
		restart  bool
		wantMsg  string
		wantErr  error
		restarts int
		// wantConfirm is the confirmation message of an unconfirmed invoke.
		wantConfirm string
	}{
		{"one live session", live, v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, true, "restarting the daemon: closing 1 session; the next client starts the installed version", nil, 1, "Close 1 session and restart the daemon?"},
		{"disconnected sessions do not count", dead, v1.UpdateState_UPDATE_STATE_IDLE, true, "restarting the daemon: closing 0 sessions; the next client starts the installed version", nil, 1, "Close 0 sessions and restart the daemon?"},
		{"refused while installing", live, v1.UpdateState_UPDATE_STATE_DOWNLOADING, true, "", command.ErrUnavailable, 0, "Close 1 session and restart the daemon?"},
		{"no restart hook", live, v1.UpdateState_UPDATE_STATE_IDLE, false, "", nil, 0, "Close 1 session and restart the daemon?"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restarts := 0
			var restart func()
			if tt.restart {
				restart = func() { restarts++ }
			}
			reg := newUpdateRegistry(t, &commandtest.Update{Status: &v1.UpdateStatus{State: tt.status}}, &commandtest.Session{Current: tt.session}, restart)
			// Unconfirmed: asks first, with the live-session count, and does not restart.
			_, err := reg.Invoke(ctx, command.Context{}, "daemon.restart", nil)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || ce.Message != tt.wantConfirm {
				t.Fatalf("unconfirmed err = %v, want ConfirmError %q", err, tt.wantConfirm)
			}
			res, err := reg.Invoke(ctx, command.Context{}, "daemon.restart", nil, command.Confirmed(true))
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case !tt.restart:
				if err == nil || !strings.Contains(err.Error(), "cannot restart") {
					t.Fatalf("err = %v", err)
				}
			default:
				if err != nil || res.Message != tt.wantMsg {
					t.Fatalf("got %q, %v; want %q", res.Message, err, tt.wantMsg)
				}
			}
			if restarts != tt.restarts {
				t.Fatalf("restarts = %d, want %d", restarts, tt.restarts)
			}
		})
	}
}
