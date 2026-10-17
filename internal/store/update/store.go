// Package update is the in-app updater: it checks the latest GitHub release of the
// build's release repository on the configured channel (30s after daemon start, then
// every 24h, on request, and at once when the channel changes), downloads it on request
// and installs it as part of the restart, by running the installer embedded in the
// binary. Newer is the only rule on both channels: switching from tip to stable never
// offers a downgrade, it waits for the next stable release above the running build.
//
// State machine (Status.State):
//
//	Idle ──check finds newer──► Available ──Download──► Downloading ──ok──► Downloaded
//	  ▲                            ▲                         │                  │
//	  └──check finds nothing───────┘                       error      Install (app.restart)
//	                                                         ▼                  │
//	                                  (Download retries)   Failed ◄───error─────┤
//	                                                                            ▼ ok
//	                                             RestartRequired ◄──Relaunch── Installed
//
// Download only stages the release beside the app directory (<app>.new); the install on
// disk does not change, so a window closed and reopened meanwhile still finds the
// version its daemon runs (GUI and daemon have no cross-version compatibility). The
// user applies it with `app.restart` (the GUI's "Restart Now"): Install swaps the staged
// directory in (two renames), RequestRestart announces RestartRequested, then the daemon
// exits, closing every thread; GUI hosts relaunch once their Watch stream ends, and the
// relaunched window auto-starts the installed daemon. A daemon that starts from the new
// install is simply up to date.
//
// Installed and RestartRequired mean the install on disk is newer than the running
// daemon: after Install when the restart did not follow, or an install done outside the
// app (`install.sh`, or `code-foundry update` with no daemon running, then an older
// daemon started). `app.relaunch` (RequestRelaunch: Installed becomes RestartRequired)
// and `daemon.restart` remain for doing the two halves of a restart separately. A
// daemon that starts with a newer download staged (it crashed or was restarted after
// downloading) starts in Downloaded.
package update

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
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
	Downloaded
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
	case Downloaded:
		return "downloaded"
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
	// Channel is the release channel checks follow.
	Channel        Channel
	Checking       bool
	LastCheckedAt  time.Time
	LastCheckError string
	// Latest is the latest tag seen by the last successful check on Channel ("" until
	// the first check after a channel change).
	Latest string
	// Target is the version Available/Downloading/Downloaded/Installed/RestartRequired/
	// Failed refer to.
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

// RestartRequested is published by RequestRestart: the daemon is about to exit to
// restart into the installed version. GUIs relaunch once their connection to it ends.
type RestartRequested struct{}

// Errors. internal/api maps both to FailedPrecondition.
var (
	// ErrDisabled: updates are disabled for this build (Status.DisabledReason).
	ErrDisabled = errors.New("updates are disabled")
	// ErrNotAvailable: Download was called with nothing to download, or Install with
	// nothing downloaded.
	ErrNotAvailable = errors.New("no update available")
)

// Service is the updater as the API and commands see it.
type Service interface {
	Snapshot() Status
	Check(ctx context.Context) (Status, error)
	// Download starts downloading and staging the available version and returns at once.
	Download(ctx context.Context) (Status, error)
	// Install swaps the downloaded version into the app directory and returns when done.
	Install(ctx context.Context) (Status, error)
	// RequestRelaunch asks connected GUIs to relaunch and returns how many listeners
	// received the request.
	RequestRelaunch() int
	// RequestRestart tells connected GUIs the daemon is about to restart and returns
	// how many listeners received it.
	RequestRestart() int
	// SetChannel switches the release channel and, when it changed, re-checks at once
	// in the background. It does not block.
	SetChannel(ch Channel)
}

// Defaults.
const (
	DefaultInitialDelay = 30 * time.Second
	DefaultInterval     = time.Hour
	// EnvInitialDelay overrides DefaultInitialDelay (a Go duration), for testing.
	EnvInitialDelay = "CODE_FOUNDRY_UPDATE_DELAY"
)

// Options configures a Store.
type Options struct {
	// Current is the running version.
	Current string
	// Repo is the release repository, for display.
	Repo string
	// Channel is the release channel to follow at start; SetChannel changes it.
	// Default ChannelStable.
	Channel Channel
	// DisabledReason, when set, disables checking and installing.
	DisabledReason string
	// Source and Installer are required unless disabled.
	Source    Source
	Installer Installer
	// InstalledVersion reports the version of the install on disk that this binary runs
	// from ("" when unknown). Lets the store notice an update installed by someone else
	// (`code-foundry update`). Defaults to re-reading VERSION in the directory of the
	// running executable.
	InstalledVersion func() (string, error)
	// StagedVersion reports the version of the download staged beside that install
	// ("" when none). Defaults to re-reading VERSION in StageDir of the running
	// executable's directory.
	StagedVersion func() (string, error)
	Bus           *bus.Bus
	Log           *slog.Logger
	InitialDelay  time.Duration
	Interval      time.Duration
	// Tick is how often the loop compares the wall clock against Interval (so an
	// overdue check runs this soon after wake from sleep). Default the smaller of a
	// minute and Interval.
	Tick time.Duration
	Now  func() time.Time
}

// DefaultOptions configures the updater for the running build: the release repository
// from version.Repo(), a local release directory when version.ReleaseDir() is set, and
// disabled for dev builds and builds without a repository.
func DefaultOptions(current string) Options {
	o := Options{Current: current, Repo: version.Repo()}
	dir := version.ReleaseDir()
	// Updates go beside the running daemon, wherever it was installed: not to the
	// configured home's default, which a CODE_FOUNDRY_HOME override may point elsewhere.
	// Read once at start; the installer swaps the directory but keeps its path.
	appDir := RunningDir()
	o.InstalledVersion = installedVersionIn(appDir)
	o.StagedVersion = installedVersionIn(StageDir(appDir))
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
	ctx  context.Context // store lifetime; downloads run under it

	checkMu sync.Mutex // one check at a time

	mu     sync.Mutex
	status Status
	// installing is set while Install runs the installer (outside mu).
	installing bool

	// recheck asks the loop for an immediate check (a channel change); buffered 1.
	recheck chan struct{}

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
	if opts.Tick <= 0 {
		opts.Tick = min(time.Minute, opts.Interval)
	}
	if opts.InstalledVersion == nil {
		opts.InstalledVersion = installedVersionIn(RunningDir())
	}
	if opts.StagedVersion == nil {
		opts.StagedVersion = installedVersionIn(StageDir(RunningDir()))
	}
	if opts.DisabledReason == "" && (opts.Source == nil || opts.Installer == nil) {
		opts.DisabledReason = "no release source configured"
	}
	if opts.Channel == "" {
		opts.Channel = ChannelStable
	}
	ctx, stop := context.WithCancel(ctx)
	s := &Store{opts: opts, log: opts.Log, ctx: ctx, stop: stop, recheck: make(chan struct{}, 1)}
	s.status = Status{
		State:          Idle,
		Current:        opts.Current,
		Enabled:        opts.DisabledReason == "",
		DisabledReason: opts.DisabledReason,
		Repo:           opts.Repo,
		Channel:        opts.Channel,
	}
	if !s.status.Enabled {
		s.log.Info("update checks disabled", "reason", opts.DisabledReason, "version", opts.Current, "channel", opts.Channel)
		return s
	}
	// An update installed while this daemon was down cannot be newer than us (we start
	// from the install), but one installed by hand with a daemon from an older install
	// still running can; and a download staged by a previous daemon is still there.
	// Notice both without waiting for the first check.
	s.mu.Lock()
	s.applyDisk()
	s.mu.Unlock()
	s.wg.Go(s.loop)
	return s
}

// Close stops the periodic check and waits for it and any running download.
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

// loop checks InitialDelay after start, then whenever Interval of wall-clock time has
// passed since the last check, polled on a short tick. Wall clock rather than a timer
// because Go timers run on the monotonic clock, which stops while a Mac sleeps: a
// closed lid would push the next check out by however long the lid stayed shut. With
// wall-clock polling the first tick after wake runs the overdue check.
func (s *Store) loop() {
	initial := time.NewTimer(s.opts.InitialDelay)
	defer initial.Stop()
	tick := time.NewTicker(s.opts.Tick)
	defer tick.Stop()
	var last time.Time // wall clock of the last check this loop ran; zero until the first
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-initial.C:
		case <-s.recheck:
		case <-tick.C:
			// Round(0) strips the monotonic reading so Sub measures wall-clock time.
			if last.IsZero() || s.opts.Now().Round(0).Sub(last) < s.opts.Interval {
				continue
			}
		}
		if _, err := s.Check(s.ctx); err != nil && s.ctx.Err() == nil {
			s.log.Warn("update check failed", "err", err)
		}
		last = s.opts.Now().Round(0)
	}
}

// SetChannel implements Service. The previous channel's latest tag is cleared; the
// state (an offered update, say) stays until the re-check replaces it.
func (s *Store) SetChannel(ch Channel) {
	s.mu.Lock()
	if s.status.Channel == ch {
		s.mu.Unlock()
		return
	}
	s.log.Info("update channel changed", "from", s.status.Channel, "to", ch)
	s.status.Channel = ch
	s.status.Latest = ""
	s.publishLocked()
	enabled := s.status.Enabled
	s.mu.Unlock()
	if !enabled {
		return
	}
	select {
	case s.recheck <- struct{}{}:
	default: // a re-check is already queued; it reads the channel when it runs
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
	var ch Channel
	s.set(func(st *Status) { st.Checking, ch = true, st.Channel })

	tag, err := s.opts.Source.Latest(ctx, ch)
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
	stale := st.Channel != ch
	switch {
	case stale:
		// The channel changed while checking: drop the old channel's answer; the
		// re-check SetChannel queued follows.
		err = nil
	case err != nil:
		st.LastCheckedAt = now
		st.LastCheckError = err.Error()
	default:
		st.LastCheckedAt = now
		st.LastCheckError = ""
		st.Latest = tag
		s.applyLatest(tag)
	}
	s.publishLocked()
	out = s.status
	s.mu.Unlock()
	if err != nil || stale {
		return out, err
	}
	s.log.Info("update check", "channel", ch, "current", s.opts.Current, "latest", tag, "state", out.State.String())
	return out, nil
}

// applyLatest moves the state after a successful check that saw tag. Caller holds mu.
func (s *Store) applyLatest(tag string) {
	st := &s.status
	if s.installing {
		return // Install decides
	}
	next, target := decide(st.State, st.Target, s.opts.Current, s.onDisk(), s.staged(), tag)
	s.moveTo(next, target)
}

// applyDisk notices, at start, a newer download staged or a newer install on disk: a
// check that saw nothing published. Caller holds mu.
func (s *Store) applyDisk() {
	next, target := decide(s.status.State, s.status.Target, s.opts.Current, s.onDisk(), s.staged(), "")
	s.moveTo(next, target)
}

// onDisk is the version of the install on disk ("" when unknown or not semver).
func (s *Store) onDisk() string { return s.readVersion("installed", s.opts.InstalledVersion) }

// staged is the version of the staged download ("" when none or not semver).
func (s *Store) staged() string { return s.readVersion("staged", s.opts.StagedVersion) }

func (s *Store) readVersion(what string, read func() (string, error)) string {
	v, err := read()
	if err != nil {
		s.log.Debug("read "+what+" version", "err", err)
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

// decide is the state after a successful check that saw latest ("" when nothing is
// published), given the current state and target, the running version, and the versions
// of the install on disk and of the staged download ("" unknown or none).
func decide(state State, target, current, onDisk, staged, latest string) (State, string) {
	if state == Downloading {
		return state, target // the download decides
	}
	// Newer is false when either side is "".
	installed := current
	if Newer(onDisk, installed) {
		installed = onDisk
	}
	// keepFailed keeps a failure visible for the version it is about; Download retries.
	keepFailed := func(next State, v string) (State, string) {
		if state == Failed && target == v {
			return Failed, target
		}
		return next, v
	}
	switch {
	case Newer(latest, installed) && (staged == "" || Newer(latest, staged)):
		return keepFailed(Available, latest)
	case Newer(staged, installed):
		return keepFailed(Downloaded, staged)
	case installed != current:
		if state == RestartRequired && target == installed {
			return RestartRequired, target
		}
		return Installed, installed
	default:
		return Idle, ""
	}
}

// Download starts downloading and staging the available version and returns at once.
// Allowed from Available and Failed (a retry).
func (s *Store) Download(context.Context) (Status, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := &s.status
	if !st.Enabled {
		return *st, fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	}
	if (st.State != Available && st.State != Failed) || st.Target == "" {
		switch st.State {
		case Downloading:
			return *st, fmt.Errorf("%w: already downloading %s", ErrNotAvailable, st.Target)
		case Downloaded:
			return *st, fmt.Errorf("%w: %s is already downloaded; restart Code Foundry to install it", ErrNotAvailable, st.Target)
		}
		return *st, ErrNotAvailable
	}
	target := st.Target
	s.moveTo(Downloading, target)
	st.Progress = "starting download"
	s.publishLocked()
	s.wg.Go(func() { s.runDownload(target) })
	return *st, nil
}

func (s *Store) runDownload(target string) {
	s.log.Info("downloading update", "version", target)
	err := s.opts.Installer.Download(s.ctx, target, func(line string) {
		s.set(func(st *Status) {
			if st.State == Downloading {
				st.Progress = line
			}
		})
	})
	if err == nil {
		if v := s.staged(); v != target {
			if v == "" {
				v = "nothing"
			}
			err = fmt.Errorf("%w: found %s", errStagedMismatch, v)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		s.log.Warn("update download failed", "version", target, "err", err)
		s.moveTo(Failed, target)
		s.status.FailureReason = err.Error()
	} else {
		s.log.Info("update downloaded; restart Code Foundry to install it", "version", target)
		s.moveTo(Downloaded, target)
	}
	s.publishLocked()
}

// Install swaps the downloaded version into the app directory and returns when done:
// Installed on success, Failed with the reason otherwise. Allowed only from Downloaded.
// `app.restart` calls it right before the daemon exits, so the install on disk changes
// together with the running processes.
func (s *Store) Install(ctx context.Context) (Status, error) {
	s.mu.Lock()
	st := &s.status
	switch {
	case !st.Enabled:
		defer s.mu.Unlock()
		return *st, fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	case s.installing:
		defer s.mu.Unlock()
		return *st, fmt.Errorf("%w: already installing %s", ErrNotAvailable, st.Target)
	case st.State != Downloaded:
		defer s.mu.Unlock()
		return *st, fmt.Errorf("%w: nothing downloaded to install", ErrNotAvailable)
	}
	target := st.Target
	s.installing = true
	s.mu.Unlock()

	var err error
	// Someone may have installed it already (install.sh by hand removes the stage too).
	if s.onDisk() != target {
		s.log.Info("installing update", "version", target)
		err = s.opts.Installer.Install(ctx, target)
		if err == nil {
			if v := s.onDisk(); v != "" && v != target {
				err = fmt.Errorf("%w: %s", errInstalledMismatch, v)
			}
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.installing = false
	if err != nil {
		s.log.Warn("update install failed", "version", target, "err", err)
		s.moveTo(Failed, target)
		s.status.FailureReason = err.Error()
		s.publishLocked()
		return s.status, err
	}
	s.log.Info("update installed", "version", target)
	s.moveTo(Installed, target)
	s.publishLocked()
	return s.status, nil
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

// RequestRestart publishes RestartRequested. It leaves the status alone: the daemon is
// about to exit, and the one that starts from the install is up to date.
func (s *Store) RequestRestart() int {
	if s.opts.Bus == nil {
		return 0
	}
	return bus.Publish(s.opts.Bus, RestartRequested{})
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
