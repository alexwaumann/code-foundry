package main

import (
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
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// runUpdate is `code-foundry update` (also `code-foundry --update`): checks the latest
// release and runs the embedded installer attached to this terminal, so it can prompt.
// It never restarts anything; it tells the running daemon to re-check, which then shows
// "installed" in the app.
func runUpdate(ctx context.Context, cl *cli, args []string) error {
	fs := cl.newFlagSet("update")
	tag := fs.String("version", "", "install this release (vX.Y.Z) instead of the latest")
	force := fs.Bool("force", false, "reinstall even if already up to date")
	yes := fs.Bool("yes", false, "do not prompt")
	if err := cl.parseFlags(fs, args); err != nil {
		return quietHelp(err)
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

	// Compare against the installed app: the bundle this CLI lives in, else (standalone
	// CLI) the default install location.
	installed := version.Version
	bundle := update.RunningBundle()
	target := bundle
	if target == "" {
		if home, err := os.UserHomeDir(); err == nil {
			target = filepath.Join(home, "Applications", update.BundleName)
		}
	}
	if v, err := update.BundleVersion(target); err == nil && update.IsSemver(v) {
		installed = v
	} else if bundle == "" {
		installed = "(not installed)"
	}
	if *tag == "" {
		latest, err := src.Latest(ctx)
		if errors.Is(err, update.ErrNoRelease) {
			fmt.Fprintf(cl.stdout, "No release has been published yet (%v).\n", err)
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
		fmt.Fprintf(cl.stdout, "Code Foundry %s is up to date (latest release %s).\n", installed, *tag)
		return nil
	}
	fmt.Fprintf(cl.stdout, "Updating Code Foundry %s -> %s\n", installed, *tag)

	inst := update.ScriptInstaller{
		Repo: repo, ReleaseDir: dir,
		Stdin: os.Stdin, Stdout: cl.stdout, Stderr: cl.stderr,
	}
	if bundle != "" {
		inst.AppDir = filepath.Dir(bundle)
	}
	if *yes {
		inst.Args = append(inst.Args, "--yes")
	}
	if *force {
		inst.Args = append(inst.Args, "--force")
	}
	if err := inst.Install(ctx, *tag, nil); err != nil {
		return err
	}
	cl.afterUpdate(ctx)
	return nil
}

// afterUpdate tells a running daemon (without starting one) to re-check, so the app
// shows the installed update, and says what still runs the old version.
func (cl *cli) afterUpdate(ctx context.Context) {
	p, err := paths.Resolve()
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	c := client.New(p)
	ping, err := c.Ping(ctx)
	if err != nil {
		return // no daemon running: the next one starts from the new bundle
	}
	_, _ = c.Update.Check(ctx, connect.NewRequest(&v1.CheckForUpdateRequest{}))
	sessions := 0
	if res, err := c.Command.Invoke(ctx, connect.NewRequest(&v1.InvokeCommandRequest{Name: "session.list"})); err == nil {
		var list v1.ListSessionsResponse
		if protojson.Unmarshal([]byte(res.Msg.GetResultJson()), &list) == nil {
			for _, s := range list.GetSessions() {
				if s.GetState() != v1.SessionState_SESSION_STATE_DISCONNECTED {
					sessions++
				}
			}
		}
	}
	fmt.Fprintf(cl.stdout, "\nRelaunch the app to use the new version (palette: Relaunch App).\n")
	fmt.Fprintf(cl.stdout, "The daemon (pid %d, %s) keeps running %d session(s) on the old version until:\n", ping.GetPid(), ping.GetVersion(), sessions)
	fmt.Fprintf(cl.stdout, "  code-foundry daemon restart\n")
}
