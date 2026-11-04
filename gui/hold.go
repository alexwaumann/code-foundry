package main

import (
	"context"
	"log/slog"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The hold key (docs/notes/dictate-anywhere.md): hold Option, speak, release, and the text
// lands. One path, two destinations. With Code Foundry in front and a composer to dictate
// into, the window runs the session through dictation.hold, exactly as its mic does. Anywhere
// else, with dictation.anywhere on, the host opens a "system" session itself, collects the
// phrases and pastes once.
//
// Nothing here may hold up the tap, or the next key: the service's loop only reads events
// and hands out work. A run per hold talks to the daemon, and one goroutine pastes.

const (
	// holdToneDelay is how long after the press the start tone waits, so a press cancelled
	// by a shortcut stays silent.
	holdToneDelay = 40 * time.Millisecond
	// holdFlushWait bounds the wait for a released session's end (the daemon's own bound is
	// 2.2 s, the tail and the flush): after it, what arrived is pasted.
	holdFlushWait = 3 * time.Second
	// holdTrustPoll is how often the host looks at the grant while it needs to know: not
	// granted yet, or a new tap that has heard nothing so far.
	holdTrustPoll = time.Second
	// holdTrustRecheck is how often it looks once all is well, to notice a revoked grant.
	holdTrustRecheck = 5 * time.Second
	// tapSilentChecks is how many checks in a row must find keys the tap did not hear.
	tapSilentChecks = 3

	// The phases of dictation.hold (command.DictationHold*; the host does not link the
	// command package, which brings every store with it).
	holdPhasePress   = "press"
	holdPhaseRelease = "release"
	holdPhaseDiscard = "discard"

	// holdLowerAudio is dictation.other_audio's value that lowers the audio.
	holdLowerAudio = "lower"
)

// holdRoute is where a press of the hold key goes.
type holdRoute int

const (
	routeNowhere  holdRoute = iota
	routeComposer           // the window's composer, through dictation.hold
	routeSystem             // a "system" session, pasted by the host
)

func (r holdRoute) String() string {
	switch r {
	case routeComposer:
		return "composer"
	case routeSystem:
		return "system"
	}
	return "nowhere"
}

// holdFacts is what routing reads at the press.
type holdFacts struct {
	// Usable: a session can start: dictation on, a model, no failed engine, the microphone
	// not denied.
	Usable bool
	// Anywhere is dictation.anywhere.
	Anywhere bool
	// OwnApp: Code Foundry is the app in front.
	OwnApp bool
	// ComposerTarget: the window has a composer dictation.toggle would pick.
	ComposerTarget bool
}

// routeHold is the routing rule. A window with no composer to take it is any other app:
// the text is pasted into what has the keyboard there, such as a search field.
func routeHold(f holdFacts) holdRoute {
	switch {
	case !f.Usable:
		return routeNowhere
	case f.OwnApp && f.ComposerTarget:
		return routeComposer
	case f.Anywhere:
		return routeSystem
	}
	return routeNowhere
}

// dictationUsable reads holdFacts.Usable from a snapshot.
func dictationUsable(s *v1.DictationSnapshot) bool {
	if !s.GetEnabled() || !s.GetModel().GetDownloaded() || s.GetMicDenied() {
		return false
	}
	switch s.GetState() {
	case v1.DictationState_DICTATION_STATE_READY, v1.DictationState_DICTATION_STATE_UNLOADED,
		v1.DictationState_DICTATION_STATE_LOADING, v1.DictationState_DICTATION_STATE_LISTENING:
		return true
	}
	return false
}

// accessibilityListName is what System Settings calls the Accessibility grants. macOS 27
// renamed the list.
func accessibilityListName(atLeast27 bool) string {
	if atLeast27 {
		return "Device Control and Data Access"
	}
	return "Accessibility"
}

// holdTone is one of the two sounds.
type holdTone int

const (
	toneStart holdTone = iota
	toneStop
)

// altListener is a running event tap (altTap; a fake in tests). Events closes when macOS
// ends it or after Stop.
type altListener interface {
	Events() <-chan altEvent
	Stop()
}

// holdOS is what the hold key asks of macOS (macHoldOS; a fake in tests).
type holdOS interface {
	// frontmost is the app in front.
	frontmost() frontApp
	// secureInput reports whether secure event input is on.
	secureInput() bool
	// trusted is AXIsProcessTrusted. It never prompts.
	trusted() bool
	// keyAge is how long ago anyone in this login session pressed a key. It needs no grant.
	keyAge() time.Duration
	// startTap makes a tap. Only called with the grant.
	startTap() (altListener, error)
	// playTone plays a sound at volume percent. It returns at once.
	playTone(t holdTone, volume int)
	// charBeforeCaret is the character before the caret in app pid: false with text selected
	// or when the app does not say. It waits on the app, bounded, so only the paste calls it.
	charBeforeCaret(pid int) (rune, bool)
	// lowerAudio lowers the default output once `after` has passed, until released closes.
	// It returns at once.
	lowerAudio(after time.Duration, released <-chan struct{})
	// pasteboard is a fresh pasteHost; copyText and typeText the other two ways text lands.
	pasteboard() pasteHost
	copyText(text string) error
	typeText(text string) error
}

// tapWatch tells a tap that hears nothing from one with nothing to hear. A tap can be
// created and enabled and still get no events (notes). The login session's counter of the
// last key press needs no grant, so keys it saw that the tap did not are the evidence. Only
// a tap that has never heard anything is suspect, and keys under secure input do not count,
// as those are hidden from every tap.
type tapWatch struct {
	since  time.Time // keys before this say nothing
	heard  bool
	missed int
}

func (w *tapWatch) observe(now time.Time, keyAge time.Duration, secure bool) {
	if w.heard {
		return
	}
	if !secure && now.Add(-keyAge).After(w.since) {
		w.missed++
	}
	w.since = now
}

func (w *tapWatch) silent() bool { return !w.heard && w.missed >= tapSilentChecks }

// holdUpdate is what the dictation watcher saw: a snapshot on a connection, or (both nil)
// the stream's end.
type holdUpdate struct {
	conn dictationConn
	snap *v1.DictationSnapshot
}

// holdRun is one press, from the key going down to its session's end.
type holdRun struct {
	conn  dictationConn
	facts holdFacts
	// sounds is the volume to play at, 0 for none.
	sounds int
	// lower: dictation.other_audio says to lower the audio. decided closes when the keeper
	// decides how the hold ends.
	lower   bool
	decided chan struct{}
	// other is the session open at the press, which gives way to a system session.
	other string
	prev  *holdRun

	// over: the keeper decided how it ends. A tone not yet played then stays silent.
	over atomic.Bool
	// released is the session a system hold released, for the next press to cut its tail.
	released atomic.Pointer[string]
	// end says how the hold ended: true counted. Buffered, sent once.
	end  chan bool
	done chan struct{}
}

// pasteJob is the text of a counted hold on its way to the app it was meant for.
type pasteJob struct {
	text    string
	pressed frontApp
}

// continuation is what the next dictation may join: the text landed last, while nobody has
// touched anything since (inputs still reads revision) and the same app is in front.
type continuation struct {
	revision uint64
	pid      int
	inserted string
}

// countsAsInput says the user may have moved the caret: a key, a click, or a gap in what the
// tap saw. The hold key's own events are flags events, which do not count.
func countsAsInput(ev altEvent) bool { return ev.Kind != altEventFlags || ev.Dropped > 0 }

// holdService runs the hold key. The fields from conn down belong to the goroutine in run;
// tests call update, event and check from theirs.
type holdService struct {
	os  holdOS
	log *slog.Logger
	// listName and executable go into the report as they are.
	listName, executable string
	// selfPID tells our own app from the others in front.
	selfPID int
	// after runs f after d. flushWait, pasteWait: the waits, shortened by tests.
	after     func(d time.Duration, f func())
	flushWait time.Duration
	pasteWait func(time.Duration)

	updates chan holdUpdate
	pastes  chan pasteJob
	ctx     context.Context // set by run; a background context in tests
	// inputs counts what ends a continuation; continued belongs to the paste goroutine.
	inputs    atomic.Uint64
	continued *continuation

	conn    dictationConn
	snap    *v1.DictationSnapshot
	hold    altHold
	current *holdRun
	last    *holdRun

	tap       altListener
	tapFailed bool
	watch     tapWatch
	trusted   bool
	sent      *v1.DictationAccessibility
	sentAt    time.Time
}

// newHoldService returns a service on os; run starts it.
func newHoldService(os_ holdOS, listName, executable string, log *slog.Logger) *holdService {
	return &holdService{
		os: os_, log: log, listName: listName, executable: executable, selfPID: os.Getpid(),
		after:     func(d time.Duration, f func()) { time.AfterFunc(d, f) },
		flushWait: holdFlushWait,
		pasteWait: time.Sleep,
		updates:   make(chan holdUpdate, 1),
		pastes:    make(chan pasteJob, 8),
		ctx:       context.Background(),
	}
}

// observe takes a snapshot from the dictation watcher. It never blocks: only the latest
// matters.
func (s *holdService) observe(conn dictationConn, snap *v1.DictationSnapshot) {
	u := holdUpdate{conn: conn, snap: snap}
	for {
		select {
		case s.updates <- u:
			return
		default:
		}
		select {
		case <-s.updates:
		default:
		}
	}
}

// lost says the watcher's stream ended. The tap keeps running on the daemon's last word,
// as a restart should not cost the listener, but nothing starts until it is back.
func (s *holdService) lost() { s.observe(nil, nil) }

// run is the service's loop, until ctx ends.
func (s *holdService) run(ctx context.Context) {
	s.ctx = ctx
	go s.pasteLoop(ctx)
	ticker := time.NewTicker(time.Hour)
	ticker.Stop()
	defer ticker.Stop()
	var period time.Duration
	for {
		if p := s.period(); p != period {
			period = p
			if p == 0 {
				ticker.Stop()
			} else {
				ticker.Reset(p)
			}
		}
		var events <-chan altEvent
		if s.tap != nil {
			events = s.tap.Events()
		}
		select {
		case <-ctx.Done():
			s.stopTap("quitting")
			return
		case u := <-s.updates:
			s.update(u)
		case ev, ok := <-events:
			if ok {
				s.event(ev)
			} else {
				s.tapEnded()
			}
		case now := <-ticker.C:
			s.check(now)
		}
	}
}

// period is how often check runs: not at all while dictation is off.
func (s *holdService) period() time.Duration {
	switch {
	case !s.snap.GetEnabled():
		return 0
	case s.trusted && s.tap != nil && s.watch.heard:
		return holdTrustRecheck
	}
	return holdTrustPoll
}

func (s *holdService) update(u holdUpdate) {
	s.conn = u.conn
	if u.snap == nil {
		// A restarted daemon knows nothing of the last report.
		s.sent = nil
		return
	}
	s.snap = u.snap
	for _, r := range s.hold.SetMode(parseHoldKey(u.snap.GetHoldKey())) {
		s.act(r)
	}
	if !u.snap.GetEnabled() {
		s.stopTap("dictation is off")
		s.trusted = false
		return
	}
	s.check(time.Now())
}

// check looks at the grant and the tap, and tells the daemon what changed.
func (s *holdService) check(now time.Time) {
	if !s.snap.GetEnabled() {
		return
	}
	trusted := s.os.trusted()
	flipped := trusted != s.trusted
	s.trusted = trusted
	switch {
	case !trusted:
		s.stopTap("Accessibility is not granted")
		s.tapFailed = false
	case flipped || s.tap == nil:
		// A new one on every flip: a tap from before a grant can stay silent for good.
		s.stopTap("the grant changed")
		s.startTap(now)
	}
	if s.tap != nil {
		s.watch.observe(now, s.os.keyAge(), s.os.secureInput())
	}
	s.report(now)
}

func (s *holdService) startTap(now time.Time) {
	tap, err := s.os.startTap()
	if err != nil {
		if !s.tapFailed {
			s.log.Warn("dictation: no event tap", "err", err)
		}
		s.tapFailed = true
		return
	}
	s.log.Info("dictation: listening for the hold key")
	s.tap, s.tapFailed = tap, false
	s.watch = tapWatch{since: now}
}

// stopTap ends the listener, and a hold in progress with it.
func (s *holdService) stopTap(why string) {
	if s.tap == nil {
		return
	}
	s.interrupt(why)
	events := s.tap.Events()
	s.tap.Stop()
	s.tap = nil
	s.log.Info("dictation: stopped listening for the hold key", "why", why)
	go func() {
		for range events { // lets the pipe's reader finish
		}
	}()
}

// tapEnded: macOS ended the tap. The next check makes another.
func (s *holdService) tapEnded() {
	s.log.Warn("dictation: the event tap ended")
	s.interrupt("the event tap ended")
	s.tap.Stop()
	s.tap = nil
}

// interrupt treats the tap as disabled, so the machine lets go of a hold. Keys went by
// unseen, so nothing can continue.
func (s *holdService) interrupt(why string) {
	s.inputs.Add(1)
	for _, r := range s.hold.interrupt(why) {
		s.act(r)
	}
}

// report tells the daemon about the grant when its snapshot says otherwise. A failed report
// is tried again a recheck later.
func (s *holdService) report(now time.Time) {
	want := &v1.DictationAccessibility{
		Granted:    s.trusted,
		TapSilent:  s.trusted && (s.tapFailed || (s.tap != nil && s.watch.silent())),
		ListName:   s.listName,
		Executable: s.executable,
	}
	conn := s.conn
	if conn == nil || proto.Equal(want, s.snap.GetAccessibility()) {
		s.sent = nil
		return
	}
	if proto.Equal(want, s.sent) && now.Sub(s.sentAt) < holdTrustRecheck {
		return
	}
	s.sent, s.sentAt = want, now
	go func() {
		if err := conn.Accessibility(s.ctx, want); err != nil {
			s.log.Debug("dictation: report Accessibility", "err", err)
		}
	}()
}

// event is one event from the tap.
func (s *holdService) event(ev altEvent) {
	// A click says nothing about keys: a tap that is deaf to them can still hear the mouse.
	if !s.watch.heard && ev.Kind != altEventMouseDown {
		// Heard at last: a row offering a restart can go now, not at the next check.
		s.watch.heard = true
		s.report(time.Now())
	}
	if ev.Dropped > 0 {
		s.log.Warn("dictation: the event tap dropped events", "count", ev.Dropped)
	}
	if countsAsInput(ev) {
		s.inputs.Add(1)
	}
	for _, r := range s.hold.Step(ev) {
		s.act(r)
	}
}

func (s *holdService) act(r altReport) {
	switch r.Kind {
	case altReportStarted:
		s.begin()
	case altReportDiscarded:
		s.log.Debug("dictation: hold discarded", "why", r.Why)
		s.finish(false)
	case altReportCounted:
		s.finish(true)
	}
}

// begin hands a press to a run of its own.
func (s *holdService) begin() {
	if s.conn == nil || s.snap == nil {
		return
	}
	r := &holdRun{
		conn: s.conn,
		facts: holdFacts{
			Usable:         dictationUsable(s.snap),
			Anywhere:       s.snap.GetAnywhere(),
			ComposerTarget: s.snap.GetComposerTarget(),
		},
		other:   s.snap.GetSession().GetId(),
		prev:    s.last,
		lower:   s.snap.GetOtherAudio() == holdLowerAudio,
		decided: make(chan struct{}),
		end:     make(chan bool, 1),
		done:    make(chan struct{}),
	}
	if s.snap.GetSounds() {
		r.sounds = clampVolume(int(s.snap.GetSoundVolume()))
	}
	s.current, s.last = r, r
	go s.runHold(r)
}

func (s *holdService) finish(counted bool) {
	if r := s.current; r != nil {
		s.current = nil
		r.over.Store(true)
		close(r.decided)
		r.end <- counted
	}
}

// runHold is one press: where it goes, the start tone, and the session.
func (s *holdService) runHold(r *holdRun) {
	defer close(r.done)
	pressed := s.os.frontmost()
	r.facts.OwnApp = pressed.PID == s.selfPID
	route := routeHold(r.facts)
	s.log.Info("dictation: hold", "route", route.String())
	if route == routeNowhere {
		return
	}
	if r.lower {
		// Only from here: a shortcut like Option+Left ends a hold sooner and must not dip it.
		s.os.lowerAudio(altHoldMin, r.decided)
	}
	if r.sounds > 0 {
		s.after(holdToneDelay, func() {
			if !r.over.Load() {
				s.os.playTone(toneStart, r.sounds)
			}
		})
	}
	if route == routeComposer {
		s.runComposer(r)
		return
	}
	s.runSystem(r, pressed)
}

// waitEnd is how the hold ended; false too when the app is quitting.
func (s *holdService) waitEnd(r *holdRun) bool {
	select {
	case counted := <-r.end:
		return counted
	case <-s.ctx.Done():
		return false
	}
}

// stopTone plays the stop tone, for a counted hold.
func (s *holdService) stopTone(r *holdRun) {
	if r.sounds > 0 {
		s.os.playTone(toneStop, r.sounds)
	}
}

// runComposer leaves the session to the window: it starts one on the press and ends it on
// the release, whatever phase its Start has reached.
func (s *holdService) runComposer(r *holdRun) {
	s.holdPhase(r, holdPhasePress)
	if !s.waitEnd(r) {
		s.holdPhase(r, holdPhaseDiscard)
		return
	}
	s.holdPhase(r, holdPhaseRelease)
	s.stopTone(r)
}

func (s *holdService) holdPhase(r *holdRun, phase string) {
	if err := r.conn.Hold(s.ctx, phase); err != nil {
		s.log.Warn("dictation: hold", "phase", phase, "err", err)
	}
}

// runSystem opens the session, collects its phrases until the release, and queues the
// paste. The session may end by itself first (30 s of silence): what it heard still counts.
func (s *holdService) runSystem(r *holdRun, pressed frontApp) {
	if r.prev != nil {
		s.cutTail(r)
		select {
		case <-r.prev.done: // a flush still running would refuse this Start
		case <-s.ctx.Done():
			return
		}
	}
	id, err := s.startSession(r)
	if err != nil {
		s.log.Warn("dictation: start a system session", "err", err)
		return
	}
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	sess, err := followSession(ctx, r.conn, id)
	if err != nil {
		s.log.Warn("dictation: follow the session", "err", err)
		s.discardSession(r, id)
		return
	}
	if !s.waitEnd(r) {
		s.discardSession(r, id)
		return
	}
	// The microphone stays open for the tail, so the tone sounds into it: the engine knows
	// its length and takes nothing there for speech, and it does not end up as text.
	r.released.Store(&id)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		if err := r.conn.Release(s.ctx, id); err != nil {
			s.log.Warn("dictation: release the session", "err", err)
		}
	}()
	s.stopTone(r)
	timeout := time.After(s.flushWait)
	for _, over := range []<-chan struct{}{sess.ended, finished} {
		select {
		case <-over:
		case <-timeout:
			s.log.Warn("dictation: no end after the flush; pasting what arrived")
		case <-s.ctx.Done():
			return
		}
	}
	select {
	case s.pastes <- pasteJob{text: joinPhrases(sess.collected()), pressed: pressed}:
	case <-s.ctx.Done():
	}
}

// cutTail ends the last hold's tail now: a press means the next words are for this hold, and
// it should not wait out the last one's. What the tail heard so far still pastes.
func (s *holdService) cutTail(r *holdRun) {
	if id := r.prev.released.Load(); id != nil {
		if err := r.conn.Finish(s.ctx, *id); err != nil {
			s.log.Warn("dictation: cut the tail", "err", err)
		}
	}
}

// startSession opens the system session. Another client's session gives way, as it does to
// a composer: the speech it holds goes to its client first.
func (s *holdService) startSession(r *holdRun) (string, error) {
	id, err := r.conn.Start(s.ctx, overlayClientID)
	if connect.CodeOf(err) != connect.CodeAborted || r.other == "" {
		return id, err
	}
	if err := r.conn.Finish(s.ctx, r.other); err != nil {
		return "", err
	}
	return r.conn.Start(s.ctx, overlayClientID)
}

func (s *holdService) discardSession(r *holdRun, id string) {
	if err := r.conn.Stop(s.ctx, id); err != nil {
		s.log.Warn("dictation: discard the session", "err", err)
	}
}

// holdSession is a session's phrases as they arrive; ended closes with the stream.
type holdSession struct {
	mu      sync.Mutex
	phrases []string
	ended   chan struct{}
}

func (h *holdSession) collected() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.phrases
}

// followSession opens the Session stream and reads it until the session ends or ctx does.
// A dropped stream counts as the end: what arrived is all there will be.
func followSession(ctx context.Context, conn dictationConn, id string) (*holdSession, error) {
	stream, err := conn.Session(ctx, id)
	if err != nil {
		return nil, err
	}
	h := &holdSession{ended: make(chan struct{})}
	go func() {
		defer close(h.ended)
		defer func() { _ = stream.Close() }()
		for stream.Receive() {
			ev := stream.Msg()
			if p := ev.GetPhrase(); p != nil {
				h.mu.Lock()
				h.phrases = append(h.phrases, p.GetText())
				h.mu.Unlock()
			}
			if ev.GetEnded() != nil {
				return
			}
		}
	}()
	return h, nil
}

// pasteLoop lands texts one at a time, off the tap's thread and off the main thread:
// reading the pasteboard can wait on its owner, and a paste takes about 650 ms.
func (s *holdService) pasteLoop(ctx context.Context) {
	runtime.LockOSThread() // pasteHost's calls come from one thread
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-s.pastes:
			s.land(job)
		}
	}
}

// land decides on the text now, not at the release: the flush took a moment, and the user
// may have moved on. Whatever goes wrong, the text ends up on the clipboard. Logs say what
// happened to it, never what it was.
func (s *holdService) land(job pasteJob) {
	front := s.os.frontmost()
	action := decidePaste(pasteFacts{
		Text: job.text, Pressed: job.pressed, Front: front,
		Secure: s.os.secureInput(), Trusted: s.os.trusted(), Race: hasClipboardRace(front.Bundle),
	})
	s.log.Info("dictation: text", "action", action.String(), "runes", len([]rune(job.text)))
	if action == pasteNothing {
		return
	}
	var err error
	revision := s.inputs.Load()
	text := job.text
	previous := s.continued
	s.continued = nil
	switch action {
	case pasteClipboard:
		if err := s.os.copyText(job.text); err != nil {
			s.log.Warn("dictation: copy the text", "err", err)
		}
		return
	case pasteTyped:
		text = s.fitCaret(text, front.PID, revision, previous)
		err = s.os.typeText(text)
	case pasteKeys:
		text = s.fitCaret(text, front.PID, revision, previous)
		err = pasteText(s.os.pasteboard(), text, s.pasteWait, func(line string) { s.log.Debug("dictation: paste", "step", line) })
	}
	if err != nil {
		s.log.Warn("dictation: paste; leaving the text on the clipboard", "err", err)
		if err := s.os.copyText(job.text); err != nil {
			s.log.Warn("dictation: copy the text", "err", err)
		}
		return
	}
	s.continued = &continuation{revision: revision, pid: front.PID, inserted: text}
}

// fitCaret is text as it should arrive at the caret: joined to the dictation before it if
// nothing has happened since, else spaced by what the app says is there.
func (s *holdService) fitCaret(text string, pid int, revision uint64, previous *continuation) string {
	if previous != nil && previous.revision == revision && previous.pid == pid {
		return joinContinuation(previous.inserted, text)
	}
	before, known := s.os.charBeforeCaret(pid)
	return smartSpaced(text, before, known)
}
