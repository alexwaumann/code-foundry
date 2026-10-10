// Package project starts new projects in the projects directory (RepoService.Create,
// the repo.create command) and publishes git projects to GitHub (RepoService.Publish,
// repo.github.publish).
//
// Create makes <projects>/<name>, runs the repo store's InitRepository there (git init
// on init.defaultBranch, else main, and an empty "Initial commit") and registers the
// folder through the repo store. Publish runs `gh repo create <owner>/<name> --source
// <path> --remote origin --push --<visibility>`, so the user's gh login applies, and
// refreshes the project so origin and the GitHub slug show up. Neither keeps state
// beyond the publishes in flight; the repo store publishes the results.
package project

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// DefaultPublishTimeout bounds one `gh repo create`, push included.
const DefaultPublishTimeout = 5 * time.Minute

// MaxNameLength is the longest project name Create accepts (GitHub's limit for
// repository names).
const MaxNameLength = 100

// settleTimeout bounds registering a created project and refreshing a published one.
// Both run even when the caller went away, so the store catches up with the disk.
const settleTimeout = 30 * time.Second

// Errors. Match with errors.Is; internal/api maps them to Connect codes.
var (
	// ErrInvalidArgument: a bad name, owner or visibility.
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrExists: the new project's folder already exists.
	ErrExists = errors.New("already exists")
	// ErrOutsideRoot: the projects directory resolves outside the allowed root.
	ErrOutsideRoot = errors.New("outside your home directory")
	// ErrNotFound: no such project.
	ErrNotFound = errors.New("project not found")
	// ErrFailedPrecondition: the project cannot be published (not git, has origin, a
	// publish of it is running).
	ErrFailedPrecondition = errors.New("failed precondition")
	// ErrFailed: git or gh failed; see *GhError for gh.
	ErrFailed = errors.New("failed")
)

// GhError is a failed `gh repo create`. Its message is gh's last output lines,
// verbatim, so the user reads exactly what gh said. It matches ErrFailed.
type GhError struct {
	Tail string
}

func (e *GhError) Error() string { return e.Tail }

// Is makes errors.Is(err, ErrFailed) true.
func (e *GhError) Is(target error) bool { return target == ErrFailed }

// Visibility is a GitHub repository visibility, as gh's flags spell it.
type Visibility string

// Visibilities.
const (
	Public   Visibility = "public"
	Internal Visibility = "internal"
	Private  Visibility = "private"
)

// ParseVisibility accepts public, internal and private in any case.
func ParseVisibility(s string) (Visibility, error) {
	v := Visibility(strings.ToLower(strings.TrimSpace(s)))
	switch v {
	case Public, Internal, Private:
		return v, nil
	}
	return "", fmt.Errorf("%w: visibility %q (want public, internal or private)", ErrInvalidArgument, s)
}

// PublishOptions says where to publish a project.
type PublishOptions struct {
	RepoID string
	// Owner is the GitHub user or organization.
	Owner string
	// Name is the GitHub repository name; the project's name when empty.
	Name       string
	Visibility Visibility
}

// Service is the project store as API handlers see it. *Store implements it;
// projecttest provides a fake.
type Service interface {
	// Create starts a project named name in the projects directory and registers it.
	Create(ctx context.Context, name string) (repo.Repo, error)
	// Publish creates the project's GitHub repository, pushes, and returns the
	// refreshed project.
	Publish(ctx context.Context, opts PublishOptions) (repo.Repo, error)
}

var _ Service = (*Store)(nil)

// Repos is what the store needs from the repo store. *repo.Git implements it.
type Repos interface {
	Snapshot() *repo.Snapshot
	Register(ctx context.Context, path string) (repo.Repo, error)
	Refresh(ctx context.Context, id string) error
}

// Options configures a Store.
type Options struct {
	// Root is the projects directory (paths.Projects). Created 0700 on first use.
	Root string
	// AllowedRoot is the directory every project must lie under (the resolved user
	// home). Empty skips the check (the repo store still enforces it on register).
	AllowedRoot string
	// Repos registers and refreshes projects. Required.
	Repos Repos
	// Git runs git for Create; repo.ExecRunner{} when nil.
	Git repo.Runner
	// Gh is the gh binary; "gh" from PATH when empty.
	Gh string
	// Runner runs gh for Publish; clone.ExecRunner{} when nil.
	Runner clone.Runner
	// PublishTimeout bounds one publish; DefaultPublishTimeout when zero.
	PublishTimeout time.Duration
	Log            *slog.Logger
}

// Store creates and publishes projects. Safe for concurrent use.
type Store struct {
	opts Options
	mu   sync.Mutex
	busy map[string]bool // repo ids being published
}

// New returns a Store.
func New(opts Options) (*Store, error) {
	if opts.Root == "" || !filepath.IsAbs(opts.Root) {
		return nil, fmt.Errorf("project: root %q must be an absolute path", opts.Root)
	}
	if opts.Repos == nil {
		return nil, errors.New("project: Repos is required")
	}
	if opts.Git == nil {
		opts.Git = repo.ExecRunner{}
	}
	if opts.Gh == "" {
		opts.Gh = "gh"
	}
	if opts.Runner == nil {
		opts.Runner = clone.ExecRunner{}
	}
	if opts.PublishTimeout <= 0 {
		opts.PublishTimeout = DefaultPublishTimeout
	}
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	return &Store{opts: opts, busy: map[string]bool{}}, nil
}

// ValidateName checks a new project's name: not empty, at most MaxNameLength, not
// starting with "." (so not "." or ".."), and only letters, digits, "-", "_" and ".".
// The GUI applies the same rules as the user types.
func ValidateName(name string) error {
	switch {
	case name == "":
		return fmt.Errorf("%w: a project name is required", ErrInvalidArgument)
	case len(name) > MaxNameLength:
		return fmt.Errorf("%w: a project name has at most %d characters", ErrInvalidArgument, MaxNameLength)
	case strings.HasPrefix(name, "."):
		return fmt.Errorf("%w: a project name cannot start with \".\"", ErrInvalidArgument)
	}
	for _, r := range name {
		ok := r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' || r == '.'
		if !ok {
			return fmt.Errorf("%w: %q: a project name has only letters, digits, \"-\", \"_\" and \".\"", ErrInvalidArgument, name)
		}
	}
	return nil
}

// Destination is where Create puts a project named name. It does not validate name.
func (s *Store) Destination(name string) string { return filepath.Join(s.opts.Root, name) }

// Create implements Service. On any failure before registration the new folder is
// removed again, so a failed create leaves nothing behind.
func (s *Store) Create(ctx context.Context, name string) (repo.Repo, error) {
	if err := ValidateName(name); err != nil {
		return repo.Repo{}, err
	}
	dest := s.Destination(name)
	if _, err := os.Lstat(dest); err == nil {
		return repo.Repo{}, fmt.Errorf("%s %w", dest, ErrExists)
	} else if !errors.Is(err, os.ErrNotExist) {
		return repo.Repo{}, fmt.Errorf("check %s: %w", dest, err)
	}
	if err := os.MkdirAll(s.opts.Root, 0o700); err != nil {
		return repo.Repo{}, fmt.Errorf("create %s: %w", s.opts.Root, err)
	}
	if err := s.checkRoot(); err != nil {
		return repo.Repo{}, err
	}
	// Mkdir, not MkdirAll: of two creates racing for one name, one gets EEXIST.
	if err := os.Mkdir(dest, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			return repo.Repo{}, fmt.Errorf("%s %w", dest, ErrExists)
		}
		return repo.Repo{}, fmt.Errorf("create %s: %w", dest, err)
	}
	log := s.opts.Log.With("name", name, "dest", dest)
	branch, err := repo.InitRepository(ctx, s.opts.Git, dest)
	if err != nil {
		if rmErr := os.RemoveAll(dest); rmErr != nil {
			log.Warn("remove failed project", "err", rmErr)
		}
		log.Warn("create failed", "err", err)
		return repo.Repo{}, fmt.Errorf("%w: git init in %s: %w", ErrFailed, dest, err)
	}
	log.Info("project created", "branch", branch)
	regCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer cancel()
	r, err := s.opts.Repos.Register(regCtx, dest)
	if err != nil {
		return repo.Repo{}, fmt.Errorf("created %s but could not add it as a project: %w", dest, err)
	}
	return r, nil
}

// checkRoot refuses a projects directory that resolves outside the allowed root.
func (s *Store) checkRoot() error {
	if s.opts.AllowedRoot == "" {
		return nil
	}
	resolved, err := filepath.EvalSymlinks(s.opts.Root)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", s.opts.Root, err)
	}
	if !fsx.Within(s.opts.AllowedRoot, resolved) {
		return fmt.Errorf("%w: the projects directory %s is outside %s", ErrOutsideRoot, resolved, s.opts.AllowedRoot)
	}
	return nil
}

// Publish implements Service. The project is refreshed after gh ran, failed or not: gh
// may have created the repository and added origin before a failed push.
func (s *Store) Publish(ctx context.Context, opts PublishOptions) (repo.Repo, error) {
	vis, err := ParseVisibility(string(opts.Visibility))
	if err != nil {
		return repo.Repo{}, err
	}
	r, ok := s.opts.Repos.Snapshot().Repo(opts.RepoID)
	if !ok {
		return repo.Repo{}, fmt.Errorf("%w: %q", ErrNotFound, opts.RepoID)
	}
	owner, name := strings.TrimSpace(opts.Owner), strings.TrimSpace(opts.Name)
	if name == "" {
		name = r.Name
	}
	if owner == "" {
		return repo.Repo{}, fmt.Errorf("%w: a GitHub owner is required", ErrInvalidArgument)
	}
	slug := owner + "/" + name
	if _, err := gh.NormalizeSlug(slug); err != nil {
		return repo.Repo{}, fmt.Errorf("%w: %q is not a valid GitHub owner/name", ErrInvalidArgument, slug)
	}
	switch {
	case !r.Git:
		return repo.Repo{}, fmt.Errorf("%w: %s is not a git repository; initialize git first", ErrFailedPrecondition, r.Name)
	case slices.Contains(r.Remotes, "origin"):
		return repo.Repo{}, fmt.Errorf("%w: %s already has an origin remote", ErrFailedPrecondition, r.Name)
	}
	if !s.claim(r.ID) {
		return repo.Repo{}, fmt.Errorf("%w: %s is being published", ErrFailedPrecondition, r.Name)
	}
	defer s.release(r.ID)

	log := s.opts.Log.With("repo", r.ID, "slug", slug, "visibility", string(vis))
	log.Info("publish started")
	start := time.Now()
	runCtx, cancel := context.WithTimeout(ctx, s.opts.PublishTimeout)
	defer cancel()
	args := []string{"repo", "create", slug, "--source", r.Path, "--remote", "origin", "--push", "--" + string(vis)}
	runErr := s.opts.Runner.Run(runCtx, r.Path, s.opts.Gh, args, nil)
	dur := time.Since(start).Round(time.Millisecond).String()

	refreshCtx, refreshCancel := context.WithTimeout(context.WithoutCancel(ctx), settleTimeout)
	defer refreshCancel()
	refreshErr := s.opts.Repos.Refresh(refreshCtx, r.ID)
	if runErr != nil {
		err := s.classify(ctx, runCtx, runErr)
		log.Warn("publish failed", "dur", dur, "err", err)
		return repo.Repo{}, err
	}
	log.Info("published", "dur", dur)
	if refreshErr != nil {
		return repo.Repo{}, fmt.Errorf("published %s but could not refresh %s: %w", slug, r.Name, refreshErr)
	}
	out, ok := s.opts.Repos.Snapshot().Repo(r.ID)
	if !ok {
		return repo.Repo{}, fmt.Errorf("%w: %s was removed while it was published", ErrNotFound, r.Name)
	}
	return out, nil
}

// classify turns a runner error into one of the package errors.
func (s *Store) classify(ctx, runCtx context.Context, err error) error {
	switch {
	case ctx.Err() != nil:
		return fmt.Errorf("publish cancelled: %w", ctx.Err())
	case errors.Is(runCtx.Err(), context.DeadlineExceeded):
		return fmt.Errorf("publish took longer than %s: %w", s.opts.PublishTimeout, context.DeadlineExceeded)
	}
	var ee *clone.ExitError
	if !errors.As(err, &ee) {
		return fmt.Errorf("%w: %w", ErrFailed, err)
	}
	if errors.Is(ee.Err, os.ErrNotExist) || errors.Is(ee.Err, exec.ErrNotFound) {
		return fmt.Errorf("%w: %s not found; install the GitHub CLI or set advanced.gh_path", ErrFailed, s.opts.Gh)
	}
	return &GhError{Tail: ee.Error()}
}

func (s *Store) claim(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.busy[id] {
		return false
	}
	s.busy[id] = true
	return true
}

func (s *Store) release(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.busy, id)
}
