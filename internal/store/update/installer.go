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

// Installer installs a release.
type Installer interface {
	// Install installs tag, reporting each line of progress, and returns when done.
	Install(ctx context.Context, tag string, progress func(line string)) error
}

// installTimeout bounds one installer run (download included).
const installTimeout = 10 * time.Minute

// ScriptInstaller runs the installer embedded in the binary (scripts/install.sh)
// non-interactively: --yes (no prompts), --skip-path (PATH was set up by the first
// install; an update must not edit ~/.zshrc).
type ScriptInstaller struct {
	// Script is the installer; scripts.InstallSh when nil.
	Script []byte
	// Repo is passed as CODE_FOUNDRY_RELEASE_REPO.
	Repo string
	// ReleaseDir, when set, is passed as CODE_FOUNDRY_RELEASE_DIR (local release source).
	ReleaseDir string
	// AppDir is where CodeFoundry.app is installed (--app-dir); the installer's default
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

// Install implements Installer.
func (i ScriptInstaller) Install(ctx context.Context, tag string, progress func(string)) error {
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
	if !interactive {
		args = append(args, "--yes", "--skip-path")
	}
	if i.AppDir != "" {
		args = append(args, "--app-dir", i.AppDir)
	}
	args = append(args, i.Args...)

	if !interactive {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, installTimeout)
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

	// Its own process group, so cancelling kills gh and ditto too, not just bash.
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
// directory and the system directories the script needs (ditto, shasum, plutil).
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

// errInstalledMismatch is returned when the installer succeeded but the bundle on disk
// does not report the requested version.
var errInstalledMismatch = errors.New("installed bundle reports a different version")
