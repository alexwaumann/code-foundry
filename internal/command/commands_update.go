package command

import (
	"context"
	"errors"
	"fmt"
	"strings"

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
	Download(context.Context, *connect.Request[v1.DownloadUpdateRequest]) (*connect.Response[v1.DownloadUpdateResponse], error)
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
	Update UpdateBackend
	Thread ThreadBackend
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
// the restart cut off (ActiveThread).
type DaemonRestart struct {
	ThreadsInterrupted int `json:"threads_interrupted"`
}

// AppRestart is app.restart's JSON result.
type AppRestart struct {
	ThreadsInterrupted int `json:"threads_interrupted"` // as DaemonRestart's
	// GUINotified is how many GUI listeners received the restart request; 0 when no
	// window is connected (nothing relaunches; `code-foundry gui` opens one).
	GUINotified int `json:"gui_notified"`
	// Installed is the downloaded version the restart installed first ("" when nothing
	// was downloaded).
	Installed string `json:"installed,omitempty"`
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
// download or install failed and can be retried.
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
		return "downloading " + t
	case v1.UpdateState_UPDATE_STATE_DOWNLOADED:
		return t + " downloaded; restart Code Foundry to install it"
	case v1.UpdateState_UPDATE_STATE_INSTALLED:
		return t + " installed; restart Code Foundry to apply"
	case v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED:
		return t + " installed and the app relaunched; restart Code Foundry to apply"
	case v1.UpdateState_UPDATE_STATE_FAILED:
		return "updating to " + t + " failed: " + st.GetFailureReason()
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

// ActiveThread reports whether a restart cuts s off, by the predicate archive and
// snooze confirm with (archiveInterrupts): Claude starting or running a turn, waiting on
// a permission request or question, background agents or shells running, or the turn
// that reports one that just ended. An idle thread loses nothing: a message starts it
// again.
func ActiveThread(s *v1.Thread) bool {
	why, _ := archiveInterrupts(s)
	return why != ""
}

// RestartCost is what a restart cuts off, summed over the threads (ActiveThread).
type RestartCost struct {
	// Threads is how many threads lose something.
	Threads int
	// MidTurn counts threads working or waiting on the user; Agents and Shells the
	// background runs and shells of running threads; Waking threads about to report
	// background work that just ended (and running none).
	MidTurn, Agents, Shells, Waking int
}

// RestartCostOf sums what a restart would cut off.
func RestartCostOf(threads []*v1.Thread) RestartCost {
	var c RestartCost
	for _, s := range threads {
		if !ActiveThread(s) {
			continue
		}
		c.Threads++
		agents, shells := int(s.GetBackgroundAgentsRunning()), int(s.GetBackgroundShellsRunning())
		c.Agents, c.Shells = c.Agents+agents, c.Shells+shells
		switch {
		case midTurn(s) != "":
			c.MidTurn++
		case agents+shells == 0 && s.GetBackgroundWakePending():
			c.Waking++
		}
	}
	return c
}

// String names what is cut off: "1 thread working or waiting on you and 2 background
// agents", "1 background shell", "1 thread about to report finished background work";
// "" for nothing.
func (c RestartCost) String() string {
	var parts []string
	if c.MidTurn > 0 {
		parts = append(parts, plural(c.MidTurn, "thread")+" working or waiting on you")
	}
	if w := backgroundWork(c.Agents, c.Shells); w != "" {
		parts = append(parts, w)
	}
	if c.Waking > 0 {
		parts = append(parts, plural(c.Waking, "thread")+" about to report finished background work")
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

// restartCost is RestartCostOf the daemon's threads; nothing when the thread service
// is unavailable.
func restartCost(ctx context.Context, s ThreadBackend) RestartCost {
	res, err := s.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{}))
	if err != nil {
		return RestartCost{}
	}
	return RestartCostOf(res.Msg.GetThreads())
}

// restartConfirm is app.restart's and daemon.restart's confirmation ("Restart
// Code Foundry", "Restart the daemon"), naming what the restart cuts off.
func restartConfirm(what string, c RestartCost) string {
	if c.Threads == 0 {
		return what + "? Threads keep their history; a message starts each again."
	}
	return c.String() + " will be cut off. " + what + " anyway?"
}

// cutOff is " (cuts off 1 thread working or waiting on you)" for a restart's result, ""
// for nothing.
func cutOff(c RestartCost) string {
	if c.Threads == 0 {
		return ""
	}
	return " (cuts off " + c.String() + ")"
}

// downloadedTarget is the version app.restart installs first: the target while the
// status is DOWNLOADED, else "".
func downloadedTarget(st *v1.UpdateStatus) string {
	if st.GetState() != v1.UpdateState_UPDATE_STATE_DOWNLOADED {
		return ""
	}
	return st.GetTargetVersion()
}

// restartWhat is app.restart's action for the confirm: "Install vX and restart Code
// Foundry" with a download pending, else "Restart Code Foundry".
func restartWhat(st *v1.UpdateStatus) string {
	if t := downloadedTarget(st); t != "" {
		return "Install " + t + " and restart Code Foundry"
	}
	return "Restart Code Foundry"
}

// errDownloading refuses a restart while a download runs: the new daemon would start
// without it.
var errDownloading = fmt.Errorf("%w: an update is downloading; restart when it finishes", ErrUnavailable)

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
			Name:         "app.version",
			Title:        "Version",
			Description:  "Show the running version and whether an update is available.",
			Category:     "App",
			NoKeybinding: true,
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
			Name:  "app.update",
			Title: "Download Update",
			Description: "Download the available update in the background. Nothing changes on disk until `app.restart` installs it and restarts; " +
				"until then the app and daemon keep running the current version.",
			Category: "App",
			When:     func(Context) bool { return installable(updateStatus(context.Background(), d.Update)) },
			DynamicTitle: func(Context) string {
				if st := updateStatus(context.Background(), d.Update); installable(st) {
					return "Download " + st.GetTargetVersion()
				}
				return ""
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				res, err := d.Update.Download(ctx, connect.NewRequest(&v1.DownloadUpdateRequest{}))
				if err != nil {
					return Result{}, err
				}
				st := res.Msg.GetStatus()
				return Result{Message: "downloading " + st.GetTargetVersion(), JSON: st}, nil
			},
		},
		Command{
			Name:        "app.relaunch",
			Title:       "Relaunch App",
			Description: "Quit and reopen the app window, picking up an installed update. Threads keep running in the daemon.",
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
			Description: "Restart the daemon and relaunch the app so both run the installed version, installing a downloaded update first. " +
				"Threads keep their history and a message starts each again; a turn or background work running is cut off.",
			DynamicTitle: func(Context) string {
				if t := downloadedTarget(updateStatus(context.Background(), d.Update)); t != "" {
					return "Install " + t + " and Restart"
				}
				return ""
			},
			Confirm: restartConfirm("Restart Code Foundry", RestartCost{}),
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return restartConfirm(restartWhat(updateStatus(ctx, d.Update)), restartCost(ctx, d.Thread))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				st := updateStatus(ctx, d.Update)
				if st.GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, errDownloading
				}
				// Install the download now, while both processes are about to go down
				// together: the window relaunched below and the daemon started after this
				// one exits run the same new version. A failed install restarts nothing.
				installed := downloadedTarget(st)
				if installed != "" {
					if _, err := d.Update.Install(ctx, connect.NewRequest(&v1.InstallUpdateRequest{})); err != nil {
						return Result{}, fmt.Errorf("install %s: %w", installed, err)
					}
				}
				n := restartCost(ctx, d.Thread)
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
				if installed != "" {
					msg = "installed " + installed + "; " + msg
				}
				return Result{Message: msg, JSON: AppRestart{ThreadsInterrupted: n.Threads, GUINotified: notified, Installed: installed}}, nil
			},
		},
		Command{
			Name:  "daemon.restart",
			Title: "Restart Daemon",
			Description: "Restart the daemon, so it runs the installed version. " +
				"Threads keep their history and a message starts each again; a turn or background work running is cut off.",
			Category: "Daemon",
			Confirm:  restartConfirm("Restart the daemon", RestartCost{}),
			DynamicConfirm: func(ctx context.Context, _ Context, _ Args) string {
				return restartConfirm("Restart the daemon", restartCost(ctx, d.Thread))
			},
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				if d.Restart == nil {
					return Result{}, errors.New("this daemon cannot restart itself")
				}
				// It does not install a download: the daemon alone would then run a version
				// the open window does not (`app.restart` changes both).
				if updateStatus(ctx, d.Update).GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
					return Result{}, errDownloading
				}
				n := restartCost(ctx, d.Thread)
				d.Restart()
				return Result{
					Message: "restarting the daemon" + cutOff(n) + "; the next client starts the installed version",
					JSON:    DaemonRestart{ThreadsInterrupted: n.Threads},
				}, nil
			},
		},
	)
}
