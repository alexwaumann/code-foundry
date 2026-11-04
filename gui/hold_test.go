package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/dictate"
)

const holdTestPID = 100

var (
	ownApp   = frontApp{PID: holdTestPID, Name: "Code Foundry"}
	notesApp = frontApp{PID: 7, Name: "Notes"}
	mailApp  = frontApp{PID: 9, Name: "Mail"}
)

func TestRouteHold(t *testing.T) {
	tests := []struct {
		name  string
		facts holdFacts
		want  holdRoute
	}{
		{"own app, a composer, anywhere on", holdFacts{Usable: true, OwnApp: true, ComposerTarget: true, Anywhere: true}, routeComposer},
		{"own app, a composer, anywhere off", holdFacts{Usable: true, OwnApp: true, ComposerTarget: true}, routeComposer},
		{"own app, no composer, anywhere on", holdFacts{Usable: true, OwnApp: true, Anywhere: true}, routeSystem},
		{"own app, no composer, anywhere off", holdFacts{Usable: true, OwnApp: true}, routeNowhere},
		{"another app, anywhere on", holdFacts{Usable: true, Anywhere: true}, routeSystem},
		{"another app, anywhere on, a composer behind it", holdFacts{Usable: true, ComposerTarget: true, Anywhere: true}, routeSystem},
		{"another app, anywhere off", holdFacts{Usable: true}, routeNowhere},
		{"another app, anywhere off, a composer behind it", holdFacts{Usable: true, ComposerTarget: true}, routeNowhere},
		{"not usable", holdFacts{OwnApp: true, ComposerTarget: true, Anywhere: true}, routeNowhere},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := routeHold(tt.facts); got != tt.want {
				t.Errorf("got %s, want %s", got, tt.want)
			}
		})
	}
}

func TestDictationUsable(t *testing.T) {
	snap := func(state v1.DictationState, edit func(*v1.DictationSnapshot)) *v1.DictationSnapshot {
		s := &v1.DictationSnapshot{Enabled: true, State: state, Model: &v1.DictationModel{Downloaded: true}}
		if edit != nil {
			edit(s)
		}
		return s
	}
	tests := []struct {
		name string
		snap *v1.DictationSnapshot
		want bool
	}{
		{"ready", snap(v1.DictationState_DICTATION_STATE_READY, nil), true},
		{"unloaded: Start loads it", snap(v1.DictationState_DICTATION_STATE_UNLOADED, nil), true},
		{"loading", snap(v1.DictationState_DICTATION_STATE_LOADING, nil), true},
		{"listening: the session gives way", snap(v1.DictationState_DICTATION_STATE_LISTENING, nil), true},
		{"off", snap(v1.DictationState_DICTATION_STATE_READY, func(s *v1.DictationSnapshot) { s.Enabled = false }), false},
		{"no model", snap(v1.DictationState_DICTATION_STATE_NO_MODEL, func(s *v1.DictationSnapshot) { s.Model.Downloaded = false }), false},
		{"downloading", snap(v1.DictationState_DICTATION_STATE_DOWNLOADING, nil), false},
		{"failed", snap(v1.DictationState_DICTATION_STATE_ERROR, nil), false},
		{"microphone denied", snap(v1.DictationState_DICTATION_STATE_READY, func(s *v1.DictationSnapshot) { s.MicDenied = true }), false},
		{"no snapshot", nil, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := dictationUsable(tt.snap); got != tt.want {
				t.Errorf("got %t", got)
			}
		})
	}
}

func TestAccessibilityListName(t *testing.T) {
	if got := accessibilityListName(true); got != "Device Control and Data Access" {
		t.Errorf("27 and later: %q", got)
	}
	if got := accessibilityListName(false); got != "Accessibility" {
		t.Errorf("before: %q", got)
	}
}

func TestTapWatch(t *testing.T) {
	t0 := time.Unix(1000, 0)
	type look struct {
		secs   int // since t0
		keyAge time.Duration
		secure bool
	}
	tests := []struct {
		name   string
		heard  bool
		looks  []look
		silent bool
	}{
		{name: "no keys anywhere", looks: []look{{1, time.Hour, false}, {2, time.Hour, false}, {3, time.Hour, false}, {4, time.Hour, false}}},
		{name: "keys in three checks, unheard", looks: []look{{1, 0, false}, {2, 0, false}, {3, 0, false}}, silent: true},
		{name: "keys in two checks are not enough", looks: []look{{1, 0, false}, {2, 0, false}, {3, time.Hour, false}}},
		{name: "one key seen again by every check counts once", looks: []look{{1, 0, false}, {2, time.Second, false}, {3, 2 * time.Second, false}, {4, 3 * time.Second, false}}},
		{name: "keys before the tap existed say nothing", looks: []look{{1, 2 * time.Second, false}, {2, 3 * time.Second, false}, {3, 4 * time.Second, false}}},
		{name: "keys under secure input say nothing", looks: []look{{1, 0, true}, {2, 0, true}, {3, 0, true}, {4, 0, true}}},
		{name: "secure input in between", looks: []look{{1, 0, false}, {2, 0, true}, {3, 0, false}, {4, 0, true}, {5, 0, false}}, silent: true},
		{name: "a tap that heard anything is fine", heard: true, looks: []look{{1, 0, false}, {2, 0, false}, {3, 0, false}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := tapWatch{since: t0, heard: tt.heard}
			for _, l := range tt.looks {
				w.observe(t0.Add(time.Duration(l.secs)*time.Second), l.keyAge, l.secure)
			}
			if got := w.silent(); got != tt.silent {
				t.Errorf("silent = %t", got)
			}
		})
	}
}

// fakeTap is an event tap with nothing behind it.
type fakeTap struct {
	events  chan altEvent
	stopped bool
}

func newFakeTap() *fakeTap { return &fakeTap{events: make(chan altEvent, 8)} }

func (f *fakeTap) Events() <-chan altEvent { return f.events }

func (f *fakeTap) Stop() {
	if !f.stopped {
		f.stopped = true
		close(f.events)
	}
}

// holdLog is what happened, in order, across goroutines.
type holdLog struct {
	mu    sync.Mutex
	lines []string
}

func (l *holdLog) add(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, s)
}

func (l *holdLog) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return slices.Clone(l.lines)
}

// fakeHoldOS is macOS, with what the test set.
type fakeHoldOS struct {
	log *holdLog

	mu      sync.Mutex
	front   frontApp
	secure  bool
	trust   bool
	age     time.Duration
	taps    []*fakeTap
	tapErr  error
	board   pasteHost
	typeErr error
	blockIn chan struct{} // frontmost waits on it when set
	// before and beforeKnown are what charBeforeCaret says; beforeWait holds it up when set.
	before      rune
	beforeKnown bool
	beforeWait  chan struct{}
	logCaret    bool // logs each read, for the tests about them
}

func (f *fakeHoldOS) set(edit func(*fakeHoldOS)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	edit(f)
}

func (f *fakeHoldOS) frontmost() frontApp {
	f.mu.Lock()
	block := f.blockIn
	f.mu.Unlock()
	if block != nil {
		<-block
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.front
}

func (f *fakeHoldOS) secureInput() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.secure
}

func (f *fakeHoldOS) trusted() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.trust
}

func (f *fakeHoldOS) keyAge() time.Duration {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.age
}

func (f *fakeHoldOS) startTap() (altListener, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tapErr != nil {
		return nil, f.tapErr
	}
	t := newFakeTap()
	f.taps = append(f.taps, t)
	return t, nil
}

func (f *fakeHoldOS) playTone(t holdTone, _ int) {
	if t == toneStart {
		f.log.add("tone start")
	} else {
		f.log.add("tone stop")
	}
}

func (f *fakeHoldOS) charBeforeCaret(pid int) (rune, bool) {
	f.mu.Lock()
	wait := f.beforeWait
	f.mu.Unlock()
	if wait != nil {
		<-wait
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.logCaret {
		f.log.add(fmt.Sprintf("caret %d", pid))
	}
	return f.before, f.beforeKnown
}

func (f *fakeHoldOS) lowerAudio(after time.Duration, released <-chan struct{}) {
	f.log.add("lower after " + after.String())
	go func() {
		<-released
		f.log.add("audio released")
	}()
}

func (f *fakeHoldOS) pasteboard() pasteHost {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.board
}

func (f *fakeHoldOS) copyText(text string) error {
	f.log.add("copy " + text)
	return nil
}

func (f *fakeHoldOS) typeText(text string) error {
	f.log.add("type " + text)
	return f.typeErr
}

// holdPasteboard is pasteHost; a Write is what shows the text.
type holdPasteboard struct {
	log     *holdLog
	postErr error
	block   chan struct{} // Save waits on it when set
}

func (p *holdPasteboard) Save() (int, int) {
	if p.block != nil {
		<-p.block
	}
	return 0, 0
}

func (p *holdPasteboard) Write(text string) (int64, error) {
	p.log.add("paste " + text)
	return 1, nil
}

func (p *holdPasteboard) Post() error { return p.postErr }

func (p *holdPasteboard) Restore(int64) (bool, error) { return true, nil }

// fakeHoldConn is the daemon as a hold sees it.
type fakeHoldConn struct {
	dictationConn
	log *holdLog

	mu       sync.Mutex
	startErr []error // one per Start, then nil
	blockIn  chan struct{}
	phrases  []string      // arrive once the session stream opens
	flushed  []string      // arrive on Finish and Release
	tailing  chan struct{} // set: a Release waits for a Finish, as a tail does
	endEarly bool          // the session ends by itself after phrases
	reports  []*v1.DictationAccessibility
	stream   *fakeSessionStream
}

func (c *fakeHoldConn) Start(_ context.Context, client string) (string, error) {
	c.mu.Lock()
	block := c.blockIn
	c.mu.Unlock()
	if block != nil {
		<-block
	}
	c.log.add("start " + client)
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.startErr) > 0 {
		err := c.startErr[0]
		c.startErr = c.startErr[1:]
		if err != nil {
			return "", err
		}
	}
	return "s1", nil
}

func (c *fakeHoldConn) Stop(_ context.Context, id string) error {
	c.log.add("stop " + id)
	c.end(nil)
	return nil
}

func (c *fakeHoldConn) Finish(_ context.Context, id string) error {
	c.log.add("finish " + id)
	c.mu.Lock()
	flushed, tailing := c.flushed, c.tailing
	c.tailing = nil
	c.mu.Unlock()
	if tailing != nil {
		close(tailing)
	}
	c.end(flushed)
	return nil
}

func (c *fakeHoldConn) Release(_ context.Context, id string) error {
	c.log.add("release " + id)
	c.mu.Lock()
	flushed, tailing := c.flushed, c.tailing
	c.mu.Unlock()
	if tailing != nil {
		<-tailing
		return nil
	}
	c.end(flushed)
	return nil
}

func (c *fakeHoldConn) end(phrases []string) {
	c.mu.Lock()
	s := c.stream
	c.mu.Unlock()
	if s != nil {
		s.finish(phrases)
	}
}

func (c *fakeHoldConn) Session(context.Context, string) (sessionStream, error) {
	s := &fakeSessionStream{events: make(chan *v1.DictationSessionEvent, 16)}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stream = s
	for _, p := range c.phrases {
		s.events <- phraseEvent(p)
	}
	if c.endEarly {
		s.finish(nil)
	}
	return s, nil
}

func (c *fakeHoldConn) Hold(_ context.Context, phase string) error {
	c.log.add("hold " + phase)
	return nil
}

func (c *fakeHoldConn) Accessibility(_ context.Context, a *v1.DictationAccessibility) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.reports = append(c.reports, a)
	return nil
}

func (c *fakeHoldConn) lastReport(t *testing.T, want func(*v1.DictationAccessibility) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		var last *v1.DictationAccessibility
		if n := len(c.reports); n > 0 {
			last = c.reports[n-1]
		}
		c.mu.Unlock()
		if last != nil && want(last) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("no such report in %v", c.reports)
}

func phraseEvent(text string) *v1.DictationSessionEvent {
	return &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Phrase{Phrase: &v1.DictationPhrase{Text: text}}}
}

type fakeSessionStream struct {
	events chan *v1.DictationSessionEvent
	once   sync.Once
	msg    *v1.DictationSessionEvent
}

// finish delivers the last phrases and the end, once.
func (s *fakeSessionStream) finish(phrases []string) {
	s.once.Do(func() {
		for _, p := range phrases {
			s.events <- phraseEvent(p)
		}
		s.events <- &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Ended{Ended: &v1.DictationEnded{}}}
	})
}

func (s *fakeSessionStream) Receive() bool {
	m, ok := <-s.events
	s.msg = m
	return ok
}

func (s *fakeSessionStream) Msg() *v1.DictationSessionEvent { return s.msg }
func (s *fakeSessionStream) Err() error                     { return nil }
func (s *fakeSessionStream) Close() error                   { return nil }

// holdSnapshot is a ready daemon with dictation on.
func holdSnapshot(edit func(*v1.DictationSnapshot)) *v1.DictationSnapshot {
	s := &v1.DictationSnapshot{
		Enabled: true, State: v1.DictationState_DICTATION_STATE_READY, Model: &v1.DictationModel{Downloaded: true},
		Anywhere: true, HoldKey: "both", Sounds: true, SoundVolume: 50,
		Accessibility: &v1.DictationAccessibility{Granted: true, ListName: "Accessibility", Executable: "/exe"},
	}
	if edit != nil {
		edit(s)
	}
	return s
}

// holdRig is a service on fakes, with the tone timer in the test's hands.
type holdRig struct {
	s     *holdService
	os    *fakeHoldOS
	conn  *fakeHoldConn
	log   *holdLog
	timer []func()
	mu    sync.Mutex
}

func newHoldRig(t *testing.T) *holdRig {
	t.Helper()
	log := &holdLog{}
	r := &holdRig{log: log, conn: &fakeHoldConn{log: log}}
	r.os = &fakeHoldOS{log: log, front: notesApp, trust: true, age: time.Hour, board: &holdPasteboard{log: log}}
	r.s = newHoldService(r.os, "Accessibility", "/exe", slog.New(slog.DiscardHandler))
	r.s.selfPID = holdTestPID
	r.s.flushWait = 50 * time.Millisecond
	r.s.pasteWait = func(time.Duration) {}
	r.s.after = func(d time.Duration, f func()) {
		if d != holdToneDelay {
			t.Errorf("tone delay %s", d)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.timer = append(r.timer, f)
	}
	return r
}

// fireTones runs the tone timers now, as if 40 ms went by. Called after the run got there.
func (r *holdRig) fireTones() {
	r.mu.Lock()
	timers := r.timer
	r.timer = nil
	r.mu.Unlock()
	for _, f := range timers {
		f()
	}
}

func (r *holdRig) waitTimer(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		r.mu.Lock()
		n := len(r.timer)
		r.mu.Unlock()
		if n > 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("no tone timer")
}

// wait is until the hold's run has finished.
func (r *holdRig) wait(t *testing.T) {
	t.Helper()
	select {
	case <-r.s.last.done:
	case <-time.After(5 * time.Second):
		t.Fatalf("the run did not end; log %v", r.log.all())
	}
}

// land pastes what the run queued, as pasteLoop would.
func (r *holdRig) land() {
	select {
	case job := <-r.s.pastes:
		r.s.land(job)
	default:
	}
}

// holdScript is what the daemon will do in a TestHoldRuns case.
type holdScript struct {
	startErr         []error
	phrases, flushed []string
	endEarly         bool
}

// Other audio: a hold that goes somewhere asks for the audio to go down after the hold's
// minimum, and every way a hold can end lets it go.
func TestHoldLowersAudio(t *testing.T) {
	lower := func(s *v1.DictationSnapshot) { s.OtherAudio = "lower" }
	end := func(r *holdRig) { r.s.event(flagsAt(500, 0)) }
	tests := []struct {
		name  string
		front frontApp
		snap  func(*v1.DictationSnapshot)
		end   func(*holdRig)
		want  bool
	}{
		{"into another app", notesApp, lower, end, true},
		{"into a composer", ownApp, func(s *v1.DictationSnapshot) { lower(s); s.ComposerTarget = true }, end, true},
		{"a shortcut ends it early", notesApp, lower, func(r *holdRig) { r.s.event(keyAt(120, 123)) }, true},
		{"the tap stops", notesApp, lower, func(r *holdRig) { r.s.stopTap("a test") }, true},
		{"the setting is off", notesApp, nil, end, false},
		{"nowhere to go", notesApp, func(s *v1.DictationSnapshot) { lower(s); s.Anywhere = false }, end, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newHoldRig(t)
			r.os.set(func(s *fakeHoldOS) { s.front = tt.front })
			r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(tt.snap)})
			r.s.event(flagsAt(0, flagLeftAlt))
			waitLog := func(line string) {
				t.Helper()
				deadline := time.Now().Add(2 * time.Second)
				for !slices.Contains(r.log.all(), line) {
					if time.Now().After(deadline) {
						t.Fatalf("no %q in %q", line, r.log.all())
					}
					time.Sleep(time.Millisecond)
				}
			}
			if tt.want {
				waitLog("lower after 300ms")
			}
			tt.end(r)
			r.wait(t)
			if tt.want {
				waitLog("audio released")
			} else if slices.Contains(r.log.all(), "lower after 300ms") {
				t.Errorf("lowered: %q", r.log.all())
			}
		})
	}
}

func TestHoldRuns(t *testing.T) {
	press, release := flagsAt(0, flagLeftAlt), flagsAt(500, 0)
	shortRelease := flagsAt(200, 0)
	key := keyAt(250, 14)
	boom := errors.New("boom")
	aborted := connect.NewError(connect.CodeAborted, boom)
	inNotes := func(s *fakeHoldOS) { s.front = notesApp }
	inOwnApp := func(s *fakeHoldOS) { s.front = ownApp }
	target := func(s *v1.DictationSnapshot) { s.ComposerTarget = true }
	anywhereOff := func(s *v1.DictationSnapshot) { s.Anywhere = false }

	tests := []struct {
		name    string
		snap    func(*v1.DictationSnapshot)
		front   func(*fakeHoldOS)
		conn    holdScript
		events  []altEvent
		atLand  func(*fakeHoldOS)
		want    []string // sorted: the finish and the tone race, on purpose
		notimer bool
	}{
		{
			name: "system: a counted hold pastes once, phrases joined", front: inNotes,
			conn:   holdScript{phrases: []string{" One.", " Two."}, flushed: []string{" Three."}},
			events: []altEvent{press, release},
			want:   []string{"paste One. Two. Three.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: a short hold is dropped, with no stop tone", front: inNotes,
			conn:   holdScript{phrases: []string{"One."}},
			events: []altEvent{press, shortRelease},
			want:   []string{"start system", "stop s1", "tone start"},
		},
		{
			name: "system: a key cancels at any time", front: inNotes,
			conn:   holdScript{phrases: []string{"One."}},
			events: []altEvent{press, keyAt(9000, 14), flagsAt(9100, 0)},
			want:   []string{"start system", "stop s1", "tone start"},
		},
		{
			name: "system: a modifier 15.7 s in does not", front: inNotes,
			conn:   holdScript{flushed: []string{"Kept."}},
			events: []altEvent{press, flagsAt(15700, flagLeftAlt|flagRightAlt), flagsAt(16000, 0)},
			want:   []string{"paste Kept.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: nothing said", front: inNotes,
			events: []altEvent{press, release},
			want:   []string{"release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: another app in front by then leaves it on the clipboard", front: inNotes,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release},
			atLand: func(s *fakeHoldOS) { s.front = mailApp },
			want:   []string{"copy Text.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: a password field leaves it on the clipboard", front: inNotes,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release},
			atLand: func(s *fakeHoldOS) { s.secure = true },
			want:   []string{"copy Text.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: a revoked grant leaves it on the clipboard", front: inNotes,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release},
			atLand: func(s *fakeHoldOS) { s.trust = false },
			want:   []string{"copy Text.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: the session ended itself before the release, and what it heard counts", front: inNotes,
			conn:   holdScript{phrases: []string{"Heard."}, endEarly: true},
			events: []altEvent{press, flagsAt(40000, 0)},
			want:   []string{"paste Heard.", "release s1", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: a session someone else holds gives way", front: inNotes,
			snap: func(s *v1.DictationSnapshot) {
				s.State = v1.DictationState_DICTATION_STATE_LISTENING
				s.Session = &v1.DictationSession{Id: "c9", ClientId: "composer"}
			},
			conn:   holdScript{startErr: []error{aborted}, flushed: []string{"Text."}},
			events: []altEvent{press, release},
			want:   []string{"finish c9", "paste Text.", "release s1", "start system", "start system", "tone start", "tone stop"},
		},
		{
			name: "system: a failed Start does nothing more", front: inNotes,
			conn:   holdScript{startErr: []error{boom}},
			events: []altEvent{press, release},
			want:   []string{"start system", "tone start"},
		},
		{
			name: "composer: press and release go to the window", snap: target, front: inOwnApp,
			events: []altEvent{press, release},
			want:   []string{"hold press", "hold release", "tone start", "tone stop"},
		},
		{
			name: "composer: anywhere off makes no difference", snap: func(s *v1.DictationSnapshot) { s.ComposerTarget, s.Anywhere = true, false }, front: inOwnApp,
			events: []altEvent{press, release},
			want:   []string{"hold press", "hold release", "tone start", "tone stop"},
		},
		{
			name: "composer: a short hold is discarded, with no stop tone", snap: target, front: inOwnApp,
			events: []altEvent{press, shortRelease},
			want:   []string{"hold discard", "hold press", "tone start"},
		},
		{
			name: "composer: a key discards it", snap: target, front: inOwnApp,
			events: []altEvent{press, key, flagsAt(600, 0)},
			want:   []string{"hold discard", "hold press", "tone start"},
		},
		{
			name: "own app with no composer pastes into itself", front: inOwnApp,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release},
			want:   []string{"paste Text.", "release s1", "start system", "tone start", "tone stop"},
		},
		{name: "anywhere off in another app does nothing at all", snap: anywhereOff, front: inNotes, events: []altEvent{press, release}, notimer: true},
		{name: "anywhere off in another app, a composer behind it", snap: func(s *v1.DictationSnapshot) { s.Anywhere, s.ComposerTarget = false, true }, front: inNotes, events: []altEvent{press, release}, notimer: true},
		{name: "anywhere off in our app with no composer", snap: anywhereOff, front: inOwnApp, events: []altEvent{press, release}, notimer: true},
		{name: "a failed engine does nothing", snap: func(s *v1.DictationSnapshot) { s.State = v1.DictationState_DICTATION_STATE_ERROR }, front: inNotes, events: []altEvent{press, release}, notimer: true},
		{
			name: "sounds off", snap: func(s *v1.DictationSnapshot) { s.Sounds = false }, front: inNotes,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release}, notimer: true,
			want: []string{"paste Text.", "release s1", "start system"},
		},
		{
			name: "volume zero", snap: func(s *v1.DictationSnapshot) { s.SoundVolume = 0 }, front: inNotes,
			conn:   holdScript{flushed: []string{"Text."}},
			events: []altEvent{press, release}, notimer: true,
			want: []string{"paste Text.", "release s1", "start system"},
		},
		{
			name: "composer: sounds off", snap: func(s *v1.DictationSnapshot) { s.ComposerTarget, s.Sounds = true, false }, front: inOwnApp,
			events: []altEvent{press, release}, notimer: true,
			want: []string{"hold press", "hold release"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newHoldRig(t)
			r.conn.startErr, r.conn.phrases, r.conn.flushed, r.conn.endEarly = tt.conn.startErr, tt.conn.phrases, tt.conn.flushed, tt.conn.endEarly
			r.os.set(tt.front)
			r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(tt.snap)})
			r.s.event(tt.events[0])
			if !tt.notimer {
				r.waitTimer(t)
				r.fireTones()
			}
			for _, ev := range tt.events[1:] {
				r.s.event(ev)
			}
			r.wait(t)
			if tt.atLand != nil {
				r.os.set(tt.atLand)
			}
			r.land()
			got := r.log.all()
			slices.Sort(got)
			if len(got) == 0 && len(tt.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got  %q\nwant %q", got, tt.want)
			}
		})
	}
}

// Started and cancelled inside 40 ms: the start tone never plays.
func TestHoldToneCancelled(t *testing.T) {
	for _, tt := range []struct {
		name   string
		cancel altEvent
	}{
		{"released", flagsAt(20, 0)},
		{"a shortcut", keyAt(20, 123)},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r := newHoldRig(t)
			r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
			r.s.event(flagsAt(0, flagLeftAlt))
			r.waitTimer(t)
			r.s.event(tt.cancel)
			r.fireTones()
			r.s.event(flagsAt(100, 0))
			r.wait(t)
			for _, line := range r.log.all() {
				if line == "tone start" || line == "tone stop" {
					t.Errorf("played: %v", r.log.all())
				}
			}
		})
	}
}

func TestHoldLandFallsBackToTheClipboard(t *testing.T) {
	boom := errors.New("boom")
	raceBundle := t.TempDir()
	makeChromium(t, raceBundle, "155.0.1.2")
	race := frontApp{PID: 7, Name: "Chrome", Bundle: raceBundle}
	tests := []struct {
		name string
		edit func(*fakeHoldOS)
		want []string
	}{
		{"typed into an app with the race", func(f *fakeHoldOS) { f.front = race }, []string{"type Text."}},
		{"typing fails", func(f *fakeHoldOS) { f.front, f.typeErr = race, boom }, []string{"type Text.", "copy Text."}},
		{"the post fails", func(f *fakeHoldOS) { f.board = &holdPasteboard{log: f.log, postErr: boom} }, []string{"paste Text.", "copy Text."}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newHoldRig(t)
			r.os.set(tt.edit)
			r.s.land(pasteJob{text: "Text.", pressed: r.os.frontmost()})
			if got := r.log.all(); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestCountsAsInput(t *testing.T) {
	tests := []struct {
		name string
		ev   altEvent
		want bool
	}{
		{"the hold key going down", flagsAt(0, flagLeftAlt), false},
		{"the hold key coming up", flagsAt(0, 0), false},
		{"a key", keyAt(0, 14), true},
		{"a click", altEvent{Kind: altEventMouseDown}, true},
		{"flags after records were lost", altEvent{Kind: altEventFlags, Dropped: 2}, true},
		{"the tap disabled by a timeout", altEvent{Kind: altEventDisabledByTimeout}, true},
		{"the tap disabled by the user", altEvent{Kind: altEventDisabledByUserInput}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := countsAsInput(tt.ev); got != tt.want {
				t.Errorf("got %v", got)
			}
		})
	}
}

// What lands, through a run of dictations. The log has "paste <text>", so a leading space
// shows as two, and "caret <pid>" for each read of the character before the caret.
func TestHoldLandFitsTheCaret(t *testing.T) {
	boom := errors.New("boom")
	land := func(text string) func(*holdRig) {
		return func(r *holdRig) { r.s.land(pasteJob{text: text, pressed: r.os.frontmost()}) }
	}
	event := func(ev altEvent) func(*holdRig) { return func(r *holdRig) { r.s.event(ev) } }
	os := func(edit func(*fakeHoldOS)) func(*holdRig) { return func(r *holdRig) { r.os.set(edit) } }
	first, next := land("Because if I don't do that,"), land("And if you see it.")
	const pasted, joined = "paste  Because if I don't do that,", "paste  and if you see it."
	caret := fmt.Sprintf("caret %d", notesApp.PID)
	raceBundle := t.TempDir()
	makeChromium(t, raceBundle, "155.0.1.2")
	race := frontApp{PID: 7, Name: "Chrome", Bundle: raceBundle}

	tests := []struct {
		name  string
		edit  func(*fakeHoldOS)
		steps []func(*holdRig)
		want  []string
	}{
		{
			name:  "after a letter, one space",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = 'a', true },
			steps: []func(*holdRig){first},
			want:  []string{caret, pasted},
		},
		{
			name:  "after whitespace, none",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = ' ', true },
			steps: []func(*holdRig){land("Text.")},
			want:  []string{caret, "paste Text."},
		},
		{
			name:  "an app that does not say, or a selection: as it is",
			steps: []func(*holdRig){land("Text.")},
			want:  []string{caret, "paste Text."},
		},
		{
			name:  "the next dictation joins the last, with no read",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = 'a', true },
			steps: []func(*holdRig){first, next},
			want:  []string{caret, pasted, joined},
		},
		{
			name:  "with nothing known before the first, it still joins",
			steps: []func(*holdRig){land("One."), land("well, two."), land("Three,"), land("Then four.")},
			want:  []string{caret, "paste One.", "paste  Well, two.", "paste  Three,", "paste  then four."},
		},
		{
			name:  "the hold key's own events do not end it",
			steps: []func(*holdRig){land("One,"), event(flagsAt(0, flagLeftAlt)), event(flagsAt(500, 0)), land("And two.")},
			want:  []string{caret, "paste One,", "paste  and two."},
		},
		{
			name:  "nothing said does not end it",
			steps: []func(*holdRig){land("One,"), land(""), land("And two.")},
			want:  []string{caret, "paste One,", "paste  and two."},
		},
		{
			name:  "a key ends it",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = 'a', true },
			steps: []func(*holdRig){land("One,"), event(keyAt(0, 14)), land("And two.")},
			want:  []string{caret, "paste  One,", caret, "paste  And two."},
		},
		{
			name:  "a click ends it",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = 'a', true },
			steps: []func(*holdRig){land("One,"), event(altEvent{Kind: altEventMouseDown}), land("And two.")},
			want:  []string{caret, "paste  One,", caret, "paste  And two."},
		},
		{
			name:  "a gap in the tap ends it",
			steps: []func(*holdRig){land("One,"), func(r *holdRig) { r.s.interrupt("gone") }, land("And two.")},
			want:  []string{caret, "paste One,", caret, "paste And two."},
		},
		{
			name: "another app in front ends it",
			steps: []func(*holdRig){land("One,"), os(func(f *fakeHoldOS) { f.front = mailApp }), land("And two."),
				os(func(f *fakeHoldOS) { f.front = notesApp }), land("And three.")},
			want: []string{caret, "paste One,", fmt.Sprintf("caret %d", mailApp.PID), "paste And two.", caret, "paste And three."},
		},
		{
			name:  "a text left on the clipboard ends it, unspaced",
			edit:  func(f *fakeHoldOS) { f.before, f.beforeKnown = 'a', true },
			steps: []func(*holdRig){land("One,"), os(func(f *fakeHoldOS) { f.secure = true }), land("And two."), os(func(f *fakeHoldOS) { f.secure = false }), land("And three.")},
			want:  []string{caret, "paste  One,", "copy And two.", caret, "paste  And three."},
		},
		{
			name: "a failed paste ends it, and the clipboard gets the text unspaced",
			edit: func(f *fakeHoldOS) {
				f.before, f.beforeKnown = 'a', true
				f.board = &holdPasteboard{log: f.log, postErr: boom}
			},
			steps: []func(*holdRig){land("One,"), land("And two.")},
			want:  []string{caret, "paste  One,", "copy One,", caret, "paste  And two.", "copy And two."},
		},
		{
			name: "typing takes the same text",
			edit: func(f *fakeHoldOS) {
				f.front, f.before, f.beforeKnown = race, 'a', true
			},
			steps: []func(*holdRig){func(r *holdRig) { r.s.land(pasteJob{text: "One,", pressed: race}) }},
			want:  []string{"caret 7", "type  One,"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newHoldRig(t)
			r.os.set(func(f *fakeHoldOS) { f.logCaret = true })
			if tt.edit != nil {
				r.os.set(tt.edit)
			}
			for _, step := range tt.steps {
				step(r)
			}
			if got := r.log.all(); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got  %q\nwant %q", got, tt.want)
			}
		})
	}
}

// A click is no sign a tap hears keys: mouse events reach a tap that keys do not.
func TestHoldClickIsNotHearingKeys(t *testing.T) {
	r := newHoldRig(t)
	r.s.event(altEvent{Kind: altEventMouseDown})
	if r.s.watch.heard {
		t.Error("a click counted as the tap hearing keys")
	}
	r.s.event(keyAt(0, 14))
	if !r.s.watch.heard {
		t.Error("a key did not")
	}
}

// Nothing in the service's loop waits on the daemon, the main thread or a paste: the real
// run saw key events queue behind a 500 ms clipboard wait.
func TestHoldNeverBlocksTheEvents(t *testing.T) {
	inTime := func(t *testing.T, what string, f func()) {
		t.Helper()
		done := make(chan struct{})
		go func() {
			defer close(done)
			f()
		}()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			t.Fatalf("%s blocked the loop", what)
		}
	}

	t.Run("a daemon slow to Start", func(t *testing.T) {
		r := newHoldRig(t)
		r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
		block := make(chan struct{})
		r.conn.blockIn = block
		inTime(t, "Start", func() {
			r.s.event(flagsAt(0, flagLeftAlt))
			r.s.event(flagsAt(100, 0))
		})
		close(block)
		r.wait(t)
		// It answered late: the session is stopped there and then.
		if got := r.log.all(); !slices.Contains(got, "stop s1") {
			t.Errorf("log %q", got)
		}
	})

	t.Run("a main thread slow to answer", func(t *testing.T) {
		r := newHoldRig(t)
		r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
		block := make(chan struct{})
		r.os.set(func(f *fakeHoldOS) { f.blockIn = block })
		inTime(t, "frontmost", func() {
			r.s.event(flagsAt(0, flagLeftAlt))
			r.s.event(flagsAt(100, 0))
		})
		close(block)
		r.wait(t)
	})

	t.Run("an app slow to say what is before the caret", func(t *testing.T) {
		r := newHoldRig(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		block := make(chan struct{})
		r.os.set(func(f *fakeHoldOS) { f.beforeWait = block })
		go r.s.pasteLoop(ctx)
		r.conn.flushed = []string{"First."}
		r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
		inTime(t, "the hold", func() {
			r.s.event(flagsAt(0, flagLeftAlt))
			r.s.event(flagsAt(500, 0))
		})
		r.wait(t)
		inTime(t, "the next key", func() { r.s.event(keyAt(600, 14)) })
		close(block)
	})

	t.Run("a paste in progress", func(t *testing.T) {
		r := newHoldRig(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		block := make(chan struct{})
		r.os.set(func(f *fakeHoldOS) { f.board = &holdPasteboard{log: r.log, block: block} })
		go r.s.pasteLoop(ctx)
		r.conn.flushed = []string{"First."}
		r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
		inTime(t, "the first hold", func() {
			r.s.event(flagsAt(0, flagLeftAlt))
			r.s.event(flagsAt(500, 0))
		})
		r.wait(t)
		// The paste is stuck in Save: a new hold starts all the same.
		first := r.s.last
		inTime(t, "the second press", func() { r.s.event(flagsAt(1000, flagLeftAlt)) })
		if r.s.last == first {
			t.Fatal("the second press did not start a run")
		}
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			n := 0
			for _, l := range r.log.all() {
				if l == "start system" {
					n++
				}
			}
			if n == 2 {
				break
			}
			time.Sleep(time.Millisecond)
		}
		close(block)
		r.s.event(flagsAt(1100, 0))
		r.wait(t)
		if got := r.log.all(); !slices.Contains(got, "paste First.") {
			t.Logf("the paste has not landed yet; log %q", got)
		}
	})
}

// A hold right after another waits for the first flush, or the daemon would refuse it.
func TestHoldWaitsForTheLastFlush(t *testing.T) {
	r := newHoldRig(t)
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
	r.s.flushWait = 200 * time.Millisecond
	r.s.event(flagsAt(0, flagLeftAlt))
	r.s.event(flagsAt(500, 0))
	first := r.s.last
	r.s.event(flagsAt(600, flagRightAlt))
	r.s.event(flagsAt(700, 0))
	r.wait(t)
	<-first.done
	var starts, stops int
	for _, l := range r.log.all() {
		switch l {
		case "start system":
			starts++
		case "stop s1":
			stops++
		}
	}
	if starts != 2 || stops != 1 {
		t.Errorf("log %q", r.log.all())
	}
}

// A press during the last hold's tail cuts it, so the new session is not kept waiting, and
// what that hold said still pastes.
func TestHoldPressCutsTheTail(t *testing.T) {
	r := newHoldRig(t)
	r.os.set(func(f *fakeHoldOS) { f.front = notesApp })
	r.conn.mu.Lock()
	r.conn.tailing = make(chan struct{})
	r.conn.flushed = []string{"Whole."}
	r.conn.mu.Unlock()
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
	r.s.event(flagsAt(0, flagLeftAlt))
	r.s.event(flagsAt(500, 0))
	first := r.s.last
	for !slices.Contains(r.log.all(), "release s1") {
		time.Sleep(time.Millisecond)
	}
	r.s.event(flagsAt(600, flagRightAlt))
	r.s.event(flagsAt(1200, 0))
	r.wait(t)
	<-first.done
	r.land()
	got := r.log.all()
	if !slices.Contains(got, "finish s1") || !slices.Contains(got, "paste Whole.") {
		t.Errorf("log %q", got)
	}
	var starts int
	for _, l := range got {
		if l == "start system" {
			starts++
		}
	}
	if starts != 2 {
		t.Errorf("log %q, want two sessions", got)
	}
}

func TestHoldListener(t *testing.T) {
	r := newHoldRig(t)
	now := time.Unix(1000, 0)
	lastTap := func() *fakeTap {
		r.os.mu.Lock()
		defer r.os.mu.Unlock()
		if len(r.os.taps) == 0 {
			return nil
		}
		return r.os.taps[len(r.os.taps)-1]
	}
	taps := func() int {
		r.os.mu.Lock()
		defer r.os.mu.Unlock()
		return len(r.os.taps)
	}
	notGranted := func(a *v1.DictationAccessibility) bool { return !a.GetGranted() && !a.GetTapSilent() }
	granted := func(a *v1.DictationAccessibility) bool { return a.GetGranted() && !a.GetTapSilent() }
	silent := func(a *v1.DictationAccessibility) bool { return a.GetGranted() && a.GetTapSilent() }
	unreported := func(s *v1.DictationSnapshot) { s.Accessibility = nil }

	// Dictation off: nothing is asked of macOS and nothing runs.
	r.os.set(func(f *fakeHoldOS) { f.trust = true })
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(func(s *v1.DictationSnapshot) { s.Enabled = false; s.Accessibility = nil })})
	if taps() != 0 || r.s.period() != 0 || len(r.conn.reports) != 0 {
		t.Fatalf("dictation off: %d taps, period %s, reports %v", taps(), r.s.period(), r.conn.reports)
	}

	// On, not granted: no tap (it could prompt), a report, and a check a second.
	r.os.set(func(f *fakeHoldOS) { f.trust = false })
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(unreported)})
	if taps() != 0 {
		t.Fatal("a tap without the grant")
	}
	r.conn.lastReport(t, notGranted)
	if r.s.period() != holdTrustPoll {
		t.Errorf("period %s while not granted", r.s.period())
	}

	// Granted: the next check makes the tap and reports.
	r.os.set(func(f *fakeHoldOS) { f.trust = true })
	now = now.Add(time.Second)
	r.s.check(now)
	if taps() != 1 {
		t.Fatalf("%d taps after the grant", taps())
	}
	r.conn.lastReport(t, granted)
	if r.s.period() != holdTrustPoll {
		t.Errorf("period %s for a tap that has heard nothing", r.s.period())
	}

	// A tap that hears nothing while keys go by: the report asks for a restart.
	r.s.snap = holdSnapshot(nil)
	for range tapSilentChecks {
		now = now.Add(time.Second)
		r.os.set(func(f *fakeHoldOS) { f.age = 0 })
		r.s.check(now)
	}
	r.conn.lastReport(t, silent)

	// Hearing one event clears it at once, and checks drop to the slow pace.
	r.s.snap = holdSnapshot(func(s *v1.DictationSnapshot) { s.Accessibility.TapSilent = true })
	r.s.event(flagsAt(0, flagShift))
	r.conn.lastReport(t, granted)
	if r.s.period() != holdTrustRecheck {
		t.Errorf("period %s for a tap that works", r.s.period())
	}

	// Revoked: the tap goes, and a hold in progress is discarded.
	r.s.event(flagsAt(10, flagLeftAlt))
	run := r.s.last
	first := lastTap()
	r.os.set(func(f *fakeHoldOS) { f.trust = false })
	r.s.check(now.Add(time.Second))
	if !first.stopped || r.s.tap != nil {
		t.Fatal("the tap outlived the grant")
	}
	<-run.done
	if slices.Contains(r.log.all(), "release s1") {
		t.Errorf("a revoked hold counted: %v", r.log.all())
	}

	// Granted again: a new tap, never the old one.
	r.os.set(func(f *fakeHoldOS) { f.trust = true })
	r.s.check(now.Add(2 * time.Second))
	if taps() != 2 || lastTap() == first {
		t.Fatalf("%d taps after the second grant", taps())
	}

	// macOS ends the tap: the next check makes another.
	r.s.tapEnded()
	r.s.check(now.Add(3 * time.Second))
	if taps() != 3 {
		t.Fatalf("%d taps after macOS ended one", taps())
	}

	// Dictation off: it goes, and on again with the grant it comes back.
	second := lastTap()
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(func(s *v1.DictationSnapshot) { s.Enabled = false })})
	if !second.stopped || r.s.tap != nil {
		t.Fatal("the tap outlived the setting")
	}
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
	if taps() != 4 {
		t.Fatalf("%d taps after turning it back on", taps())
	}
}

func TestHoldTapRefused(t *testing.T) {
	r := newHoldRig(t)
	r.os.set(func(f *fakeHoldOS) { f.tapErr = errors.New("CGEventTapCreate returned NULL") })
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
	r.conn.lastReport(t, func(a *v1.DictationAccessibility) bool { return a.GetGranted() && a.GetTapSilent() })
	r.os.set(func(f *fakeHoldOS) { f.tapErr = nil })
	r.s.check(time.Now())
	if r.s.tap == nil {
		t.Fatal("no retry")
	}
	if r.s.tapFailed {
		t.Error("still failed")
	}
}

// A lost stream keeps the listener but starts nothing, and a daemon back from a restart
// hears the report again.
func TestHoldDaemonGone(t *testing.T) {
	r := newHoldRig(t)
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(func(s *v1.DictationSnapshot) { s.Accessibility = nil })})
	r.conn.lastReport(t, func(a *v1.DictationAccessibility) bool { return a.GetGranted() })
	r.conn.reports = nil
	r.s.update(holdUpdate{})
	if r.s.tap == nil {
		t.Fatal("a restart cost the listener")
	}
	r.s.event(flagsAt(0, flagLeftAlt))
	r.s.event(flagsAt(500, 0))
	if r.s.last != nil {
		t.Error("a hold started with no daemon")
	}
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(func(s *v1.DictationSnapshot) { s.Accessibility = nil })})
	r.conn.lastReport(t, func(a *v1.DictationAccessibility) bool { return a.GetGranted() })
}

func TestHoldSettingChanges(t *testing.T) {
	r := newHoldRig(t)
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(nil)})
	r.s.event(flagsAt(0, flagRightAlt))
	run := r.s.last
	r.s.update(holdUpdate{conn: r.conn, snap: holdSnapshot(func(s *v1.DictationSnapshot) { s.HoldKey = "left" })})
	<-run.done
	if got := r.log.all(); !slices.Contains(got, "stop s1") {
		t.Errorf("changing the key did not discard the hold: %v", got)
	}
	r.s.event(flagsAt(100, 0))
	before := r.s.last
	r.s.event(flagsAt(200, flagRightAlt))
	if r.s.last != before {
		t.Error("the old key still starts a hold")
	}
}

// observe never blocks, and only the latest matters.
func TestHoldObserveKeepsTheLatest(t *testing.T) {
	r := newHoldRig(t)
	first, last := holdSnapshot(nil), holdSnapshot(nil)
	r.s.observe(r.conn, first)
	r.s.observe(r.conn, last)
	r.s.lost()
	if u := <-r.s.updates; u.conn != nil || u.snap != nil {
		t.Errorf("got %+v", u)
	}
}

// The watcher hands the hold snapshots with their connection, never a heartbeat.
func TestDictationWatcherTellsTheHold(t *testing.T) {
	log := &eventLog{}
	daemon := &fakeDaemon{log: log}
	hold := &fakeHoldObserver{}
	w := dictationWatcher{
		dial: func(context.Context) (dictationConn, error) { return daemon, nil },
		mic:  &fakeMic{log: log, perm: micGranted},
		log:  slog.New(slog.DiscardHandler),
		hold: hold,
	}
	go func() {
		s := daemon.stream(0)
		s <- snapReady
		s <- snapHeartbeat
		s <- snapReady
		close(s)
	}()
	if err := w.once(context.Background()); err != nil {
		t.Fatal(err)
	}
	if hold.seen != 2 || hold.lostCount != 1 || hold.conn != dictationConn(daemon) {
		t.Errorf("%+v", hold)
	}
}

type fakeHoldObserver struct {
	seen, lostCount int
	conn            dictationConn
}

func (f *fakeHoldObserver) observe(c dictationConn, _ *v1.DictationSnapshot) {
	f.seen++
	f.conn = c
}

func (f *fakeHoldObserver) lost() { f.lostCount++ }

// The engine waits out the stop tone by a length it holds as a constant.
func TestStopToneLength(t *testing.T) {
	const header, bytesPerSecond = 44, 48000 * 2
	got := time.Duration(len(holdToneStopWAV)-header) * time.Second / bytesPerSecond
	if got != dictate.StopToneLength {
		t.Errorf("dictate-stop.wav is %s, dictate.StopToneLength %s", got, dictate.StopToneLength)
	}
}
