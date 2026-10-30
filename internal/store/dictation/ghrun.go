package dictation

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GhRunner runs gh for the GitHub source. Run writes gh's stdout to stdout as it
// arrives and returns once gh has exited: nil, a *GhError for a non-zero exit, the
// context's error when ctx ended, ErrGhNotFound when there is no gh, or another error
// when gh could not run.
type GhRunner interface {
	Run(ctx context.Context, args []string, stdout io.Writer) error
}

// ErrGhNotFound is a GitHub source with no gh to fetch it with.
var ErrGhNotFound = errors.New("gh was not found (install it, or set its path under Settings › Advanced)")

// errGhLoggedOut is gh without a GitHub login.
var errGhLoggedOut = errors.New("gh is not logged in (run gh auth login)")

// ghExitAuth is gh's exit code for "not logged in".
const ghExitAuth = 4

// GhError is gh exiting non-zero.
type GhError struct {
	Code   int
	Stderr string
}

func (e *GhError) Error() string {
	if line := firstLine(e.Stderr); line != "" {
		return strings.TrimPrefix(line, "gh: ")
	}
	return fmt.Sprintf("gh exited with code %d", e.Code)
}

// ExecGh runs the gh executable in its own process group, so cancelling kills it.
type ExecGh struct {
	// Path returns gh's path (advanced.gh_path, read on every run); gh.LookPath() when
	// nil or empty.
	Path func() string
}

// ghEnv keeps gh non-interactive and its output plain.
var ghEnv = []string{"GH_PROMPT_DISABLED=1", "GH_NO_UPDATE_NOTIFIER=1", "GH_SPINNER_DISABLED=1", "NO_COLOR=1", "CLICOLOR=0", "GH_PAGER="}

// Run implements GhRunner.
func (g ExecGh) Run(ctx context.Context, args []string, stdout io.Writer) error {
	path := ""
	if g.Path != nil {
		path = g.Path()
	}
	if path == "" {
		p, err := gh.LookPath()
		if err != nil {
			return ErrGhNotFound
		}
		path = p
	}
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Env = append(os.Environ(), ghEnv...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = stdout, &stderr
	err := cmd.Run()
	switch {
	case err == nil:
		return nil
	case ctx.Err() != nil:
		return ctx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return &GhError{Code: exitErr.ExitCode(), Stderr: stderr.String()}
	}
	if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
		return ErrGhNotFound
	}
	return fmt.Errorf("run gh: %w", err)
}

// ghReason maps a gh failure to what the user can do about it.
func ghReason(err error) error {
	var ge *GhError
	if errors.As(err, &ge) && (ge.Code == ghExitAuth || strings.Contains(ge.Stderr, "gh auth login")) {
		return errGhLoggedOut
	}
	return err
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(line)
}
