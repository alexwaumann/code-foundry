package main

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// updateChannel is the release channel `code-foundry update` follows: the --channel
// flag, else the update.channel setting read from the settings file (the daemon need not
// run).
func updateChannel(flag string) (update.Channel, error) {
	if flag != "" {
		if flag != string(update.ChannelStable) && flag != string(update.ChannelTip) {
			return "", fmt.Errorf("--channel: want stable or tip, got %q", flag)
		}
		return update.Channel(flag), nil
	}
	p, err := paths.Resolve()
	if err != nil {
		return "", err
	}
	return update.ParseChannel(settings.Read(filepath.Join(p.Home(), settings.FileName)).Update.Channel), nil
}

// runUpdate is `code-foundry update` (also `code-foundry --update`). With a daemon
// running it hands the update to the daemon: the daemon downloads and stages it, and
// `code-foundry app restart` installs it while restarting the daemon and the app
// together, so neither ever runs against the other's new version. With no daemon running
// nothing can get out of step, so it runs the embedded installer attached to this
// terminal (it can prompt) and installs at once.
func runUpdate(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("update")
	tag := fs.String("version", "", "install this release (vX.Y.Z) instead of the latest")
	force := fs.Bool("force", false, "reinstall even if already up to date")
	yes := fs.Bool("yes", false, "do not prompt")
	channelFlag := fs.String("channel", "", "release channel to follow: stable or tip (default: the update.channel setting)")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
	}
	channel, err := updateChannel(*channelFlag)
	if err != nil {
		return err
	}

	daemon := runningDaemon(ctx)
	if daemon != nil {
		done, err := cl.updateViaDaemon(ctx, daemon, *tag, *channelFlag, *force)
		if done || err != nil {
			return err
		}
	}

	repo, dir := version.Repo(), version.ReleaseDir()
	var src update.Source
	switch {
	case dir != "":
		src = update.DirSource{Dir: dir}
	case repo != "":
		src = update.GhSource{Repo: repo}
	default:
		return errors.New("this build has no release repository; set " + version.EnvReleaseRepo + "=owner/name")
	}

	// Compare against the install this CLI runs from, else (a dev CLI) the default app
	// directory the installer would use.
	installed := version.Version
	appDir := update.RunningInstall()
	target := appDir
	if target == "" {
		target = update.DefaultAppDir()
	}
	if v, err := update.InstalledVersion(target); err == nil && update.IsSemver(v) {
		installed = v
	} else if appDir == "" {
		installed = "(not installed)"
	}
	if *tag == "" {
		latest, err := src.Latest(ctx, channel)
		if errors.Is(err, update.ErrNoRelease) {
			fmt.Fprintf(cl.stdout, "No %s release has been published yet (%v).\n", channel, err)
			return nil
		}
		if err != nil {
			return fmt.Errorf("check latest release: %w", err)
		}
		*tag = latest
	}
	if !update.IsSemver(*tag) {
		return fmt.Errorf("not a release version: %q", *tag)
	}
	if !*force && update.IsSemver(installed) && !update.Newer(*tag, installed) {
		fmt.Fprintf(cl.stdout, "Code Foundry %s is up to date (latest %s release %s).\n", installed, channel, *tag)
		return nil
	}
	fmt.Fprintf(cl.stdout, "Updating Code Foundry %s -> %s\n", installed, *tag)

	inst := update.ScriptInstaller{
		Repo: repo, ReleaseDir: dir,
		Stdin: os.Stdin, Stdout: cl.stdout, Stderr: cl.stderr,
	}
	if appDir != "" {
		// Update this install, wherever it is, and leave the link and ~/.zshrc alone:
		// the first install set them up, and the link may point at another install.
		inst.AppDir = appDir
		inst.Args = append(inst.Args, "--skip-link", "--skip-path")
	}
	if *yes {
		inst.Args = append(inst.Args, "--yes")
	}
	if *force {
		inst.Args = append(inst.Args, "--force")
	}
	if err := inst.InstallFull(ctx, *tag, nil); err != nil {
		return err
	}
	if daemon != nil {
		cl.afterUpdate(ctx, daemon)
	}
	return nil
}

// runningDaemon returns a client of the daemon running for this home, or nil when none
// answers (it does not start one).
func runningDaemon(ctx context.Context) *client.Client {
	p, err := paths.Resolve()
	if err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c := client.New(p)
	if _, err := c.Ping(ctx); err != nil {
		return nil
	}
	return c
}

// updateViaDaemon hands the update to the running daemon: check, download, follow the
// download's progress, then point at `app restart`. done is false when the daemon cannot
// do what was asked (a specific version or channel it does not offer, --force, updates
// off in the daemon): the caller then installs directly, after the note printed here.
func (cl *cli) updateViaDaemon(ctx context.Context, c *client.Client, tag, channelFlag string, force bool) (done bool, err error) {
	var st *v1.UpdateStatus
	res, err := c.Update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
	switch {
	case err == nil:
		st = res.Msg.GetStatus()
	case connect.CodeOf(err) != connect.CodeFailedPrecondition:
		return true, fmt.Errorf("check latest release: %w", err)
	} // FailedPrecondition: updates are off in the daemon; st stays nil
	var why string
	switch {
	case st == nil || !st.GetEnabled():
		why = "the running daemon does not update itself"
	case force:
		why = "--force reinstalls"
	case channelFlag != "" && channelFlag != st.GetChannel():
		why = "the running daemon follows the " + st.GetChannel() + " channel"
	case tag != "" && tag != st.GetTargetVersion():
		why = "the running daemon offers " + cmp.Or(st.GetTargetVersion(), "nothing newer")
	}
	if why != "" {
		fmt.Fprintf(cl.stdout, "Installing directly (%s). The running app and daemon keep their version until restarted.\n", why)
		return false, nil
	}

	target := st.GetTargetVersion()
	switch st.GetState() {
	case v1.UpdateState_UPDATE_STATE_AVAILABLE, v1.UpdateState_UPDATE_STATE_FAILED:
		fmt.Fprintf(cl.stdout, "Downloading Code Foundry %s (running %s)\n", target, st.GetCurrentVersion())
		dl, err := c.Update.Download(ctx, connect.NewRequest(&v1.DownloadUpdateRequest{}))
		if err != nil {
			return true, fmt.Errorf("download %s: %w", target, err)
		}
		st = dl.Msg.GetStatus()
	case v1.UpdateState_UPDATE_STATE_DOWNLOADING:
		fmt.Fprintf(cl.stdout, "The daemon is already downloading Code Foundry %s\n", target)
	case v1.UpdateState_UPDATE_STATE_INSTALLED, v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED:
		fmt.Fprintf(cl.stdout, "Code Foundry %s is installed; the app and the daemon (%s) run the old version until you restart Code Foundry:\n  code-foundry app restart\n", target, st.GetCurrentVersion())
		return true, nil
	case v1.UpdateState_UPDATE_STATE_DOWNLOADED:
		// Below.
	default:
		msg := "Code Foundry " + st.GetCurrentVersion() + " is up to date"
		if l := st.GetLatestVersion(); l != "" {
			msg += " (latest " + st.GetChannel() + " release " + l + ")"
		}
		fmt.Fprintln(cl.stdout, msg+".")
		return true, nil
	}
	if st.GetState() == v1.UpdateState_UPDATE_STATE_DOWNLOADING {
		if st, err = cl.followDownload(ctx, c); err != nil {
			return true, err
		}
	}
	if st.GetState() != v1.UpdateState_UPDATE_STATE_DOWNLOADED {
		return true, fmt.Errorf("downloading %s failed: %s", target, cmp.Or(st.GetFailureReason(), "the updater is "+st.GetState().String()))
	}
	fmt.Fprintf(cl.stdout, "Downloaded %s. Nothing has changed on disk yet. Install it and restart Code Foundry\n", st.GetTargetVersion())
	fmt.Fprintf(cl.stdout, "(the app and the daemon update together; %s) with:\n", activeThreads(restartCostOf(ctx, c)))
	fmt.Fprintf(cl.stdout, "  code-foundry app restart\n")
	return true, nil
}

// followDownload prints the daemon's download progress until the state leaves
// DOWNLOADING and returns the status it ended in.
func (cl *cli) followDownload(ctx context.Context, c *client.Client) (*v1.UpdateStatus, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	w, err := c.Update.Watch(ctx, connect.NewRequest(&v1.WatchUpdateRequest{}))
	if err != nil {
		return nil, fmt.Errorf("watch the download: %w", err)
	}
	defer func() { _ = w.Close() }()
	var last string
	for w.Receive() {
		st := w.Msg().GetStatus()
		if st == nil {
			continue
		}
		if st.GetState() != v1.UpdateState_UPDATE_STATE_DOWNLOADING {
			return st, nil
		}
		if p := st.GetProgress(); p != "" && p != last {
			fmt.Fprintln(cl.stdout, p)
			last = p
		}
	}
	if err := w.Err(); err != nil {
		return nil, fmt.Errorf("watch the download: %w", err)
	}
	return nil, errors.New("watch the download: the daemon closed the stream")
}

// restartCostOf is what restarting the daemon behind c would cut off (nothing when the
// session list is unavailable).
func restartCostOf(ctx context.Context, c *client.Client) command.RestartCost {
	// Only threads working, waiting on an answer or running background work lose
	// anything to the restart; an idle one starts again with its next message.
	res, err := c.Command.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{Name: "session.list"}))
	if err != nil {
		return command.RestartCost{}
	}
	var list v1.ListSessionsResponse
	if protojson.Unmarshal([]byte(res.Msg.GetResultJson()), &list) != nil {
		return command.RestartCost{}
	}
	return command.RestartCostOf(list.GetSessions())
}

// afterUpdate follows a direct install while a daemon runs: it tells the daemon to
// re-check, so the app shows the install, and says what still runs the old version and
// how to restart it (`app restart`).
func (cl *cli) afterUpdate(ctx context.Context, c *client.Client) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ping, err := c.Ping(ctx)
	if err != nil {
		return
	}
	_, _ = c.Update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
	fmt.Fprintf(cl.stdout, "\nThe app and the daemon (pid %d, %s, %s) keep running the old version\n", ping.GetPid(), ping.GetVersion(), activeThreads(restartCostOf(ctx, c)))
	fmt.Fprintf(cl.stdout, "until you restart Code Foundry (Restart Now in the app, or palette: Restart Code Foundry):\n")
	fmt.Fprintf(cl.stdout, "  code-foundry app restart\n")
}

// activeThreads is the note of what a restart would cut off: "nothing running", or
// "restarting cuts off 1 thread working or waiting on you and 1 background shell"
// (command.RestartCost).
func activeThreads(c command.RestartCost) string {
	if c.Threads == 0 {
		return "nothing running"
	}
	return "restarting cuts off " + c.String()
}
