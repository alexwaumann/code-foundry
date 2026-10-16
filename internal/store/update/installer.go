package update

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/version"
	"github.com/alexwaumann/code-foundry/scripts"
)

// Installer installs a release in two steps, so the install on disk changes only when
// the daemon and the window are about to restart together.
type Installer interface {
	// Download stages tag beside the app directory (<app>.new, StageDir) without
	// touching the install, reporting each line of progress.
	Download(ctx context.Context, tag string, progress func(line string)) error
	// Install swaps a previously downloaded tag into the app directory. Fast; no network.
	Install(ctx context.Context, tag string) error
}

// Installer run bounds: a download includes the network; applying a staged download is
// two renames.
const (
	downloadTimeout = 10 * time.Minute
	applyTimeout    = time.Minute
)

// ScriptInstaller runs the installer embedded in the binary (scripts/install.sh):
// Download with --stage-only, Install with --apply-staged, InstallFull with neither.
// Non-interactive runs (no Stdin) pass --yes (no prompts), --skip-path and --skip-link
// (the first install set up PATH and the code-foundry link; an update must not edit
// ~/.zshrc or repoint a link that may belong to another install).
type ScriptInstaller struct {
	// Script is the installer; scripts.InstallSh when nil.
	Script []byte
	// Repo is passed as CODE_FOUNDRY_RELEASE_REPO.
	Repo string
	// ReleaseDir, when set, is passed as CODE_FOUNDRY_RELEASE_DIR (local release source).
	ReleaseDir string
	// AppDir is the app directory to replace (--app-dir); the installer's default
	// (~/Applications) when empty.
	AppDir string
	// Gh is passed as CODE_FOUNDRY_GH; gh.LookPath() when empty. A Finder-launched daemon
	// may not have gh on PATH.
	Gh string
	// Args are extra installer arguments (tests).
	Args []string
	// Stdin, Stdout, Stderr make the run interactive (`code-foundry update`): when Stdin
	// is set, --yes is not passed and output goes to Stdout/Stderr instead of progress.
	Stdin          io.Reader
	Stdout, Stderr io.Writer
}

var _ Installer = ScriptInstaller{}

// Download implements Installer: install.sh --stage-only.
func (i ScriptInstaller) Download(ctx context.Context, tag string, progress func(string)) error {
	return i.run(ctx, tag, "--stage-only", downloadTimeout, progress)
}

// Install implements Installer: install.sh --apply-staged.
func (i ScriptInstaller) Install(ctx context.Context, tag string) error {
	return i.run(ctx, tag, "--apply-staged", applyTimeout, nil)
}

// InstallFull downloads and installs tag in one run (`code-foundry update` with no
// daemon running, so nothing can run the old version meanwhile).
func (i ScriptInstaller) InstallFull(ctx context.Context, tag string, progress func(string)) error {
	return i.run(ctx, tag, "", downloadTimeout, progress)
}

// run runs the installer for tag with the mode flag (none for a full install). timeout
// bounds a non-interactive run.
func (i ScriptInstaller) run(ctx context.Context, tag, mode string, timeout time.Duration, progress func(string)) error {
	script := i.Script
	if script == nil {
		script = scripts.InstallSh
	}
	f, err := os.CreateTemp("", "code-foundry-install-*.sh")
	if err != nil {
		return fmt.Errorf("installer: %w", err)
	}
	defer func() { _ = os.Remove(f.Name()) }()
	if _, err := f.Write(script); err != nil {
		_ = f.Close()
		return fmt.Errorf("installer: write: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("installer: write: %w", err)
	}

	interactive := i.Stdin != nil
	args := []string{f.Name(), "--version", tag}
	if mode != "" {
		args = append(args, mode)
	}
	if !interactive {
		args = append(args, "--yes", "--skip-path", "--skip-link")
	}
	if i.AppDir != "" {
		args = append(args, "--app-dir", i.AppDir)
	}
	args = append(args, i.Args...)

	if !interactive {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "/bin/bash", args...)
	cmd.Env = i.env()
	cmd.WaitDelay = 5 * time.Second

	if interactive {
		// Stays in the terminal's foreground process group: the installer prompts on
		// /dev/tty, and a background group reading it is stopped with SIGTTIN.
		cmd.Stdin, cmd.Stdout, cmd.Stderr = i.Stdin, i.Stdout, i.Stderr
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("installer: %w", err)
		}
		return nil
	}

	// Its own process group, so cancelling kills gh and tar too, not just bash.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM) }
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("installer: %w", err)
	}
	tail := make(chan []string, 1)
	go func() {
		var last []string
		sc := bufio.NewScanner(pr)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			if progress != nil {
				progress(line)
			}
			last = append(last, line)
			if len(last) > 3 {
				last = last[1:]
			}
		}
		_, _ = io.Copy(io.Discard, pr)
		tail <- last
	}()
	err = cmd.Wait()
	_ = pw.Close()
	last := <-tail
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			err = ctxErr
		}
		if len(last) > 0 {
			return fmt.Errorf("installer: %w: %s", err, strings.Join(last, " / "))
		}
		return fmt.Errorf("installer: %w", err)
	}
	return nil
}

// env is the daemon's environment plus the installer's inputs. PATH gains gh's
// directory and the system directories the script needs (tar, shasum, xattr).
func (i ScriptInstaller) env() []string {
	repo := i.Repo
	if repo == "" {
		repo = version.Repo()
	}
	ghPath := i.Gh
	if ghPath == "" {
		ghPath, _ = gh.LookPath()
	}
	path := os.Getenv("PATH")
	for _, dir := range []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"} {
		if !strings.Contains(":"+path+":", ":"+dir+":") {
			path += ":" + dir
		}
	}
	if ghPath != "" {
		path = filepath.Dir(ghPath) + ":" + path
	}
	env := make([]string, 0, len(os.Environ())+4)
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch k {
		case "PATH", version.EnvReleaseRepo, version.EnvReleaseDir, "CODE_FOUNDRY_GH":
			continue
		}
		env = append(env, kv)
	}
	env = append(env, "PATH="+path, version.EnvReleaseRepo+"="+repo, "GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1")
	if ghPath != "" {
		env = append(env, "CODE_FOUNDRY_GH="+ghPath)
	}
	if i.ReleaseDir != "" {
		env = append(env, version.EnvReleaseDir+"="+i.ReleaseDir)
	}
	return env
}

// errInstalledMismatch is returned when the installer succeeded but the install on disk
// does not report the requested version.
var errInstalledMismatch = errors.New("installed app reports a different version")

// errStagedMismatch is returned when a download succeeded but the staged directory does
// not hold the requested version.
var errStagedMismatch = errors.New("the staged download reports a different version")
