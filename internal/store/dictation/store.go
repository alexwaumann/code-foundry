// Package dictation is voice dictation into the app's composers
// (docs/notes/dictation-2-daemon.md). The store owns the model file (downloaded on
// request, resumed, verified) and the engine process (code-foundry-dictate, whisper.cpp
// behind a small JSON protocol over stdio), and runs one dictation session at a time:
// the Wails host's microphone frames go in, the engine's phrases come out on the bus.
//
// Lifecycle: with dictation.enabled on and the model on disk the engine runs with the
// model loaded from daemon start, so pressing the mic is instant. Not attended for
// UnloadAfter (internal/presence) stops the engine, freeing the model; attended again
// starts it and loads the model. The
// engine unloading it by itself (memory pressure) leaves it unloaded until the next
// Start. A crash restarts the engine with backoff, MaxRestarts times, then the state is
// Failed until dictation is turned off and on, or the model is removed.
//
//	Disabled ──enable──► NoModel ──Download──► Downloading ──ok (turns enabled on)──┐
//	   ▲                                                                            ▼
//	   └──disable── Ready ◄──load── Loading ◄──────────────────────────── (engine starts)
//	                │  ▲                ▲
//	          Start │  │ Stop/silence   └── attended again / Start ── Unloaded ◄── away 10 min
//	                ▼  │
//	              Listening            crash ×4 ──► Failed
package dictation

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/dictate"
)

// Timing.
const (
	// UnloadAfter is how long the user may be away from the app (not attended) before
	// the model is unloaded (the engine stops).
	UnloadAfter = 10 * time.Minute
	// SilenceStop ends a session after this long without speech.
	SilenceStop = 30 * time.Second
	// FirstAudioWait ends a session that never gets a frame of audio. Silence counts
	// only from the first frame, so a first press that waits on macOS's microphone
	// prompt is not ended while the prompt is up.
	FirstAudioWait = 2 * time.Minute
	// FlushWait bounds how long Stop waits for the engine to finish a session.
	FlushWait = 1500 * time.Millisecond
	// MaxRestarts is how many times a failed engine is restarted before Failed.
	MaxRestarts = 3
	// levelEvery bounds a session's level events (20 a second).
	levelEvery = 50 * time.Millisecond
	// loadTimeout bounds loading the model, and Start waiting for it.
	loadTimeout = 2 * time.Minute
	// callTimeout bounds the engine's other requests.
	callTimeout = 5 * time.Second
)

// restartBackoff is the wait before each restart.
var restartBackoff = [MaxRestarts]time.Duration{time.Second, 4 * time.Second, 15 * time.Second}

// State is dictation's state. See the package doc.
type State int

// States.
const (
	Disabled State = iota + 1
	NoModel
	Downloading
	Loading
	Ready
	Unloaded
	Listening
	Failed
)

func (s State) String() string {
	switch s {
	case Disabled:
		return "disabled"
	case NoModel:
		return "no-model"
	case Downloading:
		return "downloading"
	case Loading:
		return "loading"
	case Ready:
		return "ready"
	case Unloaded:
		return "unloaded"
	case Listening:
		return "listening"
	case Failed:
		return "error"
	}
	return fmt.Sprintf("State(%d)", int(s))
}

// EndReason is why a session ended.
type EndReason int

// End reasons.
const (
	EndStopped EndReason = iota + 1
	EndSilence
	EndDisabled
	EndError
)

func (r EndReason) String() string {
	switch r {
	case EndStopped:
		return "stopped"
	case EndSilence:
		return "silence"
	case EndDisabled:
		return "disabled"
	case EndError:
		return "error"
	}
	return fmt.Sprintf("EndReason(%d)", int(r))
}

// Errors. internal/api maps ErrBusy to Aborted, ErrUnknownSession to NotFound and the
// others to FailedPrecondition.
var (
	ErrDisabled       = errors.New("dictation is off (settings: dictation.enabled)")
	ErrNoModel        = errors.New("the dictation model is not downloaded")
	ErrDownloaded     = errors.New("the dictation model is already downloaded")
	ErrBusy           = errors.New("another composer is dictating; stop it first")
	ErrEngine         = errors.New("the dictation engine failed")
	ErrUnknownSession = errors.New("no such dictation session")
)

// ModelState is the model as the snapshot shows it.
type ModelState struct {
	Name, Title string
	Size        int64
	Downloaded  bool
	// Download is the running download's progress; nil when none runs.
	Download *Progress
}

// Session is the open session.
type Session struct {
	ID, ClientID string
	StartedAt    time.Time
}

// Snapshot is the store's published state.
type Snapshot struct {
	Enabled  bool
	State    State
	Model    ModelState
	Hardware Hardware
	// Session is set while Listening.
	Session *Session
	// Error is the engine's failure while Failed, else the last download's failure.
	Error     string
	MicDenied bool
}

// Changed is published on the bus with every new snapshot.
type Changed struct{ Snapshot Snapshot }

// SessionEventKind says which of SessionEvent's fields is set.
type SessionEventKind int

// Session event kinds.
const (
	SessionLevel SessionEventKind = iota + 1
	SessionPhrase
	SessionEnded
)

// SessionEvent is published on the bus for a session's Session stream.
type SessionEvent struct {
	SessionID string
	Kind      SessionEventKind
	RMS       float32   // SessionLevel
	Text      string    // SessionPhrase
	Reason    EndReason // SessionEnded
}

// Options configures a Store.
type Options struct {
	// Dir is the models directory (paths.DictationModels).
	Dir string
	Bus *bus.Bus
	Log *slog.Logger
	// Enabled reads dictation.enabled; ConfigChanged reads it again.
	Enabled func() bool
	// Enable turns dictation.enabled on: a finished download calls it, so dictation is
	// on once the model is there. Nil does nothing.
	Enable func() error
	// Attended reports whether the user is looking at the app now (presence); the
	// daemon calls AttendedChanged on every change.
	Attended func() bool
	// Launch starts the engine.
	Launch Launcher
	// Client downloads the model from a URL source (default http.DefaultClient).
	Client *http.Client
	// Gh fetches a GitHub release source (default ExecGh{} with gh from PATH).
	Gh GhRunner
	// Clock defaults to the real one.
	Clock Clock
	// Hardware defaults to ReadHardware.
	Hardware func() Hardware
	// Model defaults to DefaultModel().
	Model Model
}

// phase is the engine's lifecycle.
type phase int

const (
	phaseStopped  phase = iota // no engine
	phaseUnloaded              // running without the model
	phaseLoading
	phaseReady
)

type download struct {
	cancel   context.CancelFunc
	done     chan struct{}
	progress Progress
}

type session struct {
	id, clientID string
	started      time.Time
	// begun: the engine accepted begin; audio flows.
	begun bool
	// heard: a frame of audio arrived, so the silence clock runs.
	heard    bool
	stopping bool
	// silence ends the session after SilenceStop without speech; silenceGen tells a
	// stale timer from the current one.
	silence    Timer
	silenceGen int
	lastLevel  time.Time
}

// Store is the dictation store. Create with New, stop with Close.
type Store struct {
	opts  Options
	log   *slog.Logger
	clock Clock
	ctx   context.Context
	stop  context.CancelFunc
	wg    sync.WaitGroup
	kick  chan struct{}
	snap  atomic.Pointer[Snapshot]
	hw    Hardware

	mu       sync.Mutex
	enabled  bool
	onDisk   bool
	dl       *download
	dlErr    string
	eng      Engine
	engGen   int
	phase    phase
	failures int
	failErr  string
	retry    Timer
	attended bool
	idle     Timer
	idleGen  int
	// idleUnload: the user was away UnloadAfter; pressureUnload: the engine dropped
	// the model. Either keeps it unloaded (until presence returns, or the next Start).
	idleUnload     bool
	pressureUnload bool
	// handled counts the current engine's events handled; handledCh is closed and
	// replaced after each (stopSession waits on it).
	handled   uint64
	handledCh chan struct{}
	session   *session
	ended     map[string]EndReason // sessions that ended, for a late Session stream
	micDenied bool
	// changed is closed and replaced on every publish (Start waits on it).
	changed chan struct{}
}

// New opens the store and starts its supervisor: the engine starts at once when
// dictation is on and the model is there.
func New(opts Options) *Store {
	if opts.Log == nil {
		opts.Log = slog.New(slog.DiscardHandler)
	}
	if opts.Clock == nil {
		opts.Clock = realClock{}
	}
	if opts.Client == nil {
		opts.Client = http.DefaultClient
	}
	if opts.Gh == nil {
		opts.Gh = ExecGh{}
	}
	if opts.Hardware == nil {
		opts.Hardware = ReadHardware
	}
	if opts.Model.Name == "" {
		opts.Model = DefaultModel()
	}
	if opts.Enabled == nil {
		opts.Enabled = func() bool { return false }
	}
	if opts.Attended == nil {
		opts.Attended = func() bool { return false }
	}
	ctx, stop := context.WithCancel(context.Background())
	s := &Store{
		opts: opts, log: opts.Log, clock: opts.Clock, ctx: ctx, stop: stop, kick: make(chan struct{}, 1),
		hw: opts.Hardware(), ended: map[string]EndReason{}, changed: make(chan struct{}), handledCh: make(chan struct{}),
	}
	s.mu.Lock()
	s.enabled = opts.Enabled()
	s.onDisk = s.modelOnDisk()
	s.attended = opts.Attended()
	if !s.attended {
		s.armIdleLocked()
	}
	s.publishLocked()
	s.mu.Unlock()
	s.wg.Go(s.loop)
	s.poke()
	return s
}

// Close stops the engine, a running download and the supervisor.
func (s *Store) Close() {
	s.mu.Lock()
	eng := s.detachLocked(EndDisabled)
	dl := s.dl
	s.mu.Unlock()
	if dl != nil {
		dl.cancel()
	}
	s.stop()
	if eng != nil {
		eng.Close()
	}
	s.wg.Wait()
}

// Snapshot returns the current state.
func (s *Store) Snapshot() Snapshot { return *s.snap.Load() }

// ModelPath is where the model lives.
func (s *Store) ModelPath() string { return filepath.Join(s.opts.Dir, s.opts.Model.Name) }

func (s *Store) modelOnDisk() bool {
	fi, err := os.Stat(s.ModelPath())
	return err == nil && fi.Mode().IsRegular() && fi.Size() == s.opts.Model.Size
}

// ConfigChanged reads dictation.enabled again: off stops the engine (ending a session),
// on starts it. Off also clears a failure, so off and on retries.
func (s *Store) ConfigChanged() {
	en := s.opts.Enabled()
	s.mu.Lock()
	if en == s.enabled {
		s.mu.Unlock()
		return
	}
	s.enabled = en
	var eng Engine
	if !en {
		eng = s.detachLocked(EndDisabled)
		s.clearFailureLocked()
	}
	s.publishLocked()
	s.mu.Unlock()
	if eng != nil {
		s.wg.Go(eng.Close)
	}
	s.poke()
}

// AttendedChanged follows presence: away for UnloadAfter unloads the model, back loads
// it again.
func (s *Store) AttendedChanged(attended bool) {
	s.mu.Lock()
	s.attended = attended
	if attended {
		s.stopIdleLocked()
		s.idleUnload = false
	} else {
		s.armIdleLocked()
	}
	s.mu.Unlock()
	s.poke()
}

func (s *Store) armIdleLocked() {
	s.stopIdleLocked()
	gen := s.idleGen
	s.idle = s.clock.AfterFunc(UnloadAfter, func() {
		s.mu.Lock()
		if s.idleGen == gen && !s.attended {
			s.idleUnload = true
		}
		s.mu.Unlock()
		s.poke()
	})
}

func (s *Store) stopIdleLocked() {
	s.idleGen++
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
}

// MicDenied records what the host reported about the microphone permission.
func (s *Store) MicDenied(denied bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.micDenied != denied {
		s.micDenied = denied
		s.publishLocked()
	}
}

// ---- download ------------------------------------------------------------------

// Download starts downloading the model and returns at once. A download already
// running is left to run.
func (s *Store) Download() (Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.onDisk {
		return *s.snap.Load(), ErrDownloaded
	}
	if s.dl != nil {
		return *s.snap.Load(), nil
	}
	ctx, cancel := context.WithCancel(s.ctx)
	dl := &download{cancel: cancel, done: make(chan struct{}), progress: Progress{Total: s.opts.Model.Size}}
	s.dl, s.dlErr = dl, ""
	s.publishLocked()
	s.wg.Go(func() { s.runDownload(ctx, dl) })
	return *s.snap.Load(), nil
}

func (s *Store) runDownload(ctx context.Context, dl *download) {
	defer dl.cancel()
	m := s.opts.Model
	s.log.Info("downloading the dictation model", "model", m.Name, "bytes", m.Size)
	var source string
	err := os.MkdirAll(s.opts.Dir, 0o700)
	if err == nil {
		f := fetcher{client: s.opts.Client, gh: s.opts.Gh, log: s.log, now: s.clock.Now, progress: func(p Progress) {
			s.mu.Lock()
			if s.dl == dl {
				dl.progress = p
				s.publishLocked()
			}
			s.mu.Unlock()
		}}
		source, err = f.fetch(ctx, m, s.ModelPath())
	}
	s.mu.Lock()
	s.dl = nil
	switch {
	case err == nil:
		s.onDisk = true
		s.clearFailureLocked()
		s.log.Info("dictation model downloaded", "path", s.ModelPath(), "source", source)
	case ctx.Err() != nil:
		s.log.Info("dictation model download cancelled")
	default:
		s.dlErr = downloadMessage(err)
		s.log.Warn("dictation model download failed", "err", err)
	}
	s.publishLocked()
	// After the publish: CancelDownload returns the snapshot it waited for.
	close(dl.done)
	s.mu.Unlock()
	if err == nil && s.opts.Enable != nil {
		if err := s.opts.Enable(); err != nil {
			s.log.Warn("could not turn dictation on after the download", "err", err)
		}
	}
	s.poke()
}

// downloadMessage is a failed download's snapshot error. A *DownloadError says
// "Download failed: " itself; the GUI and CLI show the message as it is.
func downloadMessage(err error) string {
	if de, ok := errors.AsType[*DownloadError](err); ok {
		return de.Error()
	}
	return "Download failed: " + err.Error()
}

// CancelDownload stops a running download and waits for it, keeping the partial file
// for the next Download to resume.
func (s *Store) CancelDownload() Snapshot {
	s.mu.Lock()
	dl := s.dl
	s.mu.Unlock()
	if dl != nil {
		dl.cancel()
		<-dl.done
	}
	return s.Snapshot()
}

// RemoveModel cancels a download, stops the engine (ending a session) and deletes the
// model and any partial download.
func (s *Store) RemoveModel() (Snapshot, error) {
	s.CancelDownload()
	s.mu.Lock()
	eng := s.detachLocked(EndDisabled)
	s.onDisk = false
	s.dlErr = ""
	s.clearFailureLocked()
	s.publishLocked()
	s.mu.Unlock()
	if eng != nil {
		eng.Close()
	}
	var errs []error
	for _, p := range []string{s.ModelPath(), s.ModelPath() + partSuffix} {
		if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	s.poke()
	return s.Snapshot(), errors.Join(errs...)
}

// ---- engine supervisor -----------------------------------------------------------

func (s *Store) poke() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// loop runs reconcile after every poke: the only goroutine that starts engines and
// loads and unloads the model.
func (s *Store) loop() {
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-s.kick:
		}
		s.reconcile()
	}
}

// reconcile moves the engine towards what the state wants: running while enabled with
// the model, loaded unless the user is away or the engine dropped it.
func (s *Store) reconcile() {
	s.mu.Lock()
	want := s.enabled && s.onDisk && s.dl == nil
	if !want || s.failErr != "" || s.retry != nil || s.ctx.Err() != nil {
		var eng Engine
		if !want {
			eng = s.detachLocked(EndDisabled)
		}
		s.mu.Unlock()
		if eng != nil {
			eng.Close()
		}
		return
	}
	if s.eng == nil && s.idleUnload {
		// Away: the engine stays down until the user returns or dictates.
		s.publishLocked()
		s.mu.Unlock()
		return
	}
	if s.eng == nil {
		s.phase = phaseLoading // the engine is starting: LOADING
		s.publishLocked()
		s.mu.Unlock()
		eng, err := s.opts.Launch(s.ctx)
		s.mu.Lock()
		if err != nil {
			s.failLocked(err, errors.Is(err, ErrEngineMissing))
			s.publishLocked()
			s.mu.Unlock()
			return
		}
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			eng.Close()
			return
		}
		s.eng, s.phase, s.handled = eng, phaseUnloaded, 0
		s.engGen++
		gen := s.engGen
		s.wg.Go(func() { s.watch(eng, gen) })
		s.log.Info("dictation engine started")
	}
	eng := s.eng
	wantLoaded := !s.idleUnload && !s.pressureUnload
	switch {
	case wantLoaded && s.phase == phaseUnloaded:
		s.phase = phaseLoading
		s.publishLocked()
		s.mu.Unlock()
		ctx, cancel := context.WithTimeout(s.ctx, loadTimeout)
		var res dictate.LoadResult
		err := eng.Call(ctx, dictate.MethodLoad, dictate.LoadParams{Model: s.ModelPath(), Language: dictate.Language}, &res)
		cancel()
		s.mu.Lock()
		if s.eng != eng { // stopped meanwhile
			s.mu.Unlock()
			s.poke()
			return
		}
		if err != nil {
			s.log.Warn("dictation model did not load", "err", err)
			s.detachLocked(EndError)
			s.failLocked(err, false)
			s.publishLocked()
			s.mu.Unlock()
			eng.Close()
			return
		}
		s.phase = phaseReady
		s.failures = 0
		s.log.Info("dictation model loaded", "load_ms", res.LoadMS, "rss_bytes", res.RSSBytes)
		s.publishLocked()
		s.mu.Unlock()
		s.poke() // presence may have moved while it loaded
	case s.idleUnload && s.session == nil:
		// Away: stop the engine rather than unload in it, which keeps ggml's and Metal's
		// residue (about 170 MB; docs/notes/dictation-1-engine.md).
		s.detachLocked(EndDisabled)
		s.publishLocked()
		s.mu.Unlock()
		eng.Close()
		s.log.Info("dictation engine stopped while the user is away")
	default:
		s.mu.Unlock()
	}
}

// watch handles one engine's events until it exits; an exit nobody asked for is a
// failure.
func (s *Store) watch(eng Engine, gen int) {
	for ev := range eng.Events() {
		s.handle(gen, ev)
	}
	<-eng.Done()
	s.mu.Lock()
	if s.eng != eng {
		s.mu.Unlock()
		return
	}
	err := eng.Err()
	if err == nil {
		err = errors.New("the engine exited")
	}
	s.log.Warn("dictation engine stopped", "err", err)
	s.detachLocked(EndError)
	s.failLocked(err, false)
	s.publishLocked()
	s.mu.Unlock()
}

func (s *Store) handle(gen int, ev Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.engGen != gen || s.eng == nil {
		return
	}
	defer func() {
		s.handled++
		close(s.handledCh)
		s.handledCh = make(chan struct{})
	}()
	switch ev.Name {
	case dictate.EventSpeech:
		var p dictate.SpeechEvent
		if json.Unmarshal(ev.Params, &p) != nil {
			return
		}
		if sess := s.session; sess != nil && sess.id == p.Session && !sess.stopping {
			if p.Active {
				s.stopSilenceLocked(sess)
			} else {
				s.armSilenceLocked(sess, SilenceStop)
			}
		}
	case dictate.EventPhrase:
		var p dictate.PhraseEvent
		if json.Unmarshal(ev.Params, &p) != nil || p.Text == "" {
			return
		}
		if sess := s.session; sess != nil && sess.id == p.Session {
			s.log.Debug("dictation phrase", "chars", len(p.Text), "infer_ms", p.InferMS)
			s.emit(SessionEvent{SessionID: p.Session, Kind: SessionPhrase, Text: p.Text})
		}
	case dictate.EventUnloaded:
		var p dictate.UnloadedEvent
		_ = json.Unmarshal(ev.Params, &p)
		s.log.Info("dictation engine unloaded the model", "reason", p.Reason)
		s.pressureUnload = true
		s.phase = phaseUnloaded
		s.endSessionLocked(EndError)
		s.publishLocked()
	case dictate.EventError:
		var p dictate.ErrorEvent
		_ = json.Unmarshal(ev.Params, &p)
		s.log.Warn("dictation engine error", "message", p.Message)
	case dictate.EventState:
		var p dictate.StateEvent
		_ = json.Unmarshal(ev.Params, &p)
		s.log.Debug("dictation engine state", "state", p.State)
	}
}

// detachLocked takes the engine out of the store (ending the session with why) and
// returns it for the caller to Close outside the lock; nil when none ran.
func (s *Store) detachLocked(why EndReason) Engine {
	eng := s.eng
	s.eng = nil
	s.phase = phaseStopped
	s.endSessionLocked(why)
	return eng
}

// failLocked counts a failure: a restart after the backoff, or Failed once restarts
// are used up (at once when permanent).
func (s *Store) failLocked(err error, permanent bool) {
	s.failures++
	if permanent || s.failures > MaxRestarts {
		s.failErr = err.Error()
		s.log.Error("dictation engine failed", "err", err, "failures", s.failures)
		return
	}
	d := restartBackoff[s.failures-1]
	s.log.Warn("dictation engine failed; restarting", "err", err, "in", d)
	var t Timer
	t = s.clock.AfterFunc(d, func() {
		s.mu.Lock()
		if s.retry == t {
			s.retry = nil
		}
		s.mu.Unlock()
		s.poke()
	})
	s.retry = t
}

func (s *Store) clearFailureLocked() {
	s.failures, s.failErr = 0, ""
	if s.retry != nil {
		s.retry.Stop()
		s.retry = nil
	}
}

// ---- sessions --------------------------------------------------------------------

// Start opens a session for clientID and returns its id, loading the model first when
// it was unloaded (bounded by ctx). The same client starting again gets its open
// session; another client gets ErrBusy.
func (s *Store) Start(ctx context.Context, clientID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, loadTimeout)
	defer cancel()
	s.mu.Lock()
	for {
		switch {
		case !s.enabled:
			s.mu.Unlock()
			return "", ErrDisabled
		case !s.onDisk || s.dl != nil:
			s.mu.Unlock()
			return "", ErrNoModel
		case s.failErr != "":
			err := fmt.Errorf("%w: %s", ErrEngine, s.failErr)
			s.mu.Unlock()
			return "", err
		}
		if sess := s.session; sess != nil {
			s.mu.Unlock()
			if sess.clientID == clientID && !sess.stopping {
				return sess.id, nil
			}
			return "", ErrBusy
		}
		if s.eng != nil && s.phase == phaseReady {
			break
		}
		// Not loaded: whatever unloaded it, this use loads it again (an away user is
		// unloaded again UnloadAfter from now).
		if s.pressureUnload || s.idleUnload {
			s.pressureUnload, s.idleUnload = false, false
			if !s.attended {
				s.armIdleLocked()
			}
		}
		changed := s.changed
		s.mu.Unlock()
		s.poke()
		select {
		case <-changed:
		case <-ctx.Done():
			return "", fmt.Errorf("the dictation model did not load: %w", ctx.Err())
		}
		s.mu.Lock()
	}
	sess := &session{id: newSessionID(), clientID: clientID, started: s.clock.Now()}
	s.session = sess
	eng := s.eng
	s.mu.Unlock()

	bctx, bcancel := context.WithTimeout(ctx, callTimeout)
	err := eng.Call(bctx, dictate.MethodBegin, dictate.BeginParams{Session: sess.id}, nil)
	bcancel()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != sess {
		return "", fmt.Errorf("%w: dictation stopped while starting", ErrUnknownSession)
	}
	if err != nil {
		s.session = nil
		s.publishLocked()
		return "", fmt.Errorf("start dictation: %w", err)
	}
	sess.begun = true
	s.armSilenceLocked(sess, FirstAudioWait)
	s.log.Info("dictation started", "session", sess.id, "client", clientID)
	s.publishLocked()
	return sess.id, nil
}

// Stop ends the session. With flush the engine transcribes what it holds first, its
// phrases published before the end (bounded by FlushWait). An unknown or ended session
// is not an error.
func (s *Store) Stop(ctx context.Context, sessionID string, flush bool) error {
	s.stopSession(ctx, sessionID, flush, EndStopped)
	return nil
}

func (s *Store) stopSession(ctx context.Context, sessionID string, flush bool, why EndReason) {
	s.mu.Lock()
	sess := s.session
	if sess == nil || sess.id != sessionID || sess.stopping {
		s.mu.Unlock()
		return
	}
	sess.stopping = true
	s.stopSilenceLocked(sess)
	eng := s.eng
	if eng != nil && sess.begun {
		s.mu.Unlock()
		ectx, cancel := context.WithTimeout(ctx, FlushWait)
		if err := eng.Call(ectx, dictate.MethodEnd, dictate.EndParams{Session: sessionID, Flush: flush}, nil); err != nil {
			s.log.Warn("dictation session did not end cleanly", "session", sessionID, "err", err)
		}
		s.awaitEventsLocked(ectx, eng, eng.Enqueued())
		cancel()
	}
	if s.session == sess {
		s.endSessionLocked(why)
		s.publishLocked()
	}
	s.mu.Unlock()
	s.poke() // an unload may have waited for the session
}

// Audio forwards one frame of the listening session to the engine and republishes its
// level (at most every levelEvery). It reports whether the frame was taken: frames of
// another session, or of one stopping, are dropped.
func (s *Store) Audio(sessionID string, pcm []byte, rms float32) bool {
	s.mu.Lock()
	sess := s.session
	if sess == nil || sess.id != sessionID || !sess.begun || sess.stopping || s.eng == nil {
		s.mu.Unlock()
		return false
	}
	eng := s.eng
	if !sess.heard {
		sess.heard = true
		s.armSilenceLocked(sess, SilenceStop)
	}
	if now := s.clock.Now(); now.Sub(sess.lastLevel) >= levelEvery {
		sess.lastLevel = now
		s.emit(SessionEvent{SessionID: sessionID, Kind: SessionLevel, RMS: rms})
	}
	s.mu.Unlock()
	if err := eng.Notify(dictate.MethodAudio, dictate.AudioParams{Session: sessionID, PCM: pcm}); err != nil {
		s.log.Debug("dictation audio not delivered", "err", err)
		return false
	}
	return true
}

// awaitEventsLocked returns (holding mu) once the watcher has handled the first n
// events of eng, eng stopped, or ctx ended: the phrases a flush sent before its reply
// are published before the session's end.
func (s *Store) awaitEventsLocked(ctx context.Context, eng Engine, n uint64) {
	s.mu.Lock()
	for s.eng == eng && s.handled < n {
		ch := s.handledCh
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			s.mu.Lock()
			return
		}
		s.mu.Lock()
	}
}

// SessionEnded reports a session's end: ok false for an id the store never opened (or
// forgot), ended false while it is open.
func (s *Store) SessionEnded(sessionID string) (reason EndReason, ended, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.session != nil && s.session.id == sessionID {
		return 0, false, true
	}
	r, ok := s.ended[sessionID]
	return r, ok, ok
}

// armSilenceLocked (re)starts the clock that ends sess after d: FirstAudioWait until
// its first frame, then SilenceStop from the first frame and from each end of speech.
func (s *Store) armSilenceLocked(sess *session, d time.Duration) {
	s.stopSilenceLocked(sess)
	gen := sess.silenceGen
	sess.silence = s.clock.AfterFunc(d, func() {
		s.mu.Lock()
		current := s.session == sess && sess.silenceGen == gen
		s.mu.Unlock()
		if current {
			s.log.Info("dictation stopped after silence", "session", sess.id)
			s.stopSession(s.ctx, sess.id, false, EndSilence)
		}
	})
}

func (s *Store) stopSilenceLocked(sess *session) {
	sess.silenceGen++
	if sess.silence != nil {
		sess.silence.Stop()
		sess.silence = nil
	}
}

// maxEnded bounds the ended sessions kept for a late Session stream.
const maxEnded = 32

// endSessionLocked ends the open session with why, publishing its last event. The
// caller publishes the snapshot.
func (s *Store) endSessionLocked(why EndReason) {
	sess := s.session
	if sess == nil {
		return
	}
	s.stopSilenceLocked(sess)
	s.session = nil
	if len(s.ended) >= maxEnded {
		clear(s.ended)
	}
	s.ended[sess.id] = why
	s.log.Info("dictation ended", "session", sess.id, "reason", why.String())
	s.emit(SessionEvent{SessionID: sess.id, Kind: SessionEnded, Reason: why})
}

// emit publishes a session event.
func (s *Store) emit(ev SessionEvent) {
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, ev)
	}
}

func newSessionID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return "dict-" + hex.EncodeToString(b)
}

// ---- snapshot --------------------------------------------------------------------

func (s *Store) stateLocked() State {
	switch {
	case s.dl != nil:
		return Downloading
	case !s.enabled:
		return Disabled
	case !s.onDisk:
		return NoModel
	case s.failErr != "":
		return Failed
	case s.session != nil && s.session.begun:
		return Listening
	case s.phase == phaseReady:
		return Ready
	case s.idleUnload && s.eng == nil, s.pressureUnload && s.phase == phaseUnloaded:
		return Unloaded
	}
	return Loading
}

// publishLocked makes a new snapshot and publishes it when it changed. Publishing under
// mu keeps events in order.
func (s *Store) publishLocked() {
	m := s.opts.Model
	snap := &Snapshot{
		Enabled: s.enabled, State: s.stateLocked(), Hardware: s.hw, MicDenied: s.micDenied,
		Model: ModelState{Name: m.Name, Title: m.Title, Size: m.Size, Downloaded: s.onDisk},
		Error: s.dlErr,
	}
	if s.failErr != "" {
		snap.Error = s.failErr
	}
	if s.dl != nil {
		p := s.dl.progress
		snap.Model.Download = &p
	}
	if sess := s.session; sess != nil && sess.begun {
		snap.Session = &Session{ID: sess.id, ClientID: sess.clientID, StartedAt: sess.started}
	}
	if old := s.snap.Load(); old != nil && equal(old, snap) {
		return
	}
	s.snap.Store(snap)
	close(s.changed)
	s.changed = make(chan struct{})
	if s.opts.Bus != nil {
		bus.Publish(s.opts.Bus, Changed{Snapshot: *snap})
	}
}

func equal(a, b *Snapshot) bool {
	if a.Enabled != b.Enabled || a.State != b.State || a.Hardware != b.Hardware || a.Error != b.Error ||
		a.MicDenied != b.MicDenied || a.Model.Downloaded != b.Model.Downloaded {
		return false
	}
	if (a.Model.Download == nil) != (b.Model.Download == nil) || (a.Model.Download != nil && *a.Model.Download != *b.Model.Download) {
		return false
	}
	if (a.Session == nil) != (b.Session == nil) || (a.Session != nil && *a.Session != *b.Session) {
		return false
	}
	return true
}
