package command

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/update"
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
	// Restart stops the daemon gracefully (Claude stops in every thread; a message
	// starts it again) shortly after the command returns; the next client auto-starts
	// the binary that is installed now. Nil makes daemon.restart and app.restart fail.
	Restart func()
	Daemon  DaemonInfo
}

// AppVersion is app.version's JSON result.
type AppVersion struct {
	Version     string `json:"version"`
	Commit      string `json:"commit,omitempty"`
	ReleaseRepo string `json:"release_repo,omitempty"`
	// Channel is the release channel the updater follows: "stable" or "tip".
	Channel string `json:"channel,omitempty"`
	Update  string `json:"update"`
	Latest  string `json:"latest,omitempty"`
	Target  string `json:"target,omitempty"`
}

// DaemonRestart is daemon.restart's JSON result. ThreadsInterrupted counts the threads
// the restart cut off (ActiveSession).
type DaemonRestart struct {
	ThreadsInterrupted int `json:"threads_interrupted"`
}

// AppRestart is app.restart's JSON result.
type AppRestart struct {
	ThreadsInterrupted int `json:"threads_interrupted"` // as DaemonRestart's
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
	if note := olderStable(st); note != "" {
		return "up to date; " + note
	}
	return "up to date"
}

// olderStable explains an up-to-date status on the stable channel whose latest stable
// release is older than the running build (after a switch from tip): "stable v0.14.41
// is older than this build; the next stable release will move you". "" otherwise.
func olderStable(st *v1.UpdateStatus) string {
	latest := st.GetLatestVersion()
	if st.GetChannel() != string(update.ChannelStable) || !update.Newer(st.GetCurrentVersion(), latest) {
		return ""
	}
	return "stable " + latest + " is older than this build; the next stable release will move you"
}

// channelSuffix is " (tip channel)" for an enabled updater, "" otherwise.
func channelSuffix(st *v1.UpdateStatus) string {
	if !st.GetEnabled() || st.GetChannel() == "" {
		return ""
	}
	return " (" + st.GetChannel() + " channel)"
}

// ActiveSession reports whether a restart cuts s off: Claude is starting or running a
// turn, or waits on a permission request or question (midTurn). An idle thread loses
// nothing: a message starts it again.
func ActiveSession(s *v1.Session) bool { return midTurn(s) != "" }

// ActiveSessions counts the threads a restart cuts off (ActiveSession). 0 when the
// session service is unavailable.
func ActiveSessions(ctx context.Context, s SessionBackend) int {
	res, err := s.List(ctx, connect.NewRequest(&v1.ListSessionsRequest{}))
	if err != nil {
		return 0
	}
	n := 0
	for _, x := range res.Msg.GetSessions() {
		if ActiveSession(x) {
			n++
		}
	}
	return n
}

// restartConfirm is app.restart's and daemon.restart's confirmation ("Restart
// Code Foundry", "Restart the daemon"), warning about the active threads.
func restartConfirm(what string, active int) string {
	if active == 0 {
		return what + "? Threads keep their history; a message starts each again."
	}
	verb := "are"
	if active == 1 {
		verb = "is"
	}
	return fmt.Sprintf("%s %s working or waiting on you and will be cut off. %s anyway?", plural(active, "thread"), verb, what)
}

// cutOff is " (2 threads cut off)" for a restart's result, "" for none.
func cutOff(active int) string {
	if active == 0 {
		return ""
	}
	return " (" + plural(active, "thread") + " cut off)"
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
					Message: msg + "; " + summary + channelSuffix(st),
					JSON: AppVersion{
						Version: v.Version, Commit: v.Commit, ReleaseRepo: st.GetReleaseRepo(), Channel: st.GetChannel(),
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
					if note := olderStable(st); note != "" {
						msg += "; " + note
					}
				}
				msg += channelSuffix(st)
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
				"Threads keep their history and a message starts each again; one that is working is cut off.",
			Confirm: restartConfirm("Restart Code Foundry", 0),
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return restartConfirm("Restart Code Foundry", ActiveSessions(ctx, d.Session))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				if updateStatus(ctx, d.Update).GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, fmt.Errorf("%w: an update is being installed; restart when it finishes", ErrUnavailable)
				}
				n := ActiveSessions(ctx, d.Session)
				// Announce before stopping, so GUIs hear it while the daemon is still up;
				// each relaunches once its Watch stream ends.
				res, err := d.Update.RequestRestart(ctx, connect.NewRequest(&v1.RequestRestartRequest{}))
				if err != nil {
					return Result{}, fmt.Errorf("notify the app: %w", err)
				}
				notified := int(res.Msg.GetDelivered())
				d.Restart()
				msg := "restarting Code Foundry" + cutOff(n) + "; the app relaunches once the daemon has stopped"
				if notified == 0 {
					msg = "restarting the daemon" + cutOff(n) + "; no app window is connected (open it with `code-foundry gui`)"
				}
				return Result{Message: msg, JSON: AppRestart{ThreadsInterrupted: n, GUINotified: notified}}, nil
			},
		},
		Command{
			Name:  "daemon.restart",
			Title: "Restart Daemon",
			Description: "Restart the daemon, so it runs the installed version. " +
				"Threads keep their history and a message starts each again; one that is working is cut off.",
			Category: "Daemon",
			Confirm:  restartConfirm("Restart the daemon", 0),
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return restartConfirm("Restart the daemon", ActiveSessions(ctx, d.Session))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				if updateStatus(ctx, d.Update).GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, fmt.Errorf("%w: an update is being installed; restart when it finishes", ErrUnavailable)
				}
				n := ActiveSessions(ctx, d.Session)
				d.Restart()
				return Result{
					Message: "restarting the daemon" + cutOff(n) + "; the next client starts the installed version",
					JSON:    DaemonRestart{ThreadsInterrupted: n},
				}, nil
			},
		},
	)
}
