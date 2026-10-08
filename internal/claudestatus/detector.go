// Package claudestatus classifies a live Claude Code session as Busy, Idle, or
// NeedsAttention from what can be observed without rendering: the raw PTY output
// stream (title, notifications, mode switches, activity), the JSONL transcript, and,
// when needed, the plain-text screen.
//
// No single signal is trusted alone. The terminal title's spinner glyph is the
// primary busy signal; the screen decides between "at the prompt" and "a dialog is
// open"; the transcript confirms turn boundaries, pending tool calls, and API errors;
// notifications and bells are attention hints. Each signal has a fallback, so a
// change to one part of Claude Code's UI degrades detection instead of breaking it.
// See docs/notes/phase2b-status.md for the evidence behind each signal.
package claudestatus

import (
	"slices"
	"strings"
	"sync"
	"time"
)

// Status is a session's coarse state.
type Status int

// Statuses.
const (
	Unknown        Status = iota
	Busy                  // generating or running tools
	Idle                  // at the prompt, nothing pending, nothing unseen
	NeedsAttention        // a dialog is waiting for the user, or a finished turn is unseen
)

func (s Status) String() string {
	switch s {
	case Busy:
		return "busy"
	case Idle:
		return "idle"
	case NeedsAttention:
		return "needs-attention"
	default:
		return "unknown"
	}
}

// StatusDetector is the interface the session store uses.
type StatusDetector interface {
	// Output is a raw PTY output chunk. It is called on the terminal actor goroutine,
	// is fast, and never blocks on anything but a short internal mutex.
	Output(chunk []byte)
	// Transcript is one new JSONL line from ~/.claude/projects/<slug>/<id>.jsonl.
	Transcript(line []byte)
	// Tick advances time-based transitions. Call it about once a second.
	Tick(now time.Time)
	// Status returns the current status and a short human reason.
	Status() (Status, string)
}

var _ StatusDetector = (*Detector)(nil)

// Timing. The values come from the fixtures in testdata (Claude Code 2.1.294): the
// title spinner changes every ~960 ms; the transcript's turn-end records land ~100-150
// ms after the title stops spinning; dialogs are fully drawn within one 250 ms frame.
const (
	// titleStale: a spinner title that has not changed for this long is no longer
	// evidence of work (the process may be frozen or the animation gone).
	titleStale = 3 * time.Second
	// settle: after busy evidence stops, a screen read at least this much later is
	// required before deciding between Idle and NeedsAttention (unless the transcript
	// already recorded the end of the turn). Prevents a stale pre-turn screen from
	// reporting "at prompt" while a permission dialog is being drawn.
	settle = 300 * time.Millisecond
	// maxSettle bounds the wait for that screen read (no screen func, or it fails).
	maxSettle = 2 * time.Second
	// grace: how long Claude must be not-busy, with no prompt visible, while the
	// transcript shows an open turn, before that alone counts as waiting for the user
	// (covers dialogs the screen classifier misses).
	grace = 1500 * time.Millisecond
	// unknownHold: how long the evidence must say "unknown" before a known status is
	// dropped.
	unknownHold = time.Second
	// Output activity fallback (used only without a usable title): at least
	// activityChunks chunks within activityWindow while the transcript has a turn open.
	activityWindow = time.Second
	activityChunks = 5
)

// Option configures a Detector.
type Option func(*Detector)

// WithClock sets the clock used to timestamp Output, Transcript, and Input calls.
// Tick uses the time it is given. Default time.Now.
func WithClock(now func() time.Time) Option { return func(d *Detector) { d.now = now } }

// Detector implements StatusDetector. It is safe for concurrent use. Create it with
// New.
type Detector struct {
	screen func() (string, error)
	now    func() time.Time

	mu   sync.Mutex
	scan *streamScanner
	cur  time.Time // time of the Output call being scanned

	// Stream signals.
	title          string
	tKind          titleKind
	tTask          string
	titleAt        time.Time // last title change
	chunks         [16]time.Time
	chunkIdx       int
	outSeq         uint64
	lastOutputAt   time.Time
	altScreen      bool
	bracketedPaste bool
	notifyText     string
	notifyAt       time.Time
	bellAt         time.Time
	progressActive bool
	psState        string
	psKind         string
	psText         string

	// Screen.
	info       ScreenInfo
	screenRead bool
	screenAt   time.Time
	screenErr  error
	readSeq    uint64 // outSeq when the screen was last read

	// Transcript.
	turnActive  bool
	turnStartAt time.Time
	turnEndAt   time.Time
	pending     map[string]string // tool_use id -> tool name
	stopReason  string
	apiError    string

	// User.
	ackAt  time.Time // last Input or Acknowledge (or interrupt)
	workAt time.Time // last evidence of new output: spinner title change, assistant record, ...

	// State machine.
	busyNow      bool
	busyByTitle  bool
	busyStartAt  time.Time
	busyEndAt    time.Time
	unknownSince time.Time
	status       Status
	reason       string
	since        time.Time
}

// New returns a Detector. screen returns the current plain-text screen (rows joined by
// '\n'; scrollback above the visible rows is harmless). It is called only from Tick,
// never while the Detector's lock is held, and only when the screen may have changed
// and the title alone cannot decide. screen may be nil.
func New(screen func() (string, error), opts ...Option) *Detector {
	d := &Detector{screen: screen, now: time.Now, pending: map[string]string{}, reason: "starting"}
	for _, o := range opts {
		o(d)
	}
	d.scan = newStreamScanner(sink{d})
	return d
}

// Output implements StatusDetector.
func (d *Detector) Output(chunk []byte) {
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cur = now
	d.outSeq++
	d.lastOutputAt = now
	d.chunks[d.chunkIdx] = now
	d.chunkIdx = (d.chunkIdx + 1) % len(d.chunks)
	d.scan.scan(chunk)
	d.evaluate(now)
}

// Transcript implements StatusDetector.
func (d *Detector) Transcript(line []byte) {
	ev := parseTranscriptLine(line)
	if ev.kind == trIgnored {
		return
	}
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	switch ev.kind {
	case trPrompt:
		d.turnActive, d.turnStartAt = true, now
		clear(d.pending)
		d.stopReason, d.apiError = "", ""
	case trAssistant:
		d.workAt = now
		for _, tu := range ev.toolUses {
			d.pending[tu.id] = tu.name
		}
		if ev.stopReason != "" {
			d.stopReason = ev.stopReason
		}
		if ev.apiError != "" {
			d.apiError = ev.apiError
		}
		switch ev.stopReason {
		case "end_turn", "stop_sequence", "max_tokens", "refusal":
			if len(d.pending) == 0 {
				d.turnActive, d.turnEndAt = false, now
			}
		}
	case trToolResult:
		for _, id := range ev.toolResults {
			delete(d.pending, id)
		}
	case trInterrupted:
		// The user interrupted (Ctrl-C, Esc, or "No" on a permission prompt), so they
		// are looking at the session.
		clear(d.pending)
		d.turnActive, d.turnEndAt = false, now
		d.ackAt = now
	case trTurnEnd:
		clear(d.pending)
		d.turnActive, d.turnEndAt = false, now
	}
	d.evaluate(now)
}

// Input records that the user sent input to the session (keystrokes, paste). It
// acknowledges unseen output, so "finished" attention clears when the user types.
// The session store should call it from its Write path. Dialog attention stays until
// the dialog is gone from the screen.
func (d *Detector) Input(data []byte) {
	if len(data) == 0 {
		return
	}
	d.Acknowledge()
}

// Acknowledge marks everything Claude has produced so far as seen (for example when
// the GUI shows the session's terminal).
func (d *Detector) Acknowledge() {
	now := d.now()
	d.mu.Lock()
	defer d.mu.Unlock()
	d.ackAt = now
	d.evaluate(now)
}

// Tick implements StatusDetector. It may call the screen func (without holding the
// lock).
func (d *Detector) Tick(now time.Time) {
	d.mu.Lock()
	d.evaluate(now)
	need := d.needScreen(now)
	seq := d.outSeq
	d.mu.Unlock()
	if !need {
		return
	}
	text, err := d.screen()
	var info ScreenInfo
	if err == nil {
		info = ClassifyScreen(text)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.screenAt, d.screenErr, d.readSeq = now, err, seq
	if err == nil {
		d.info, d.screenRead = info, true
	}
	d.evaluate(now)
}

// Status implements StatusDetector.
func (d *Detector) Status() (Status, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.status, d.reason
}

// needScreen decides whether Tick should read the screen. The lock is held.
func (d *Detector) needScreen(now time.Time) bool {
	if d.screen == nil {
		return false
	}
	if d.busyNow && d.busyByTitle {
		return false // the title already says busy; the screen cannot change that
	}
	settleAt := d.busyEndAt.Add(settle)
	if !d.busyEndAt.IsZero() && now.Before(settleAt) {
		return false // let the frame after the last busy signal finish drawing
	}
	switch {
	case !d.screenRead:
		return true
	case d.outSeq != d.readSeq:
		return true
	case d.screenAt.Before(settleAt):
		return true
	}
	return false
}

// evaluate recomputes the status. The lock is held.
func (d *Detector) evaluate(now time.Time) {
	if busy, reason, byTitle := d.busyEvidence(now); busy {
		if !d.busyNow {
			d.busyStartAt = now
		}
		d.busyNow, d.busyByTitle = true, byTitle
		if !byTitle && now.Sub(d.ackAt) > activityWindow {
			// With a title, work is timed by its spinner changes instead. Output right
			// after the user's own input (echo, redraw) is not new work.
			d.workAt = now
		}
		d.set(Busy, reason, now)
		return
	}
	if d.busyNow {
		d.busyNow, d.busyEndAt = false, now
	}
	if d.status == Busy {
		// Hysteresis: keep Busy until the screen has been read after the work stopped,
		// unless the idle title and the transcript already agree that the turn is over
		// (no dialog can be open then).
		fresh := d.screenRead && !d.screenAt.Before(d.busyEndAt.Add(settle))
		turnOver := d.tKind == titleIdle && !d.turnActive && !d.turnEndAt.IsZero() &&
			!d.turnEndAt.Before(d.busyStartAt)
		if !fresh && !turnOver && now.Sub(d.busyEndAt) < maxSettle {
			return
		}
	}
	st, reason := d.restingStatus(now)
	if st == Unknown && d.status != Unknown {
		// Do not drop a known status for a momentary gap (the blank frame between the
		// trust dialog and the UI, a redraw): Unknown must persist for unknownHold.
		if d.unknownSince.IsZero() {
			d.unknownSince = now
		}
		if now.Sub(d.unknownSince) < unknownHold {
			return
		}
	} else if st != Unknown {
		d.unknownSince = time.Time{}
	}
	d.set(st, reason, now)
}

// busyEvidence reports whether Claude is working. byTitle is set when the title alone
// decided.
func (d *Detector) busyEvidence(now time.Time) (busy bool, reason string, byTitle bool) {
	switch d.tKind {
	case titleSpinner:
		if now.Sub(d.titleAt) <= titleStale {
			return true, d.busyReason(), true
		}
	case titleIdle:
		return false, "", true // authoritative: Claude draws ✳ whenever no request is in flight
	}
	// No usable title: combine the weaker signals.
	switch {
	case d.psState == "working":
		return true, d.busyReason(), false
	case d.progressActive:
		return true, d.busyReason(), false
	case d.screenRead && d.info.Spinner && now.Sub(d.screenAt) <= 2*time.Second:
		return true, d.busyReason(), false
	case d.turnActive && d.recentChunks(now) >= activityChunks:
		return true, d.busyReason(), false
	}
	return false, "", false
}

func (d *Detector) busyReason() string {
	if len(d.pending) > 0 {
		return "running " + d.pendingTools()
	}
	if d.tTask != "" {
		return "working: " + d.tTask
	}
	return "working"
}

// restingStatus classifies a session that is not working. The lock is held.
func (d *Detector) restingStatus(now time.Time) (Status, string) {
	// A screen read before the last busy period says nothing about now.
	fresh := d.screenRead && !d.screenAt.Before(d.busyEndAt)
	if fresh && d.info.Dialog != DialogNone {
		return NeedsAttention, d.info.Dialog.String() + ": " + shorten(d.info.DialogText)
	}
	if d.psState == "blocked" {
		return NeedsAttention, "blocked: " + nonEmpty(d.psKind, d.psText, "program status")
	}
	promptVisible := fresh && d.info.PromptBox
	if d.turnActive && !promptVisible {
		// The turn is open, nothing is working, and no prompt is visible: Claude is
		// waiting on the user in some UI the screen classifier did not recognise.
		// Hold the current status for a grace period first, so the transcript's
		// turn-end record (which lags the title by ~100 ms) can arrive.
		if now.Sub(laterOf(d.busyEndAt, d.turnStartAt)) < grace {
			return d.status, d.reason
		}
		if len(d.pending) > 0 {
			return NeedsAttention, "waiting for approval: " + d.pendingTools()
		}
		return NeedsAttention, "waiting for input"
	}
	if d.notifyAt.After(d.ackAt) && !d.notifyAt.Before(d.busyEndAt) && !isIdleReminder(d.notifyText) {
		return NeedsAttention, "notification: " + shorten(d.notifyText)
	}
	if d.bellAt.After(d.ackAt) && !d.bellAt.Before(d.busyEndAt) {
		return NeedsAttention, "bell"
	}
	if promptVisible || d.tKind == titleIdle || d.psState == "idle" || d.psState == "done" {
		if d.workAt.After(d.ackAt) {
			if d.apiError != "" {
				return NeedsAttention, "error: " + d.apiError
			}
			return NeedsAttention, "finished"
		}
		return Idle, "at prompt"
	}
	if fresh {
		return Unknown, "no prompt visible"
	}
	return Unknown, "no signals yet"
}

func (d *Detector) set(st Status, reason string, now time.Time) {
	if st != d.status {
		d.since = now
	}
	d.status, d.reason = st, reason
}

func (d *Detector) recentChunks(now time.Time) int {
	n := 0
	for _, t := range d.chunks {
		if !t.IsZero() && now.Sub(t) <= activityWindow {
			n++
		}
	}
	return n
}

func (d *Detector) pendingTools() string {
	names := make([]string, 0, len(d.pending))
	for _, n := range d.pending {
		names = append(names, n)
	}
	slices.Sort(names)
	return strings.Join(slices.Compact(names), ", ")
}

// sink receives scanner callbacks; they run inside Output with the lock held.
type sink struct{ d *Detector }

func (s sink) osc(payload []byte) {
	d := s.d
	ev := parseOSC(payload)
	switch ev.kind {
	case oscTitle:
		if ev.text == d.title {
			return
		}
		d.title = ev.text
		d.tKind, _, d.tTask = classifyTitle(ev.text)
		d.titleAt = d.cur
		if d.tKind == titleSpinner {
			d.workAt = d.cur
		}
	case oscNotify:
		d.notifyText, d.notifyAt = ev.text, d.cur
	case oscProgress:
		d.progressActive = ev.progressActive
		if ev.progressActive {
			d.workAt = d.cur
		}
	case oscProgramStatus:
		if ev.psState == "clear" {
			d.psState, d.psKind, d.psText = "", "", ""
			return
		}
		d.psState, d.psKind, d.psText = ev.psState, ev.psKind, ev.text
		if ev.psState == "working" {
			d.workAt = d.cur
		}
	}
}

func (s sink) bell() { s.d.bellAt = s.d.cur }

func (s sink) decMode(mode int, set bool) {
	switch mode {
	case 1049, 1047, 47:
		s.d.altScreen = set
	case 2004:
		s.d.bracketedPaste = set
	}
}

// isIdleReminder matches Claude's "waiting for your input" notification, sent after
// the prompt has been idle for a while. It restates Idle; it is not a new request.
func isIdleReminder(text string) bool {
	return strings.Contains(strings.ToLower(text), "waiting for your input")
}

func shorten(s string) string {
	const limit = 80
	if len(s) <= limit {
		return s
	}
	cut := limit
	for cut > 0 && s[cut]&0xc0 == 0x80 { // do not split a UTF-8 sequence
		cut--
	}
	return s[:cut] + "…"
}

func laterOf(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

func nonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}
