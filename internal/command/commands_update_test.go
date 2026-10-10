package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/version"
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
		{"version installed", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, Enabled: true, TargetVersion: "v0.2.0"}, 0, "Code Foundry v0.1.0; v0.2.0 installed and the app relaunched; restart Code Foundry to apply"},
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

func TestBusySessions(t *testing.T) {
	sess := func(id string, st v1.SessionState, status v1.SessionStatus) *v1.Session {
		return &v1.Session{Id: id, State: st, Status: status}
	}
	const (
		connected    = v1.SessionState_SESSION_STATE_CONNECTED
		starting     = v1.SessionState_SESSION_STATE_STARTING
		disconnected = v1.SessionState_SESSION_STATE_DISCONNECTED
		busy         = v1.SessionStatus_SESSION_STATUS_BUSY
		idle         = v1.SessionStatus_SESSION_STATUS_IDLE
		attention    = v1.SessionStatus_SESSION_STATUS_NEEDS_ATTENTION
	)
	tests := []struct {
		name     string
		sessions []*v1.Session
		err      error
		want     int
	}{
		{"none", nil, nil, 0},
		{"busy and connected", []*v1.Session{sess("a", connected, busy), sess("b", starting, busy)}, nil, 2},
		{"idle and attention do not count", []*v1.Session{sess("a", connected, idle), sess("b", connected, attention)}, nil, 0},
		{"disconnected busy does not count", []*v1.Session{sess("a", disconnected, busy), sess("b", connected, busy)}, nil, 1},
		{"service down", nil, errors.New("unavailable"), 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := command.BusySessions(context.Background(), &commandtest.Session{Others: tt.sessions, Err: tt.err})
			if got != tt.want {
				t.Fatalf("BusySessions = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestAppRestart(t *testing.T) {
	ctx := context.Background()
	busy := &v1.Session{Id: "s1", State: v1.SessionState_SESSION_STATE_CONNECTED, Status: v1.SessionStatus_SESSION_STATUS_BUSY}
	busy2 := &v1.Session{Id: "s2", State: v1.SessionState_SESSION_STATE_CONNECTED, Status: v1.SessionStatus_SESSION_STATUS_BUSY}
	idle := &v1.Session{Id: "s3", State: v1.SessionState_SESSION_STATE_CONNECTED, Status: v1.SessionStatus_SESSION_STATUS_IDLE}
	dead := &v1.Session{Id: "s4", State: v1.SessionState_SESSION_STATE_DISCONNECTED, Status: v1.SessionStatus_SESSION_STATUS_BUSY}
	const quiet = "Restart Code Foundry? Open threads keep their history and can be reconnected."
	tests := []struct {
		name     string
		sessions []*v1.Session
		status   v1.UpdateState
		restart  bool
		windows  int32
		backErr  bool // RequestRestart fails
		wantMsg  string
		wantJSON command.AppRestart
		wantErr  error
		restarts int
		// wantConfirm is the confirmation message of an unconfirmed invoke.
		wantConfirm string
	}{
		{
			name: "two busy threads", sessions: []*v1.Session{busy, busy2, idle}, status: v1.UpdateState_UPDATE_STATE_INSTALLED, restart: true, windows: 1,
			wantMsg:     "restarting Code Foundry: closing 3 sessions; the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{SessionsClosed: 3, GUINotified: 1},
			restarts:    1,
			wantConfirm: "2 threads are still working and will be cut off mid-turn. Restart Code Foundry anyway?",
		},
		{
			name: "one busy thread", sessions: []*v1.Session{busy}, status: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, restart: true, windows: 1,
			wantMsg:     "restarting Code Foundry: closing 1 session; the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{SessionsClosed: 1, GUINotified: 1},
			restarts:    1,
			wantConfirm: "1 thread is still working and will be cut off mid-turn. Restart Code Foundry anyway?",
		},
		{
			name: "nothing working", sessions: []*v1.Session{idle, dead}, status: v1.UpdateState_UPDATE_STATE_IDLE, restart: true, windows: 2,
			wantMsg:     "restarting Code Foundry: closing 1 session; the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{SessionsClosed: 1, GUINotified: 2},
			restarts:    1,
			wantConfirm: quiet,
		},
		{
			name: "no window connected", status: v1.UpdateState_UPDATE_STATE_INSTALLED, restart: true, windows: 0,
			wantMsg:     "restarting the daemon: closing 0 sessions; no app window is connected (open it with `code-foundry gui`)",
			wantJSON:    command.AppRestart{},
			restarts:    1,
			wantConfirm: quiet,
		},
		{
			name: "refused while installing", sessions: []*v1.Session{busy}, status: v1.UpdateState_UPDATE_STATE_DOWNLOADING, restart: true,
			wantErr:     command.ErrUnavailable,
			wantConfirm: "1 thread is still working and will be cut off mid-turn. Restart Code Foundry anyway?",
		},
		{
			name: "no restart hook", status: v1.UpdateState_UPDATE_STATE_INSTALLED,
			wantConfirm: quiet,
		},
		{
			name: "notify fails", status: v1.UpdateState_UPDATE_STATE_INSTALLED, restart: true, backErr: true,
			wantConfirm: quiet,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u := &commandtest.Update{Status: &v1.UpdateStatus{State: tt.status}, Delivered: tt.windows}
			restarts := 0
			var restart func()
			if tt.restart {
				restart = func() {
					restarts++
					// GUIs are told before the daemon stops.
					if !requested(u, &v1.RequestRestartRequest{}) {
						t.Error("Restart called before RequestRestart")
					}
				}
			}
			reg := newUpdateRegistry(t, u, &commandtest.Session{Others: tt.sessions}, restart)
			// Unconfirmed: asks first, counting busy threads, and neither notifies nor restarts.
			_, err := reg.Invoke(ctx, command.Context{}, "app.restart", nil)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) || ce.Message != tt.wantConfirm {
				t.Fatalf("unconfirmed err = %v, want ConfirmError %q", err, tt.wantConfirm)
			}
			if requested(u, &v1.RequestRestartRequest{}) {
				t.Fatal("unconfirmed invoke notified GUIs")
			}
			if tt.backErr {
				// Every call fails now; an unreadable status is not DOWNLOADING, so Run
				// reaches the notify, which must abort before the restart.
				u.Err = errors.New("unavailable")
			}
			res, err := reg.Invoke(ctx, command.Context{}, "app.restart", nil, command.Confirmed(true))
			switch {
			case tt.wantErr != nil:
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("err = %v, want %v", err, tt.wantErr)
				}
			case !tt.restart:
				if err == nil || !strings.Contains(err.Error(), "cannot restart") {
					t.Fatalf("err = %v", err)
				}
			case tt.backErr:
				if err == nil || !strings.Contains(err.Error(), "notify the app") {
					t.Fatalf("err = %v, want a notify error", err)
				}
			default:
				if err != nil || res.Message != tt.wantMsg {
					t.Fatalf("got %q, %v; want %q", res.Message, err, tt.wantMsg)
				}
				if got, ok := res.JSON.(command.AppRestart); !ok || got != tt.wantJSON {
					t.Fatalf("JSON = %#v, want %#v", res.JSON, tt.wantJSON)
				}
			}
			if restarts != tt.restarts {
				t.Fatalf("restarts = %d, want %d", restarts, tt.restarts)
			}
		})
	}
}

// requested reports whether u received a request of m's type.
func requested(u *commandtest.Update, m proto.Message) bool {
	for _, r := range u.Requests() {
		if r.ProtoReflect().Descriptor().FullName() == m.ProtoReflect().Descriptor().FullName() {
			return true
		}
	}
	return false
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
