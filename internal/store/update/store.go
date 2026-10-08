// Package update is the in-app updater: it checks the latest GitHub release of the
// build's release repository (30s after daemon start, then every 24h, or on request)
// and installs it on request by running the installer embedded in the binary.
//
// State machine (Status.State):
//
//	Idle ──check finds newer──► Available ──Install──► Downloading ──ok──► Installed
//	  ▲                            ▲                       │                  │ Relaunch
//	  └──check finds nothing───────┘                       └──error──► Failed  ▼
//	                                                         (Install retries) RestartRequired
//
// Nothing restarts automatically. Installed means the bundle on disk is newer than the
// running daemon: the GUI relaunches on request, and the daemon keeps running the old
// version until `daemon.restart` (which closes every session). A daemon that starts from
// the new bundle is simply up to date.
package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/version"
)

// State is the updater's state.
type State int

// States. See the package doc for transitions.
const (
	Idle State = iota + 1
	Available
	Downloading
	Installed
	RestartRequired
	Failed
)

func (s State) String() string {
	switch s {
	case Idle:
		return "idle"
	case Available:
		return "available"
	case Downloading:
		return "downloading"
	case Installed:
		return "installed"
	case RestartRequired:
		return "restart_required"
	case Failed:
		return "failed"
	default:
		return fmt.Sprintf("State(%d)", int(s))
	}
}

// Status is the updater's published snapshot. See codefoundry.v1.UpdateStatus.
type Status struct {
	State State
	// Current is the running daemon's version.
	Current        string
	Enabled        bool
	DisabledReason string
	Repo           string
	Checking       bool
	LastCheckedAt  time.Time
	LastCheckError string
	// Latest is the latest tag seen by the last successful check.
	Latest string
	// Target is the version Available/Downloading/Installed/RestartRequired/Failed
	// refer to.
	Target        string
	NotesURL      string
	Progress      string
	FailureReason string
}

// Event is published on the bus whenever the status changes.
type Event struct {
	Status Status
}

// RelaunchRequested is published by RequestRelaunch; GUIs relaunch themselves.
type RelaunchRequested struct{}

// Errors. internal/api maps both to FailedPrecondition.
var (
	// ErrDisabled: updates are disabled for this build (Status.DisabledReason).
	ErrDisabled = errors.New("updates are disabled")
	// ErrNotAvailable: Install was called with nothing to install.
	ErrNotAvailable = errors.New("no update available")
)

// Service is the updater as the API and commands see it.
type Service interface {
	Snapshot() Status
	Check(ctx context.Context) (Status, error)
	Install(ctx context.Context) (Status, error)
	// RequestRelaunch asks connected GUIs to relaunch and returns how many listeners
	// received the request.
	RequestRelaunch() int
}

// Defaults.
const (
	DefaultInitialDelay = 30 * time.Second
	DefaultInterval     = 24 * time.Hour
	// EnvInitialDelay overrides DefaultInitialDelay (a Go duration), for testing.
	EnvInitialDelay = "CODE_FOUNDRY_UPDATE_DELAY"
)

// Options configures a Store.
type Options struct {
	// Current is the running version.
	Current string
	// Repo is the release repository, for display.
	Repo string
	// DisabledReason, when set, disables checking and installing.
	DisabledReason string
	// Source and Installer are required unless disabled.
	Source    Source
	Installer Installer
	// InstalledVersion reports the version of the bundle on disk that this binary runs
	// from ("" when unknown). Lets the store notice an update installed by someone else
	// (`code-foundry update`). Defaults to reading the running bundle's Info.plist.
	InstalledVersion func() (string, error)
	Bus              *bus.Bus
	Log              *slog.Logger
	InitialDelay     time.Duration
	Interval         time.Duration
	Now              func() time.Time
}

// DefaultOptions configures the updater for the running build: the release repository
// from version.Repo(), a local release directory when version.ReleaseDir() is set, and
// disabled for dev builds and builds without a repository.
func DefaultOptions(current string) Options {
	o := Options{Current: current, Repo: version.Repo()}
	dir := version.ReleaseDir()
	appDir := ""
	if b := RunningBundle(); b != "" {
		appDir = filepath.Dir(b)
	}
	switch {
	case !IsSemver(current):
		o.DisabledReason = "dev build"
	case dir != "":
		o.Source = DirSource{Dir: dir}
		if o.Repo == "" {
			o.Repo = "local:" + dir
		}
	case o.Repo != "":
		o.Source = GhSource{Repo: o.Repo}
	default:
		o.DisabledReason = "no release repository configured"
	}
	o.Installer = ScriptInstaller{Repo: version.Repo(), ReleaseDir: dir, AppDir: appDir}
	if d, err := time.ParseDuration(os.Getenv(EnvInitialDelay)); err == nil && d >= 0 {
		o.InitialDelay = d
	}
	return o
}

// Store is the updater. Create with Start.
type Store struct {
	opts Options
	log  *slog.Logger
	ctx  context.Context // store lifetime; installs run under it

	checkMu sync.Mutex // one check at a time

	mu     sync.Mutex
	status Status

	stop context.CancelFunc
	wg   sync.WaitGroup
}

var _ Service = (*Store)(nil)

// Start creates the store and, unless disabled, starts the periodic check. Close stops
// it.
func Start(ctx context.Context, opts Options) *Store {
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.InitialDelay == 0 {
		opts.InitialDelay = DefaultInitialDelay
	}
	if opts.Interval <= 0 {
		opts.Interval = DefaultInterval
	}
	if opts.InstalledVersion == nil {
		opts.InstalledVersion = installedVersion
	}
	if opts.DisabledReason == "" && (opts.Source == nil || opts.Installer == nil) {
		opts.DisabledReason = "no release source configured"
	}
	ctx, stop := context.WithCancel(ctx)
	s := &Store{opts: opts, log: opts.Log, ctx: ctx, stop: stop}
	s.status = Status{
		State:          Idle,
		Current:        opts.Current,
		Enabled:        opts.DisabledReason == "",
		DisabledReason: opts.DisabledReason,
		Repo:           opts.Repo,
	}
	if !s.status.Enabled {
		s.log.Info("update checks disabled", "reason", opts.DisabledReason, "version", opts.Current)
		return s
	}
	// An update installed while this daemon was down cannot be newer than us (we start
	// from the bundle), but one installed by `code-foundry update` with a daemon from an
	// older bundle still running can: notice it without waiting for the first check.
	s.mu.Lock()
	s.applyOnDisk()
	s.mu.Unlock()
	s.wg.Go(s.loop)
	return s
}

// Close stops the periodic check and waits for it and any running install.
func (s *Store) Close() {
	s.stop()
	s.wg.Wait()
}

// Snapshot returns the current status.
func (s *Store) Snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Store) loop() {
	t := time.NewTimer(s.opts.InitialDelay)
	defer t.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-t.C:
		}
		if _, err := s.Check(s.ctx); err != nil && s.ctx.Err() == nil {
			s.log.Warn("update check failed", "err", err)
		}
		t.Reset(s.opts.Interval)
	}
}

// Check asks the source for the latest release and updates the state. A failed check
// leaves the state as it was and records LastCheckError.
func (s *Store) Check(ctx context.Context) (Status, error) {
	if !s.Snapshot().Enabled {
		return s.Snapshot(), fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	}
	s.checkMu.Lock()
	defer s.checkMu.Unlock()
	s.set(func(st *Status) { st.Checking = true })

	tag, err := s.opts.Source.Latest(ctx)
	noRelease := errors.Is(err, ErrNoRelease)
	if noRelease {
		err, tag = nil, ""
	} else if err == nil {
		if _, perr := ParseVersion(tag); perr != nil {
			err = fmt.Errorf("latest release tag: %w", perr)
		}
	}
	now := s.opts.Now()
	var out Status
	s.mu.Lock()
	st := &s.status
	st.Checking = false
	st.LastCheckedAt = now
	if err != nil {
		st.LastCheckError = err.Error()
	} else {
		st.LastCheckError = ""
		st.Latest = tag
		s.applyLatest(tag)
	}
	s.publishLocked()
	out = s.status
	s.mu.Unlock()
	if err != nil {
		return out, err
	}
	s.log.Info("update check", "current", s.opts.Current, "latest", tag, "state", out.State.String())
	return out, nil
}

// applyLatest moves the state after a successful check that saw tag. Caller holds mu.
func (s *Store) applyLatest(tag string) {
	st := &s.status
	onDisk := s.onDisk()
	next, target := decide(st.State, st.Target, s.opts.Current, onDisk, tag)
	s.moveTo(next, target)
}

// applyOnDisk notices a newer bundle on disk. Caller holds mu.
func (s *Store) applyOnDisk() {
	if v := s.onDisk(); Newer(v, s.opts.Current) {
		s.moveTo(Installed, v)
	}
}

func (s *Store) onDisk() string {
	v, err := s.opts.InstalledVersion()
	if err != nil {
		s.log.Debug("read installed bundle version", "err", err)
		return ""
	}
	if !IsSemver(v) {
		return ""
	}
	return v
}

// moveTo sets state and target, keeping per-state fields consistent. Caller holds mu.
func (s *Store) moveTo(state State, target string) {
	st := &s.status
	if st.State == state && st.Target == target {
		return
	}
	st.State, st.Target = state, target
	st.NotesURL = ""
	if target != "" && s.opts.Source != nil {
		st.NotesURL = s.opts.Source.NotesURL(target)
	}
	if state != Downloading {
		st.Progress = ""
	}
	if state != Failed {
		st.FailureReason = ""
	}
}

// decide is the state after a successful check that saw latest, given the current state
// and target, the running version, and the version of the bundle on disk ("" unknown).
func decide(state State, target, current, onDisk, latest string) (State, string) {
	if state == Downloading {
		return state, target // the install decides
	}
	// latest is "" when nothing is published; Newer is then false.
	installed := current
	if Newer(onDisk, installed) {
		installed = onDisk
	}
	switch {
	case Newer(latest, installed):
		if state == Failed && target == latest {
			return Failed, target // keep the failure visible; Install retries
		}
		return Available, latest
	case installed != current:
		if state == RestartRequired && target == installed {
			return RestartRequired, target
		}
		return Installed, installed
	default:
		return Idle, ""
	}
}

// Install starts installing the available version and returns at once.
func (s *Store) Install(context.Context) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := &s.status
	if !st.Enabled {
		return *st, fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	}
	if st.State != Available && st.State != Failed {
		if st.State == Downloading {
			return *st, fmt.Errorf("%w: already installing %s", ErrNotAvailable, st.Target)
		}
		return *st, ErrNotAvailable
	}
	target := st.Target
	s.moveTo(Downloading, target)
	st.Progress = "starting installer"
	s.publishLocked()
	s.wg.Go(func() { s.runInstall(target) })
	return *st, nil
}

func (s *Store) runInstall(target string) {
	s.log.Info("installing update", "version", target)
	err := s.opts.Installer.Install(s.ctx, target, func(line string) {
		s.set(func(st *Status) {
			if st.State == Downloading {
				st.Progress = line
			}
		})
	})
	if err == nil {
		if v := s.onDisk(); v != "" && v != target {
			err = fmt.Errorf("%w: %s", errInstalledMismatch, v)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.log.Warn("update install failed", "version", target, "err", err)
		s.moveTo(Failed, target)
		s.status.FailureReason = err.Error()
	} else {
		s.log.Info("update installed; relaunch the GUI and restart the daemon to run it", "version", target)
		s.moveTo(Installed, target)
	}
	s.publishLocked()
}

// RequestRelaunch publishes RelaunchRequested. Once the GUI relaunches into an installed
// update, only the daemon restart is left: Installed becomes RestartRequired.
func (s *Store) RequestRelaunch() int {
	s.mu.Lock()
	if s.status.State == Installed {
		s.moveTo(RestartRequired, s.status.Target)
		s.publishLocked()
	}
	s.mu.Unlock()
	if s.opts.Bus == nil {
		return 0
	}
	return bus.Publish(s.opts.Bus, RelaunchRequested{})
}

// set applies f and publishes. f must not block.
func (s *Store) set(f func(*Status)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	f(&s.status)
	s.publishLocked()
}

// publishLocked publishes the status. Publishing under mu keeps events in order.
func (s *Store) publishLocked() {
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, Event{Status: s.status})
	}
}
