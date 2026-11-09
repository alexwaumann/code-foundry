// Package update is the in-app updater: it checks the latest GitHub release of the
// build's release repository on the configured channel (30s after daemon start, then
// every hour, on request, and at once when the channel changes), downloads a newer
// release as soon as a check finds it, and installs it as part of the restart, by
// running the installer embedded in the binary. Newer is the only rule on both channels: switching from tip to stable never
// offers a downgrade, it waits for the next stable release above the running build.
//
// State machine (Status.State):
//
//	Idle ──check finds newer──► Available ──Download──► Downloading ──ok──► Downloaded
//	  ▲                            ▲                         │                  │
//	  └──check finds nothing───────┘                       error      Install (app.restart)
//	                               ▲                         ▼                  │
//	                               └─check finds newer──   Failed ◄───error─────┤
//	                                                                            ▼ ok
//	                                             RestartRequired ◄──Relaunch── Installed
//
// Download checks first and downloads whatever is newest then, and a failed download
// checks again at once: a release offered earlier may have been deleted (tip releases
// beyond the newest five are), and retrying it would fail the same way every time.
//
// Automatic downloads: a scheduled or requested check that moves to Available starts the
// download itself, so the user is offered "Install and Restart Now" without a Download
// click. An automatic download that fails goes back to Available (the Download button
// stays as the fallback, FailureReason says why) and the next check tries again; the
// check right after the failure does not retry the version that just failed. After
// MaxAutoAttempts failures of the same version it is Failed (Try Again), and checks stop
// downloading it until a newer release or a download by hand. A check that
// finds a release newer than the one downloaded keeps Downloaded and downloads the newer
// one in the background (replacing); the installer unpacks it beside the stage and swaps
// it in only once complete, so the older download stays installable throughout, and
// Install cancels the replacement and installs what is staged. At most three copies
// exist at once: the install, the download, and the replacement in progress.
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
	"cmp"
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
	// ManualDownload turns automatic downloads off: checks only offer a release, and
	// Download fetches it. Not a user setting; for tests of the manual path.
	ManualDownload bool
	Bus            *bus.Bus
	Log            *slog.Logger
	InitialDelay   time.Duration
	Interval       time.Duration
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
	// failedTag is the version whose download failed last and failCount how many times
	// in a row; the check right after a failure does not start it again automatically,
	// and none does after MaxAutoAttempts.
	failedTag string
	failCount int
	// replacing is the newer version downloading in the background while Downloaded
	// ("" when none); replaceCancel stops it and replaceDone closes when it has ended.
	replacing     string
	replaceCancel context.CancelFunc
	replaceDone   chan struct{}

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
	if s.replaceCancel != nil {
		// A newer release of the old channel must not land as the download; the re-check
		// below decides for the new one.
		s.replaceCancel()
	}
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

// MaxAutoAttempts is how many times in a row checks download a version that keeps
// failing (a broken release asset) before they stop and show Failed.
const MaxAutoAttempts = 3

// noteFailureLocked counts a failed download of tag. Caller holds mu.
func (s *Store) noteFailureLocked(tag string) {
	if s.failedTag == tag {
		s.failCount++
	} else {
		s.failedTag, s.failCount = tag, 1
	}
}

// skipAutoLocked reports whether a check of mode must not download tag by itself: it
// just failed (autoNew) or failed MaxAutoAttempts times. Caller holds mu.
func (s *Store) skipAutoLocked(mode autoMode, tag string) bool {
	return tag == s.failedTag && (mode == autoNew || s.failCount >= MaxAutoAttempts)
}

// autoMode is what a check may start by itself once it has seen the latest release.
type autoMode int

const (
	// autoNone: Download's own check; Download starts the download.
	autoNone autoMode = iota
	// autoNew: the check after a failed download; it starts a download, but not of the
	// version that just failed.
	autoNew
	// autoAll: scheduled and requested checks.
	autoAll
)

// Check asks the source for the latest release and updates the state. A failed check
// leaves the state as it was and records LastCheckError. A newer release starts
// downloading at once (see the package doc).
func (s *Store) Check(ctx context.Context) (Status, error) {
	return s.check(ctx, autoAll)
}

func (s *Store) check(ctx context.Context, mode autoMode) (Status, error) {
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
	case err != nil && ctx.Err() != nil:
		// The caller gave up (or the daemon is stopping): not a failed check.
	case err != nil:
		st.LastCheckedAt = now
		st.LastCheckError = err.Error()
	default:
		st.LastCheckedAt = now
		st.LastCheckError = ""
		st.Latest = tag
		s.applyLatest(tag)
		s.autoLocked(mode)
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
	staged := s.staged()
	next, target := decide(st.State, st.Target, s.opts.Current, s.onDisk(), staged, tag)
	if st.State == Downloaded && next == Available && staged == st.Target {
		// Keep the download installable; autoLocked replaces it in the background.
		return
	}
	s.moveTo(next, target)
}

// autoLocked starts what a check may start by itself (see autoMode): the download of an
// available version, or the replacement of a download by a newer release. Caller holds
// mu.
func (s *Store) autoLocked(mode autoMode) {
	st := &s.status
	if mode == autoNone || s.opts.ManualDownload || s.installing || s.ctx.Err() != nil {
		return
	}
	switch st.State {
	case Available:
		// A replacement whose stage swap is in progress can leave nothing staged for a
		// moment; it decides.
		if s.replacing != "" || s.skipAutoLocked(mode, st.Target) {
			return
		}
		s.log.Info("downloading update automatically", "version", st.Target)
		s.startDownloadLocked(st.Target, true)
	case Downloaded:
		if s.replacing != "" || !Newer(st.Latest, st.Target) || s.skipAutoLocked(mode, st.Latest) {
			return
		}
		s.startReplaceLocked(st.Latest)
	}
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

// Download checks for the latest release, then starts downloading and staging the
// version it offers and returns at once. Allowed from Available and Failed (a retry).
// The check comes first because the release an earlier check saw may be gone: tip
// releases beyond the newest five are deleted, so retrying the old version would fail
// the same way every time while a newer one is out. A failed check does not stop the
// download; it uses the version already offered.
func (s *Store) Download(ctx context.Context) (Status, error) {
	if !s.Snapshot().Enabled {
		return s.Snapshot(), fmt.Errorf("%w: %s", ErrDisabled, s.opts.DisabledReason)
	}
	// A channel switched during the check makes it drop its answer: check again for the
	// new channel rather than download the old channel's release.
	for range 2 {
		ch := s.Snapshot().Channel
		if _, err := s.check(ctx, autoNone); err != nil && ctx.Err() == nil {
			s.log.Warn("update check before download failed; downloading the version offered", "err", err)
		}
		if s.Snapshot().Channel == ch {
			break
		}
	}
	// The caller gave up while the check ran (Ctrl-C in `code-foundry update`): start
	// nothing it is not waiting for.
	if err := ctx.Err(); err != nil {
		return s.Snapshot(), err
	}
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
	s.startDownloadLocked(st.Target, false)
	return *st, nil
}

// startDownloadLocked moves to Downloading and downloads target in the background. auto
// marks a download no one asked for: its failure goes back to Available. Caller holds mu.
func (s *Store) startDownloadLocked(target string, auto bool) {
	s.moveTo(Downloading, target)
	s.status.Progress = "starting download"
	s.publishLocked()
	s.wg.Go(func() { s.runDownload(target, auto) })
}

func (s *Store) runDownload(target string, auto bool) {
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
	if err != nil {
		s.noteFailureLocked(target)
	}
	switch {
	case err != nil && auto && s.failCount < MaxAutoAttempts:
		// Nobody asked for it: offer it as before automatic downloads (the Download
		// button) and try again at the next check.
		s.log.Warn("automatic update download failed; trying again at the next check", "version", target, "attempt", s.failCount, "err", err)
		s.moveTo(Available, target)
		s.status.FailureReason = err.Error()
	case err != nil:
		if auto {
			s.log.Warn("automatic update download failed again; not retrying it automatically", "version", target, "attempts", s.failCount, "err", err)
		} else {
			s.log.Warn("update download failed", "version", target, "err", err)
		}
		s.moveTo(Failed, target)
		s.status.FailureReason = err.Error()
	default:
		s.log.Info("update downloaded; restart Code Foundry to install it", "version", target)
		if s.failedTag == target {
			s.failedTag, s.failCount = "", 0
		}
		s.moveTo(Downloaded, target)
		// A newer release seen while this one downloaded replaces it at once.
		s.autoLocked(autoNew)
	}
	s.publishLocked()
	s.mu.Unlock()
	if err == nil {
		return
	}
	// The release may have been deleted since it was offered (a pruned tip): check at
	// once, so a newer release replaces the failure instead of waiting for the next
	// scheduled check. The failure stays when the same version is still the latest.
	if _, cerr := s.check(s.ctx, autoNew); cerr != nil && s.ctx.Err() == nil {
		s.log.Warn("update check after a failed download failed", "err", cerr)
	}
}

// startReplaceLocked downloads tag in the background while Downloaded stays installable;
// the installer swaps it into the stage only once complete. Caller holds mu.
func (s *Store) startReplaceLocked(tag string) {
	ctx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	s.replacing, s.replaceCancel, s.replaceDone = tag, cancel, done
	s.log.Info("downloading a newer update to replace the downloaded one", "version", tag, "downloaded", s.status.Target)
	s.wg.Go(func() {
		defer close(done)
		defer cancel()
		s.runReplace(ctx, tag)
	})
}

func (s *Store) runReplace(ctx context.Context, tag string) {
	err := s.opts.Installer.Download(ctx, tag, func(string) {})
	staged := s.staged()
	if err == nil && staged != tag {
		err = fmt.Errorf("%w: found %s", errStagedMismatch, cmp.Or(staged, "nothing"))
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.replacing, s.replaceCancel, s.replaceDone = "", nil, nil
	if s.installing {
		return // Install cancelled it and decides
	}
	st := &s.status
	if err != nil {
		switch {
		case s.ctx.Err() != nil: // stopping
		case ctx.Err() != nil:
			s.log.Info("replacing the downloaded update cancelled; keeping it", "version", tag, "downloaded", st.Target)
		default:
			s.log.Warn("replacing the downloaded update failed; keeping it", "version", tag, "downloaded", st.Target, "err", err)
			s.noteFailureLocked(tag)
		}
		if staged != st.Target && st.State == Downloaded {
			// The stage changed anyway (by hand, or a swap that half happened): describe
			// what is there now.
			next, target := decide(Idle, "", s.opts.Current, s.onDisk(), staged, st.Latest)
			s.moveTo(next, target)
			s.publishLocked()
		}
		return
	}
	if st.State != Downloaded {
		return
	}
	s.log.Info("newer update downloaded; restart Code Foundry to install it", "version", tag, "replaced", st.Target)
	if s.failedTag == tag {
		s.failedTag, s.failCount = "", 0
	}
	s.moveTo(Downloaded, tag)
	s.publishLocked()
	// An even newer release seen meanwhile replaces it in turn.
	s.autoLocked(autoNew)
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
	cancelReplace, replaceDone := s.replaceCancel, s.replaceDone
	s.mu.Unlock()

	if replaceDone != nil {
		// Restart Now does not wait for a newer download: install the one staged.
		s.log.Info("cancelling the newer download to install the downloaded update", "version", target)
		cancelReplace()
		<-replaceDone
		// It may have finished first; then the newer version is what is staged.
		if v := s.staged(); Newer(v, target) {
			target = v
		}
	}

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
