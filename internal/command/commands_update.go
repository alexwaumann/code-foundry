package command

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// UpdateBackend is the slice of UpdateService the app.* commands need, in generated
// Connect signatures (see TerminalBackend for why).
type UpdateBackend interface {
	Get(context.Context, *connect.Request[v1.GetUpdateStatusRequest]) (*connect.Response[v1.GetUpdateStatusResponse], error)
	Check(context.Context, *connect.Request[v1.CheckForUpdateRequest]) (*connect.Response[v1.CheckForUpdateResponse], error)
	Install(context.Context, *connect.Request[v1.InstallUpdateRequest]) (*connect.Response[v1.InstallUpdateResponse], error)
	Relaunch(context.Context, *connect.Request[v1.RelaunchAppRequest]) (*connect.Response[v1.RelaunchAppResponse], error)
	RequestRestart(context.Context, *connect.Request[v1.RequestRestartRequest]) (*connect.Response[v1.RequestRestartResponse], error)
}

var (
	_ UpdateBackend = codefoundryv1connect.UpdateServiceHandler(nil)
	_ UpdateBackend = codefoundryv1connect.UpdateServiceClient(nil)
)

// UpdateDeps are the dependencies of the app.* commands and daemon.restart.
type UpdateDeps struct {
	Update  UpdateBackend
	Session SessionBackend
	// Restart stops the daemon gracefully (sessions are closed and recorded as
	// disconnected) shortly after the command returns; the next client auto-starts the
	// binary that is installed now. Nil makes daemon.restart and app.restart fail.
	Restart func()
	Daemon  DaemonInfo
}

// AppVersion is app.version's JSON result.
type AppVersion struct {
	Version     string `json:"version"`
	Commit      string `json:"commit,omitempty"`
	ReleaseRepo string `json:"release_repo,omitempty"`
	Update      string `json:"update"`
	Latest      string `json:"latest,omitempty"`
	Target      string `json:"target,omitempty"`
}

// DaemonRestart is daemon.restart's JSON result.
type DaemonRestart struct {
	SessionsClosed int `json:"sessions_closed"`
}

// AppRestart is app.restart's JSON result.
type AppRestart struct {
	SessionsClosed int `json:"sessions_closed"`
	// GUINotified is how many GUI listeners received the restart request; 0 when no
	// window is connected (nothing relaunches; `code-foundry gui` opens one).
	GUINotified int `json:"gui_notified"`
}

// updateStatus reads the updater's status; nil when the service is unavailable.
func updateStatus(ctx context.Context, u UpdateBackend) *v1.UpdateStatus {
	res, err := u.Get(ctx, connect.NewRequest(&v1.GetUpdateStatusRequest{}))
	if err != nil {
		return nil
	}
	return res.Msg.GetStatus()
}

// installable reports whether app.update can run: an update is available, or the last
// install failed and can be retried.
func installable(st *v1.UpdateStatus) bool {
	switch st.GetState() {
	case v1.UpdateState_UPDATE_STATE_AVAILABLE, v1.UpdateState_UPDATE_STATE_FAILED:
		return st.GetTargetVersion() != ""
	}
	return false
}

// UpdateSummary is a one-line description of an update status ("up to date",
// "v0.2.0 available", ...).
func UpdateSummary(st *v1.UpdateStatus) string {
	if st == nil {
		return "updater unavailable"
	}
	if !st.GetEnabled() {
		return "updates disabled (" + st.GetDisabledReason() + ")"
	}
	t := st.GetTargetVersion()
	switch st.GetState() {
	case v1.UpdateState_UPDATE_STATE_AVAILABLE:
		return t + " available"
	case v1.UpdateState_UPDATE_STATE_DOWNLOADING:
		return "installing " + t
	case v1.UpdateState_UPDATE_STATE_INSTALLED:
		return t + " installed; restart Code Foundry to apply"
	case v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED:
		return t + " installed and the app relaunched; restart Code Foundry to apply"
	case v1.UpdateState_UPDATE_STATE_FAILED:
		return "installing " + t + " failed: " + st.GetFailureReason()
	}
	if st.GetLastCheckError() != "" {
		return "last check failed: " + st.GetLastCheckError()
	}
	if st.GetLastCheckedAt() == nil {
		return "not checked yet"
	}
	return "up to date"
}

// LiveSessions counts sessions with a running process (everything but disconnected):
// the ones a daemon restart closes. 0 when the session service is unavailable.
func LiveSessions(ctx context.Context, s SessionBackend) int {
	res, err := s.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil {
		return 0
	}
	n := 0
	for _, x := range res.Msg.GetSessions() {
		if x.GetState() != v1.SessionState_SESSION_STATE_DISCONNECTED {
			n++
		}
	}
	return n
}

// BusySessions counts live sessions whose status is busy: the threads still working,
// which a daemon restart cuts off mid-turn. 0 when the session service is unavailable.
func BusySessions(ctx context.Context, s SessionBackend) int {
	res, err := s.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil {
		return 0
	}
	n := 0
	for _, x := range res.Msg.GetSessions() {
		if x.GetState() != v1.SessionState_SESSION_STATE_DISCONNECTED && x.GetStatus() == v1.SessionStatus_SESSION_STATUS_BUSY {
			n++
		}
	}
	return n
}

// appRestartConfirm is app.restart's confirmation, warning about busy threads.
func appRestartConfirm(busy int) string {
	if busy == 0 {
		return "Restart Code Foundry? Open threads keep their history and can be reconnected."
	}
	verb := "are"
	if busy == 1 {
		verb = "is"
	}
	return fmt.Sprintf("%s %s still working and will be cut off mid-turn. Restart Code Foundry anyway?", plural(busy, "thread"), verb)
}

func plural(n int, word string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", word)
	}
	return fmt.Sprintf("%d %ss", n, word)
}

// RegisterUpdate registers app.version, app.update.check, app.update, app.relaunch,
// app.restart and daemon.restart.
func RegisterUpdate(r *Registry, d UpdateDeps) error {
	return r.RegisterAll(
		Command{
			Name:        "app.version",
			Title:       "Version",
			Description: "Show the running version and whether an update is available.",
			Category:    "App",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				v := d.Daemon.Version
				st := updateStatus(ctx, d.Update)
				msg := "Code Foundry " + v.Version
				if v.Commit != "" {
					msg += " (" + v.Commit + ")"
				}
				summary := UpdateSummary(st)
				return Result{
					Message: msg + "; " + summary,
					JSON: AppVersion{
						Version: v.Version, Commit: v.Commit, ReleaseRepo: st.GetReleaseRepo(),
						Update: summary, Latest: st.GetLatestVersion(), Target: st.GetTargetVersion(),
					},
				}, nil
			},
		},
		Command{
			Name:        "app.update.check",
			Title:       "Check for Updates",
			Description: "Ask GitHub for the latest release now (the daemon also checks every 24 hours).",
			Category:    "App",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
				if err != nil {
					return Result{}, err
				}
				st := res.Msg.GetStatus()
				msg := UpdateSummary(st)
				if st.GetState() == v1.UpdateState_UPDATE_STATE_IDLE {
					msg = "Code Foundry " + st.GetCurrentVersion() + " is up to date"
				}
				return Result{Message: msg, JSON: st}, nil
			},
		},
		Command{
			Name:        "app.update",
			Title:       "Update Code Foundry",
			Description: "Download and install the available update. It applies on `app.restart`; until then the app and daemon keep running the current version.",
			Category:    "App",
			When:        func(Context) bool { return installable(updateStatus(context.Background(), d.Update)) },
			DynamicTitle: func(Context) string {
				if st := updateStatus(context.Background(), d.Update); installable(st) {
					return "Update to " + st.GetTargetVersion()
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Update.Install(ctx, connect.NewRequest(&v1.InstallUpdateRequest{}))
				if err != nil {
					return Result{}, err
				}
				st := res.Msg.GetStatus()
				return Result{Message: "installing " + st.GetTargetVersion(), JSON: st}, nil
			},
		},
		Command{
			Name:        "app.relaunch",
			Title:       "Relaunch App",
			Description: "Quit and reopen the app window, picking up an installed update. Sessions keep running in the daemon.",
			Category:    "App",
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Update.Relaunch(ctx, connect.NewRequest(&v1.RelaunchAppRequest{}))
				if err != nil {
					return Result{}, err
				}
				if res.Msg.GetDelivered() == 0 {
					return Result{Message: "no app window is connected; open it with `code-foundry gui`"}, nil
				}
				return Result{Message: "relaunching the app"}, nil
			},
		},
		Command{
			Name:     "app.restart",
			Title:    "Restart Code Foundry",
			Category: "App",
			Description: "Restart the daemon and relaunch the app so both run the installed version. " +
				"Running threads disconnect, keep their history and can be reconnected.",
			Confirm: appRestartConfirm(0),
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return appRestartConfirm(BusySessions(ctx, d.Session))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				if updateStatus(ctx, d.Update).GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, fmt.Errorf("%w: an update is being installed; restart when it finishes", ErrUnavailable)
				}
				n := LiveSessions(ctx, d.Session)
				// Announce before stopping, so GUIs hear it while the daemon is still up;
				// each relaunches once its Watch stream ends.
				res, err := d.Update.RequestRestart(ctx, connect.NewRequest(&v1.RequestRestartRequest{}))
				if err != nil {
					return Result{}, fmt.Errorf("notify the app: %w", err)
				}
				notified := int(res.Msg.GetDelivered())
				d.Restart()
				msg := fmt.Sprintf("restarting Code Foundry: closing %s; the app relaunches once the daemon has stopped", plural(n, "session"))
				if notified == 0 {
					msg = fmt.Sprintf("restarting the daemon: closing %s; no app window is connected (open it with `code-foundry gui`)", plural(n, "session"))
				}
				return Result{Message: msg, JSON: AppRestart{SessionsClosed: n, GUINotified: notified}}, nil
			},
		},
		Command{
			Name:  "daemon.restart",
			Title: "Restart Daemon",
			Description: "Close every session and restart the daemon, so it runs the installed version. " +
				"Sessions are recorded as disconnected and can be reconnected afterwards.",
			Category: "Daemon",
			Confirm:  "Close every session and restart the daemon?",
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return fmt.Sprintf("Close %s and restart the daemon?", plural(LiveSessions(ctx, d.Session), "session"))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				if updateStatus(ctx, d.Update).GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, fmt.Errorf("%w: an update is being installed; restart when it finishes", ErrUnavailable)
				}
				n := LiveSessions(ctx, d.Session)
				d.Restart()
				return Result{
					Message: fmt.Sprintf("restarting the daemon: closing %s; the next client starts the installed version", plural(n, "session")),
					JSON:    DaemonRestart{SessionsClosed: n},
				}, nil
			},
		},
	)
}
