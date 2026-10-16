package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
	"github.com/alexwaumann/code-foundry/internal/version"
)

func newUpdateRegistry(t *testing.T, u *commandtest.Update, s *commandtest.Thread, restart func()) *command.Registry {
	t.Helper()
	reg := command.NewRegistry()
	if err := command.RegisterUpdate(reg, command.UpdateDeps{
		Update: u, Thread: s, Restart: restart,
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
		{"idle", st(v1.UpdateState_UPDATE_STATE_IDLE, ""), nil, false, "Download Update"},
		{"available", st(v1.UpdateState_UPDATE_STATE_AVAILABLE, "v0.2.0"), nil, true, "Download v0.2.0"},
		{"failed retries", st(v1.UpdateState_UPDATE_STATE_FAILED, "v0.2.0"), nil, true, "Download v0.2.0"},
		{"downloading", st(v1.UpdateState_UPDATE_STATE_DOWNLOADING, "v0.2.0"), nil, false, "Download Update"},
		{"downloaded", st(v1.UpdateState_UPDATE_STATE_DOWNLOADED, "v0.2.0"), nil, false, "Download Update"},
		{"installed", st(v1.UpdateState_UPDATE_STATE_INSTALLED, "v0.2.0"), nil, false, "Download Update"},
		{"service down", nil, errors.New("unimplemented"), false, "Download Update"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := newUpdateRegistry(t, &commandtest.Update{Status: tt.status, Err: tt.err}, &commandtest.Thread{}, nil)
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
		{"update", "app.update", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_AVAILABLE, Enabled: true, TargetVersion: "v0.2.0"}, 0, "downloading v0.2.0"},
		{"version downloading", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_DOWNLOADING, Enabled: true, TargetVersion: "v0.2.0"}, 0, "Code Foundry v0.1.0; downloading v0.2.0"},
		{"version downloaded", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_DOWNLOADED, Enabled: true, TargetVersion: "v0.2.0"}, 0, "Code Foundry v0.1.0; v0.2.0 downloaded; restart Code Foundry to install it"},
		{"version failed", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_FAILED, Enabled: true, TargetVersion: "v0.2.0", FailureReason: "checksum mismatch"}, 0, "Code Foundry v0.1.0; updating to v0.2.0 failed: checksum mismatch"},
		{"relaunch with a window", "app.relaunch", nil, 1, "relaunching the app"},
		{"relaunch without a window", "app.relaunch", nil, 0, "no app window is connected; open it with `code-foundry gui`"},
		{"version disabled", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, DisabledReason: "dev build"}, 0, "Code Foundry v0.1.0; updates disabled (dev build)"},
		{"version installed", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, Enabled: true, TargetVersion: "v0.2.0"}, 0, "Code Foundry v0.1.0; v0.2.0 installed and the app relaunched; restart Code Foundry to apply"},
		{"check up to date on tip", "app.update.check", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, Enabled: true, CurrentVersion: "v0.2.0-tip.1", LatestVersion: "v0.2.0-tip.1", Channel: "tip"}, 0, "Code Foundry v0.2.0-tip.1 is up to date (tip channel)"},
		{"check finds a tip", "app.update.check", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_AVAILABLE, Enabled: true, TargetVersion: "v0.2.0-tip.1", Channel: "tip"}, 0, "v0.2.0-tip.1 available (tip channel)"},
		{
			"check on stable, older than this tip build", "app.update.check",
			&v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, Enabled: true, CurrentVersion: "v0.15.0-tip.2", LatestVersion: "v0.14.41", Channel: "stable"}, 0,
			"Code Foundry v0.15.0-tip.2 is up to date; stable v0.14.41 is older than this build; the next stable release will move you (stable channel)",
		},
		{
			"version on stable, older than this tip build", "app.version",
			&v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, Enabled: true, CurrentVersion: "v0.15.0-tip.2", LatestVersion: "v0.14.41", Channel: "stable", LastCheckedAt: timestamppb.Now()}, 0,
			"Code Foundry v0.1.0; up to date; stable v0.14.41 is older than this build; the next stable release will move you (stable channel)",
		},
		{"version disabled hides the channel", "app.version", &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, DisabledReason: "dev build", Channel: "tip"}, 0, "Code Foundry v0.1.0; updates disabled (dev build)"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := newUpdateRegistry(t, &commandtest.Update{Status: tt.status, Delivered: tt.deliver}, &commandtest.Thread{}, nil)
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

// A restart cuts off threads by archive's predicate: working, waiting on an answer,
// background agents or shells running, or the turn reporting one that just ended. Idle
// and stopped threads start again with their next message.
func TestRestartCost(t *testing.T) {
	const (
		connected    = v1.ThreadState_THREAD_STATE_CONNECTED
		starting     = v1.ThreadState_THREAD_STATE_STARTING
		disconnected = v1.ThreadState_THREAD_STATE_DISCONNECTED
		busy         = v1.ThreadStatus_THREAD_STATUS_BUSY
		idle         = v1.ThreadStatus_THREAD_STATUS_IDLE
		attention    = v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION
	)
	th := func(st v1.ThreadState, status v1.ThreadStatus, reason string) *v1.Thread {
		return &v1.Thread{State: st, Status: status, StatusReason: reason}
	}
	shells := func(n int32) *v1.Thread {
		return &v1.Thread{State: connected, Status: idle, StatusReason: "at prompt", BackgroundShellsRunning: n}
	}
	tests := []struct {
		name     string
		threads  []*v1.Thread
		want     command.RestartCost
		wantText string
	}{
		{"none", nil, command.RestartCost{}, ""},
		{"busy and starting", []*v1.Thread{th(connected, busy, "working"), th(starting, 0, "")},
			command.RestartCost{Threads: 2, MidTurn: 2}, "2 threads working or waiting on you"},
		{"a permission prompt and a question", []*v1.Thread{th(connected, attention, "permission: Bash ls"), th(connected, attention, "question: Which?")},
			command.RestartCost{Threads: 2, MidTurn: 2}, "2 threads working or waiting on you"},
		{"idle and finished do not count", []*v1.Thread{th(connected, idle, "at prompt"), th(connected, attention, "finished")},
			command.RestartCost{}, ""},
		{"stopped threads do not count", []*v1.Thread{th(disconnected, attention, "permission: x"), {State: disconnected, BackgroundShellsRunning: 1}},
			command.RestartCost{}, ""},
		{"background work counts", []*v1.Thread{shells(2), {State: connected, Status: attention, StatusReason: "finished", BackgroundAgentsRunning: 1}},
			command.RestartCost{Threads: 2, Agents: 1, Shells: 2}, "1 background agent and 2 shells"},
		{"the wake hold counts", []*v1.Thread{{State: connected, Status: idle, BackgroundWakePending: true}},
			command.RestartCost{Threads: 1, Waking: 1}, "1 thread about to report finished background work"},
		{"everything", []*v1.Thread{th(connected, busy, "working"), shells(1), {State: connected, Status: idle, BackgroundWakePending: true}},
			command.RestartCost{Threads: 3, MidTurn: 1, Shells: 1, Waking: 1},
			"1 thread working or waiting on you, 1 background shell and 1 thread about to report finished background work"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := command.RestartCostOf(tt.threads)
			if got != tt.want || got.String() != tt.wantText {
				t.Fatalf("RestartCostOf = %+v %q, want %+v %q", got, got.String(), tt.want, tt.wantText)
			}
		})
	}
}

func TestAppRestart(t *testing.T) {
	ctx := context.Background()
	busy := &v1.Thread{Id: "s1", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	busy2 := &v1.Thread{Id: "s2", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	idle := &v1.Thread{Id: "s3", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE}
	dead := &v1.Thread{Id: "s4", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	asking := &v1.Thread{Id: "s5", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION, StatusReason: "question: Which?"}
	const quiet = "Restart Code Foundry? Threads keep their history; a message starts each again."
	tests := []struct {
		name    string
		threads []*v1.Thread
		status  v1.UpdateState
		restart bool
		windows int32
		backErr bool // RequestRestart fails
		// installErr fails Install (the status is DOWNLOADED).
		installErr error
		wantMsg    string
		wantJSON   command.AppRestart
		wantErr    error
		restarts   int
		// wantConfirm is the confirmation message of an unconfirmed invoke.
		wantConfirm string
	}{
		{
			name: "two busy threads and a question", threads: []*v1.Thread{busy, busy2, idle, asking}, status: v1.UpdateState_UPDATE_STATE_INSTALLED, restart: true, windows: 1,
			wantMsg:     "restarting Code Foundry (cuts off 3 threads working or waiting on you); the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{ThreadsInterrupted: 3, GUINotified: 1},
			restarts:    1,
			wantConfirm: "3 threads working or waiting on you will be cut off. Restart Code Foundry anyway?",
		},
		{
			name: "one busy thread", threads: []*v1.Thread{busy}, status: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, restart: true, windows: 1,
			wantMsg:     "restarting Code Foundry (cuts off 1 thread working or waiting on you); the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{ThreadsInterrupted: 1, GUINotified: 1},
			restarts:    1,
			wantConfirm: "1 thread working or waiting on you will be cut off. Restart Code Foundry anyway?",
		},
		{
			name: "nothing working", threads: []*v1.Thread{idle, dead}, status: v1.UpdateState_UPDATE_STATE_IDLE, restart: true, windows: 2,
			wantMsg:     "restarting Code Foundry; the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{GUINotified: 2},
			restarts:    1,
			wantConfirm: quiet,
		},
		{
			name: "no window connected", status: v1.UpdateState_UPDATE_STATE_INSTALLED, restart: true, windows: 0,
			wantMsg:     "restarting the daemon; no app window is connected (open it with `code-foundry gui`)",
			wantJSON:    command.AppRestart{},
			restarts:    1,
			wantConfirm: quiet,
		},
		{
			name: "refused while downloading", threads: []*v1.Thread{busy}, status: v1.UpdateState_UPDATE_STATE_DOWNLOADING, restart: true,
			wantErr:     command.ErrUnavailable,
			wantConfirm: "1 thread working or waiting on you will be cut off. Restart Code Foundry anyway?",
		},
		{
			name: "installs a download first", threads: []*v1.Thread{busy}, status: v1.UpdateState_UPDATE_STATE_DOWNLOADED, restart: true, windows: 1,
			wantMsg:     "installed v0.2.0; restarting Code Foundry (cuts off 1 thread working or waiting on you); the app relaunches once the daemon has stopped",
			wantJSON:    command.AppRestart{ThreadsInterrupted: 1, GUINotified: 1, Installed: "v0.2.0"},
			restarts:    1,
			wantConfirm: "1 thread working or waiting on you will be cut off. Install v0.2.0 and restart Code Foundry anyway?",
		},
		{
			name: "installs a download, no window", status: v1.UpdateState_UPDATE_STATE_DOWNLOADED, restart: true,
			wantMsg:     "installed v0.2.0; restarting the daemon; no app window is connected (open it with `code-foundry gui`)",
			wantJSON:    command.AppRestart{Installed: "v0.2.0"},
			restarts:    1,
			wantConfirm: "Install v0.2.0 and restart Code Foundry? Threads keep their history; a message starts each again.",
		},
		{
			name: "a failed install restarts nothing", status: v1.UpdateState_UPDATE_STATE_DOWNLOADED, restart: true, windows: 1,
			installErr:  errors.New("installer: exit status 1: error: no staged download"),
			wantConfirm: "Install v0.2.0 and restart Code Foundry? Threads keep their history; a message starts each again.",
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
			u := &commandtest.Update{Status: &v1.UpdateStatus{State: tt.status, TargetVersion: "v0.2.0"}, Delivered: tt.windows, InstallErr: tt.installErr}
			restarts := 0
			var restart func()
			if tt.restart {
				restart = func() {
					restarts++
					// GUIs are told before the daemon stops.
					if !requested(u, &v1.RequestRestartRequest{}) {
						t.Error("Restart called before RequestRestart")
					}
					if tt.status == v1.UpdateState_UPDATE_STATE_DOWNLOADED && !requested(u, &v1.InstallUpdateRequest{}) {
						t.Error("Restart called before Install")
					}
				}
			}
			reg := newUpdateRegistry(t, u, &commandtest.Thread{Others: tt.threads}, restart)
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
			case tt.installErr != nil:
				if !errors.Is(err, tt.installErr) || !strings.Contains(err.Error(), "install v0.2.0: ") {
					t.Fatalf("err = %v, want the install error", err)
				}
				if requested(u, &v1.RequestRestartRequest{}) {
					t.Fatal("a failed install still notified GUIs")
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
			if tt.status != v1.UpdateState_UPDATE_STATE_DOWNLOADED && requested(u, &v1.InstallUpdateRequest{}) {
				t.Fatal("installed without a download")
			}
		})
	}
}

func TestAppRestartTitle(t *testing.T) {
	tests := []struct {
		state v1.UpdateState
		want  string
	}{
		{v1.UpdateState_UPDATE_STATE_DOWNLOADED, "Install v0.2.0 and Restart"},
		{v1.UpdateState_UPDATE_STATE_INSTALLED, "Restart Code Foundry"},
		{v1.UpdateState_UPDATE_STATE_IDLE, "Restart Code Foundry"},
	}
	for _, tt := range tests {
		t.Run(tt.state.String(), func(t *testing.T) {
			reg := newUpdateRegistry(t, &commandtest.Update{Status: &v1.UpdateStatus{State: tt.state, TargetVersion: "v0.2.0"}}, &commandtest.Thread{}, func() {})
			for _, l := range reg.List(command.Context{}, true) {
				if l.Name == "app.restart" {
					if l.Title != tt.want {
						t.Fatalf("title %q, want %q", l.Title, tt.want)
					}
					return
				}
			}
			t.Fatal("app.restart not listed")
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
	live := &v1.Thread{Id: "s1", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	idle := &v1.Thread{Id: "s3", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE}
	dead := &v1.Thread{Id: "s2", State: v1.ThreadState_THREAD_STATE_DISCONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_BUSY}
	const quiet = "Restart the daemon? Threads keep their history; a message starts each again."
	const one = "1 thread working or waiting on you will be cut off. Restart the daemon anyway?"
	shell := &v1.Thread{Id: "s4", State: v1.ThreadState_THREAD_STATE_CONNECTED, Status: v1.ThreadStatus_THREAD_STATUS_IDLE, BackgroundShellsRunning: 1}
	tests := []struct {
		name     string
		thread   *v1.Thread
		status   v1.UpdateState
		restart  bool
		wantMsg  string
		wantErr  error
		restarts int
		// wantConfirm is the confirmation message of an unconfirmed invoke.
		wantConfirm string
	}{
		{"one working thread", live, v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED, true, "restarting the daemon (cuts off 1 thread working or waiting on you); the next client starts the installed version", nil, 1, one},
		{"background work is cut off too", shell, v1.UpdateState_UPDATE_STATE_IDLE, true, "restarting the daemon (cuts off 1 background shell); the next client starts the installed version", nil, 1,
			"1 background shell will be cut off. Restart the daemon anyway?"},
		{"an idle running thread does not count", idle, v1.UpdateState_UPDATE_STATE_IDLE, true, "restarting the daemon; the next client starts the installed version", nil, 1, quiet},
		{"stopped threads do not count", dead, v1.UpdateState_UPDATE_STATE_IDLE, true, "restarting the daemon; the next client starts the installed version", nil, 1, quiet},
		{"refused while downloading", live, v1.UpdateState_UPDATE_STATE_DOWNLOADING, true, "", command.ErrUnavailable, 0, one},
		{"a download is not installed", idle, v1.UpdateState_UPDATE_STATE_DOWNLOADED, true, "restarting the daemon; the next client starts the installed version", nil, 1, quiet},
		{"no restart hook", live, v1.UpdateState_UPDATE_STATE_IDLE, false, "", nil, 0, one},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restarts := 0
			var restart func()
			if tt.restart {
				restart = func() { restarts++ }
			}
			reg := newUpdateRegistry(t, &commandtest.Update{Status: &v1.UpdateStatus{State: tt.status}}, &commandtest.Thread{Current: tt.thread}, restart)
			// Unconfirmed: asks first, with the live-thread count, and does not restart.
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
