// Package clone clones GitHub repositories into the projects directory and registers
// them as projects (RepoService.Clone, the repo.clone command).
//
// A clone runs `gh repo clone <owner>/<name> <projects>/<owner>/<name> -- --progress`,
// so the user's gh login and git protocol settings apply, and streams gh's and git's
// output as Progress lines. The destination is fixed (paths.Projects, not
// configurable) and must not exist yet; it must also lie under the allowed root (the
// user's home), checked before anything is downloaded. On success the clone is
// registered through the repo store; on failure or cancellation a destination the
// clone created is removed again.
package clone

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// DefaultTimeout bounds one clone, download included.
const DefaultTimeout = 15 * time.Minute

// registerTimeout bounds registering a finished clone. Registration runs even when the
// caller went away after the download, so the clone is not left unregistered.
const registerTimeout = 30 * time.Second

// Errors. Match with errors.Is; internal/api maps them to Connect codes.
var (
	// ErrInvalidArgument: owner/name is not a valid GitHub repository name.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrExists: the destination already exists.
	ErrExists = errors.New("already exists")
	// ErrBusy: a clone into the same destination is running.
	ErrBusy = errors.New("clone already running")
	// ErrOutsideRoot: the projects directory resolves outside the allowed root.
	ErrOutsideRoot = errors.New("outside your home directory")
	// ErrNotFound: GitHub has no such repository, or the viewer cannot see it.
	ErrNotFound = errors.New("repository not found on github")
	// ErrFailed: gh repo clone failed; the error text is its last lines.
	ErrFailed = errors.New("gh repo clone failed")
)

// Service is the cloner as API handlers and commands see it. *Cloner implements it;
// clonetest provides a fake.
type Service interface {
	// Destination is where owner/name would be cloned, and whether it exists.
	Destination(owner, name string) (path string, exists bool)
	// Clone clones owner/name, streaming output to progress, and registers it.
	Clone(ctx context.Context, owner, name string, progress func(Progress)) (repo.Repo, error)
}

var _ Service = (*Cloner)(nil)

// Registrar registers a directory as a project. *repo.Git implements it.
type Registrar interface {
	Register(ctx context.Context, path string) (repo.Repo, error)
}

// Options configures a Cloner.
type Options struct {
	// Root is the projects directory (paths.Projects). Created 0700 on first clone.
	Root string
	// AllowedRoot is the directory every project must lie under (the resolved user
	// home). Empty skips the check (the repo store still enforces it on register).
	AllowedRoot string
	// Repos registers finished clones. Required.
	Repos Registrar
	// Gh is the gh binary; "gh" from PATH when empty.
	Gh string
	// Runner runs gh. Defaults to ExecRunner{}.
	Runner Runner
	// Timeout bounds one clone. Zero means DefaultTimeout.
	Timeout time.Duration
	Log     *slog.Logger
}

// Cloner runs clones. Safe for concurrent use; clones into different destinations run
// in parallel.
type Cloner struct {
	opts Options
	mu   sync.Mutex
	busy map[string]bool // destinations being cloned (lower-cased)
}

// New returns a Cloner.
func New(opts Options) (*Cloner, error) {
	if opts.Root == "" || !filepath.IsAbs(opts.Root) {
		return nil, fmt.Errorf("clone: root %q must be an absolute path", opts.Root)
	}
	if opts.Repos == nil {
		return nil, errors.New("clone: Repos is required")
	}
	if opts.Gh == "" {
		opts.Gh = "gh"
	}
	if opts.Runner == nil {
		opts.Runner = ExecRunner{}
	}
	if opts.Timeout <= 0 {
		opts.Timeout = DefaultTimeout
	}
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	return &Cloner{opts: opts, busy: map[string]bool{}}, nil
}

// Destination is where owner/name is cloned to, and whether something is there
// already. It does not validate owner and name.
func (c *Cloner) Destination(owner, name string) (path string, exists bool) {
	path = filepath.Join(c.opts.Root, owner, name)
	_, err := os.Lstat(path)
	return path, err == nil
}

// Clone clones owner/name into its destination, streaming output to progress (which
// may be nil), then registers it. It returns the registered project.
func (c *Cloner) Clone(ctx context.Context, owner, name string, progress func(Progress)) (repo.Repo, error) {
	owner, name = strings.TrimSpace(owner), strings.TrimSpace(name)
	if _, err := gh.NormalizeSlug(owner + "/" + name); err != nil {
		return repo.Repo{}, fmt.Errorf("%w: %q is not a GitHub owner/repo", ErrInvalidArgument, owner+"/"+name)
	}
	dest := filepath.Join(c.opts.Root, owner, name)
	if !c.claim(dest) {
		return repo.Repo{}, fmt.Errorf("%w: %s is being cloned", ErrBusy, dest)
	}
	defer c.release(dest)
	if _, err := os.Lstat(dest); err == nil {
		return repo.Repo{}, fmt.Errorf("%s %w", dest, ErrExists)
	} else if !errors.Is(err, os.ErrNotExist) {
		return repo.Repo{}, fmt.Errorf("check %s: %w", dest, err)
	}
	parent := filepath.Dir(dest)
	if err := os.MkdirAll(c.opts.Root, 0o700); err != nil {
		return repo.Repo{}, fmt.Errorf("create %s: %w", c.opts.Root, err)
	}
	if err := c.checkRoot(); err != nil {
		return repo.Repo{}, err
	}
	createdParent := false
	if _, err := os.Stat(parent); errors.Is(err, os.ErrNotExist) {
		createdParent = true
	}
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return repo.Repo{}, fmt.Errorf("create %s: %w", parent, err)
	}

	slug := owner + "/" + name
	log := c.opts.Log.With("repo", slug, "dest", dest)
	log.Info("clone started")
	start := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, c.opts.Timeout)
	defer cancel()
	emit := func(p Progress) {
		if progress != nil {
			progress(p)
		}
	}
	err := c.opts.Runner.Run(runCtx, parent, c.opts.Gh, []string{"repo", "clone", slug, dest, "--", "--progress"}, emit)
	if err != nil {
		c.cleanup(log, dest, parent, createdParent)
		err = c.classify(ctx, runCtx, err)
		log.Warn("clone failed", "dur", time.Since(start).Round(time.Millisecond).String(), "err", err)
		return repo.Repo{}, err
	}
	log.Info("clone finished", "dur", time.Since(start).Round(time.Millisecond).String())

	regCtx, regCancel := context.WithTimeout(context.WithoutCancel(ctx), registerTimeout)
	defer regCancel()
	r, err := c.opts.Repos.Register(regCtx, dest)
	if err != nil {
		return repo.Repo{}, fmt.Errorf("cloned into %s but could not add it as a project: %w", dest, err)
	}
	return r, nil
}

// checkRoot refuses a projects directory that resolves outside the allowed root.
func (c *Cloner) checkRoot() error {
	if c.opts.AllowedRoot == "" {
		return nil
	}
	resolved, err := filepath.EvalSymlinks(c.opts.Root)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", c.opts.Root, err)
	}
	if !fsx.Within(c.opts.AllowedRoot, resolved) {
		return fmt.Errorf("%w: the projects directory %s is outside %s", ErrOutsideRoot, resolved, c.opts.AllowedRoot)
	}
	return nil
}

// classify turns a runner error into one of the package errors.
func (c *Cloner) classify(ctx, runCtx context.Context, err error) error {
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("clone cancelled: %w", ctx.Err())
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("clone took longer than %s: %w", c.opts.Timeout, context.DeadlineExceeded)
	}
	var ee *ExitError
	if !errors.As(err, &ee) {
		return fmt.Errorf("%w: %w", ErrFailed, err)
	}
	msg := ee.Error()
	if strings.Contains(msg, "Could not resolve to a Repository") || strings.Contains(msg, "Repository not found") {
		return fmt.Errorf("%w: %s", ErrNotFound, msg)
	}
	if errors.Is(ee.Err, os.ErrNotExist) || errors.Is(ee.Err, exec.ErrNotFound) {
		return fmt.Errorf("%w: %s not found; install the GitHub CLI or set advanced.gh_path", ErrFailed, c.opts.Gh)
	}
	return fmt.Errorf("%w: %s", ErrFailed, msg)
}

// cleanup removes what a failed clone left behind: the destination, and the owner
// directory when this clone created it and it is empty now.
func (c *Cloner) cleanup(log *slog.Logger, dest, parent string, createdParent bool) {
	if err := os.RemoveAll(dest); err != nil {
		log.Warn("remove failed clone", "err", err)
	}
	if createdParent {
		_ = os.Remove(parent) // only succeeds when empty
	}
}

func (c *Cloner) claim(dest string) bool {
	key := strings.ToLower(dest)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.busy[key] {
		return false
	}
	c.busy[key] = true
	return true
}

func (c *Cloner) release(dest string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.busy, strings.ToLower(dest))
}
