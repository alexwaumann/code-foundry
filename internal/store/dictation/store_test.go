package dictation_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/dictate"
	"github.com/alexwaumann/code-foundry/internal/store/dictation"
	"github.com/alexwaumann/code-foundry/internal/store/dictation/dictationtest"
)

// testModel is a tiny model so tests can put it on disk or serve it.
var testModel = func() dictation.Model {
	body := modelBody()
	sum := sha256.Sum256(body)
	return dictation.Model{Name: "test.bin", Title: "Test", Sources: []dictation.Source{{URL: "http://invalid/test.bin"}}, Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
}()

func modelBody() []byte {
	b := make([]byte, 3000)
	for i := range b {
		b[i] = byte(i * 7)
	}
	return b
}

type harness struct {
	t        *testing.T
	store    *dictation.Store
	bus      *bus.Bus
	clock    *dictationtest.Clock
	launcher *dictationtest.Launcher
	dir      string
	enabled  atomic.Bool
	enables  atomic.Int32
	sessions *bus.Subscription[dictation.SessionEvent]
}

type setup struct {
	enabled, model bool
	launcher       *dictationtest.Launcher
	opts           func(*dictation.Options)
}

func newHarness(t *testing.T, s setup) *harness {
	t.Helper()
	h := &harness{t: t, bus: bus.New(), clock: dictationtest.NewClock(time.Unix(1_000_000, 0)), launcher: s.launcher, dir: t.TempDir()}
	if h.launcher == nil {
		h.launcher = &dictationtest.Launcher{}
	}
	h.enabled.Store(s.enabled)
	if s.model {
		if err := os.WriteFile(filepath.Join(h.dir, testModel.Name), modelBody(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h.sessions = bus.Subscribe[dictation.SessionEvent](h.bus, 1024)
	opts := dictation.Options{
		Dir: h.dir, Bus: h.bus, Model: testModel, Clock: h.clock, Launch: h.launcher.Launch,
		Enabled: h.enabled.Load,
		Enable: func() error {
			h.enables.Add(1)
			h.enabled.Store(true)
			go h.store.ConfigChanged() // as the settings store's OnChange would
			return nil
		},
		Hardware: func() dictation.Hardware { return dictation.HardwareOf("Apple M1 Pro", 16<<30) },
	}
	if s.opts != nil {
		s.opts(&opts)
	}
	h.store = dictation.New(opts)
	t.Cleanup(h.store.Close)
	return h
}

// wait polls until the snapshot satisfies ok.
func (h *harness) wait(what string, ok func(dictation.Snapshot) bool) dictation.Snapshot {
	h.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		s := h.store.Snapshot()
		if ok(s) {
			return s
		}
		if time.Now().After(deadline) {
			h.t.Fatalf("waiting for %s: snapshot %+v", what, s)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func (h *harness) waitState(want dictation.State) dictation.Snapshot {
	h.t.Helper()
	return h.wait(want.String(), func(s dictation.Snapshot) bool { return s.State == want })
}

func (h *harness) setEnabled(on bool) {
	h.enabled.Store(on)
	h.store.ConfigChanged()
}

// sessionEvents reads session events for id until ended (or a timeout).
func (h *harness) sessionEvents(id string) []dictation.SessionEvent {
	h.t.Helper()
	var out []dictation.SessionEvent
	timeout := time.After(3 * time.Second)
	for {
		select {
		case ev := <-h.sessions.C():
			if ev.SessionID != id {
				continue
			}
			out = append(out, ev)
			if ev.Kind == dictation.SessionEnded {
				return out
			}
		case <-timeout:
			h.t.Fatalf("session %s did not end; events %+v", id, out)
		}
	}
}

func phrasesAndEnd(evs []dictation.SessionEvent) []string {
	var out []string
	for _, ev := range evs {
		switch ev.Kind {
		case dictation.SessionPhrase:
			out = append(out, ev.Text)
		case dictation.SessionEnded:
			out = append(out, "ended:"+ev.Reason.String())
		}
	}
	return out
}

func TestStartupStates(t *testing.T) {
	for _, tc := range []struct {
		name           string
		enabled, model bool
		want           dictation.State
		launches       int
	}{
		{"off without model", false, false, dictation.Disabled, 0},
		{"off with model", false, true, dictation.Disabled, 0},
		{"on without model", true, false, dictation.NoModel, 0},
		{"on with model loads", true, true, dictation.Ready, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: tc.enabled, model: tc.model})
			s := h.waitState(tc.want)
			if s.Model.Downloaded != tc.model || s.Enabled != tc.enabled {
				t.Errorf("snapshot %+v", s)
			}
			if s.Hardware.Chip != "Apple M1 Pro" || !s.Hardware.M1Family || s.Hardware.MemoryBytes != 16<<30 {
				t.Errorf("hardware %+v", s.Hardware)
			}
			if n := h.launcher.Count(); n != tc.launches {
				t.Errorf("launches = %d, want %d", n, tc.launches)
			}
			if tc.launches > 0 && !h.launcher.Last().Loaded() {
				t.Error("model not loaded")
			}
		})
	}
}

func TestEnableDisable(t *testing.T) {
	h := newHarness(t, setup{model: true})
	h.waitState(dictation.Disabled)
	h.setEnabled(true)
	h.waitState(dictation.Ready)
	first := h.launcher.Last()
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	h.setEnabled(false)
	h.waitState(dictation.Disabled)
	if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, []string{"ended:disabled"}) {
		t.Errorf("session events %v", got)
	}
	h.wait("engine exit", func(dictation.Snapshot) bool { return first.Exited() })
	if _, err := h.store.Start(context.Background(), "c1"); !errors.Is(err, dictation.ErrDisabled) {
		t.Errorf("Start while off: %v", err)
	}
	h.setEnabled(true)
	h.waitState(dictation.Ready)
	if h.launcher.Count() != 2 {
		t.Errorf("launches = %d, want a new engine", h.launcher.Count())
	}
}

func TestModelStaysLoadedWhileIdle(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	h.clock.Advance(7 * 24 * time.Hour)
	time.Sleep(20 * time.Millisecond)
	h.waitState(dictation.Ready)
	if eng.Exited() || !eng.Loaded() || h.launcher.Count() != 1 {
		t.Errorf("exited %v, loaded %v, launches %d", eng.Exited(), eng.Loaded(), h.launcher.Count())
	}
}

func TestPrefsPublish(t *testing.T) {
	anywhere := dictation.Prefs{Anywhere: true, HoldKey: "either", Sounds: true}
	for _, tc := range []struct {
		name    string
		enabled bool
		want    dictation.State
	}{
		{"dictation on", true, dictation.Ready},
		{"dictation off", false, dictation.Disabled},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var prefs atomic.Pointer[dictation.Prefs]
			prefs.Store(&dictation.Prefs{HoldKey: "either", Sounds: true})
			h := newHarness(t, setup{enabled: tc.enabled, model: true, opts: func(o *dictation.Options) {
				o.Prefs = func() dictation.Prefs { return *prefs.Load() }
			}})
			h.waitState(tc.want)
			if got := h.store.Snapshot().Prefs; got != *prefs.Load() {
				t.Fatalf("first snapshot's prefs %+v", got)
			}
			changes := bus.Subscribe[dictation.Changed](h.bus, 16)
			defer changes.Close()

			// Reading the same settings again publishes nothing.
			h.store.ConfigChanged()
			select {
			case c := <-changes.C():
				t.Fatalf("published %+v with nothing changed", c.Snapshot)
			case <-time.After(20 * time.Millisecond):
			}
			launches := h.launcher.Count()

			prefs.Store(&anywhere)
			h.store.ConfigChanged()
			select {
			case c := <-changes.C():
				if c.Snapshot.Prefs != anywhere || c.Snapshot.State != tc.want {
					t.Errorf("published %+v", c.Snapshot)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("no snapshot after the prefs changed")
			}
			// Only the snapshot: the engine is left alone.
			if h.launcher.Count() != launches || (tc.enabled && h.launcher.Last().Exited()) {
				t.Errorf("launches %d, want %d", h.launcher.Count(), launches)
			}
		})
	}
}

func TestPressureUnloadReloadsOnStart(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	eng.Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	h.waitState(dictation.Unloaded)
	// It stays unloaded until it is used.
	time.Sleep(20 * time.Millisecond)
	h.waitState(dictation.Unloaded)
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	s := h.waitState(dictation.Listening)
	if s.Session.ID != id || s.Session.ClientID != "c1" {
		t.Errorf("session %+v", s.Session)
	}
	loads := 0
	for _, c := range eng.Calls() {
		if c == dictate.MethodLoad {
			loads++
		}
	}
	if loads != 2 {
		t.Errorf("calls %v, want a second load", eng.Calls())
	}
}

// The engine drops the model again before the store has handled load's reply: the
// snapshot must not say Ready, and the next Start loads it once more.
func TestPressureUnloadDuringLoadStaysUnloaded(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	eng.Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	h.waitState(dictation.Unloaded)

	gate := make(chan struct{})
	eng.SetLoadGate(gate)
	started := make(chan error, 1)
	go func() {
		_, err := h.store.Start(context.Background(), "c1")
		started <- err
	}()
	h.waitState(dictation.Loading)
	eng.Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	h.waitState(dictation.Unloaded)
	eng.SetLoadGate(nil)
	close(gate)
	select {
	case err := <-started:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Start did not return")
	}
	h.waitState(dictation.Listening)
	loads := 0
	for _, c := range eng.Calls() {
		if c == dictate.MethodLoad {
			loads++
		}
	}
	if loads != 3 {
		t.Errorf("calls %v, want a third load", eng.Calls())
	}
}

func TestPressureUnloadEndsSession(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	h.launcher.Last().Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, []string{"ended:error"}) {
		t.Errorf("events %v", got)
	}
	h.waitState(dictation.Unloaded)
}

func TestCrashRestartsWithBackoffThenFails(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	// restartAfter waits for the retry timer, checks nothing launches a moment before
	// d, and lets it fire.
	restartAfter := func(d time.Duration, launches int) {
		t.Helper()
		h.wait("retry armed", func(s dictation.Snapshot) bool { return s.State == dictation.Loading && h.clock.Pending() > 0 })
		h.clock.Advance(d - time.Millisecond)
		time.Sleep(10 * time.Millisecond)
		if n := h.launcher.Count(); n != launches-1 {
			t.Fatalf("restart came early: launches %d", n)
		}
		h.clock.Advance(time.Millisecond)
		h.wait("restart", func(dictation.Snapshot) bool { return h.launcher.Count() == launches })
	}

	// A crash with the model loaded: the session ends, the engine is back after 1 s.
	h.launcher.Last().Crash(errors.New("segfault"))
	if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, []string{"ended:error"}) {
		t.Errorf("events %v", got)
	}
	restartAfter(time.Second, 2)
	h.waitState(dictation.Ready)

	// A loaded engine starts the count again; one that keeps failing to load is
	// restarted MaxRestarts times, then left Failed.
	h.launcher.SetSetup(func(e *dictationtest.Engine) { e.SetFailLoad(errors.New("no metal device")) })
	h.launcher.Last().Crash(errors.New("segfault"))
	restartAfter(time.Second, 3)
	restartAfter(4*time.Second, 4)
	restartAfter(15*time.Second, 5)
	s := h.waitState(dictation.Failed)
	if !strings.Contains(s.Error, "no metal device") || h.clock.Pending() != 0 {
		t.Errorf("error %q, pending timers %d", s.Error, h.clock.Pending())
	}
	if _, err := h.store.Start(context.Background(), "c1"); !errors.Is(err, dictation.ErrEngine) {
		t.Errorf("Start in Failed: %v", err)
	}
	// Off and on retries.
	h.launcher.SetSetup(nil)
	h.setEnabled(false)
	h.waitState(dictation.Disabled)
	h.setEnabled(true)
	h.waitState(dictation.Ready)
	if s := h.store.Snapshot(); s.Error != "" {
		t.Errorf("error kept: %q", s.Error)
	}
}

func TestMissingEngineFailsAtOnce(t *testing.T) {
	l := &dictationtest.Launcher{Fail: []error{fmt.Errorf("%w (/x/code-foundry-dictate)", dictation.ErrEngineMissing)}}
	h := newHarness(t, setup{enabled: true, model: true, launcher: l})
	s := h.waitState(dictation.Failed)
	if s.Error == "" || h.clock.Pending() != 0 {
		t.Errorf("snapshot %+v, pending timers %d", s, h.clock.Pending())
	}
}

// Every phrase goes through the spoken commands in the store, whoever reads the session.
func TestSessionPhrasesSpoken(t *testing.T) {
	const said = "one comma two new line"
	for _, tc := range []struct {
		name   string
		spoken dictate.Spoken
		want   string
	}{
		{"off", dictate.Spoken{}, said},
		{"formatting", dictate.Spoken{Formatting: true}, "one comma two\n"},
		{"both", dictate.Spoken{Symbols: true, Formatting: true}, "one, two\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true, opts: func(o *dictation.Options) {
				o.Prefs = func() dictation.Prefs { return dictation.Prefs{Spoken: tc.spoken} }
			}})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			h.launcher.Last().Speak(said)
			if err := h.store.Stop(context.Background(), id, true); err != nil {
				t.Fatal(err)
			}
			want := []string{tc.want, "ended:stopped"}
			if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, want) {
				t.Errorf("events %q, want %q", got, want)
			}
		})
	}
}

func TestSessionPhrasesAndFlush(t *testing.T) {
	for _, tc := range []struct {
		name   string
		flush  bool
		want   []string
		reason dictation.EndReason
	}{
		{"flush keeps the tail", true, []string{"hello there", "and the tail", "ended:stopped"}, dictation.EndStopped},
		{"no flush drops it", false, []string{"hello there", "ended:discarded"}, dictation.EndDiscarded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			eng := h.launcher.Last()
			if eng.Session() != id {
				t.Fatalf("engine session %q, want %q", eng.Session(), id)
			}
			for range 3 {
				if !h.store.Audio(id, make([]byte, 640), 0.2) {
					t.Fatal("frame refused")
				}
			}
			if h.store.Audio("other", make([]byte, 640), 0.2) {
				t.Error("frame of another session taken")
			}
			if f, b := eng.Frames(); f != 3 || b != 3*640 {
				t.Errorf("engine got %d frames, %d bytes", f, b)
			}
			eng.Speak("hello there")
			eng.SetPhrases("and the tail")
			if err := h.store.Stop(context.Background(), id, tc.flush); err != nil {
				t.Fatal(err)
			}
			if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, tc.want) {
				t.Errorf("events %v, want %v", got, tc.want)
			}
			h.waitState(dictation.Ready)
			if r, ended, ok := h.store.SessionEnded(id); !ok || !ended || r != tc.reason {
				t.Errorf("SessionEnded = %v %v %v", r, ended, ok)
			}
			// Stopping again is fine.
			if err := h.store.Stop(context.Background(), id, true); err != nil {
				t.Error(err)
			}
		})
	}
}

// Stopping shows on the snapshot only for a flush, between Stop and the end.
func TestStoppingSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name  string
		flush bool
		want  []bool // Session.Stopping of each snapshot with the session, from the Stop on
	}{
		{"flush", true, []bool{true}},
		{"no flush", false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			changes := bus.Subscribe[dictation.Changed](h.bus, 64)
			defer changes.Close()
			if err := h.store.Stop(context.Background(), id, tc.flush); err != nil {
				t.Fatal(err)
			}
			var got []bool
			for len(changes.C()) > 0 {
				if s := (<-changes.C()).Snapshot.Session; s != nil {
					got = append(got, s.Stopping)
				}
			}
			if !slices.Equal(got, tc.want) {
				t.Errorf("stopping snapshots %v, want %v", got, tc.want)
			}
			if s := h.store.Snapshot(); s.Session != nil {
				t.Errorf("session after the end: %+v", s.Session)
			}
		})
	}
}

func TestRelease(t *testing.T) {
	sounds := func(on bool, volume int) func(*dictation.Options) {
		return func(o *dictation.Options) {
			o.Prefs = func() dictation.Prefs { return dictation.Prefs{Sounds: on, SoundVolume: volume} }
		}
	}
	tests := []struct {
		name    string
		opts    func(*dictation.Options)
		noAudio bool
		want    dictate.EndParams
	}{
		{"a tail, with no tone to wait for", nil, false, dictate.EndParams{Flush: true, Tail: true}},
		{"the tone's length with sounds on", sounds(true, 50), false, dictate.EndParams{Flush: true, Tail: true, ToneMS: 140}},
		{"no tone at volume 0", sounds(true, 0), false, dictate.EndParams{Flush: true, Tail: true}},
		{"no tone with sounds off", sounds(false, 50), false, dictate.EndParams{Flush: true, Tail: true}},
		{"no tail with no frame heard", nil, true, dictate.EndParams{Flush: true}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true, opts: tc.opts})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			if !tc.noAudio {
				h.store.Audio(id, make([]byte, 640), 0.5)
			}
			if err := h.store.Release(context.Background(), id); err != nil {
				t.Fatal(err)
			}
			tc.want.Session = id
			if got := h.launcher.Last().Ends(); !slices.Equal(got, []dictate.EndParams{tc.want}) {
				t.Errorf("ends %+v, want %+v", got, tc.want)
			}
			if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, []string{"ended:stopped"}) {
				t.Errorf("events %v", got)
			}
		})
	}
}

// startTail starts a session, hears a frame and releases it, returning with the tail
// running and what Release returned on done.
func startTail(t *testing.T, h *harness) (id string, done chan struct{}) {
	t.Helper()
	h.waitState(dictation.Ready)
	h.launcher.Last().HoldTails()
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	h.store.Audio(id, make([]byte, 640), 0.5)
	done = make(chan struct{})
	go func() {
		defer close(done)
		_ = h.store.Release(context.Background(), id)
	}()
	h.wait("stopping", func(s dictation.Snapshot) bool { return s.Session != nil && s.Session.Stopping })
	for len(h.launcher.Last().Ends()) == 0 {
		time.Sleep(time.Millisecond)
	}
	return id, done
}

// A release shows as stopping at once, and the frames of its tail still reach the engine,
// raising no level: the plate is working by then.
func TestTailFrames(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	id, done := startTail(t, h)
	h.clock.Advance(time.Second) // past any level throttle
	if !h.store.Audio(id, make([]byte, 640), 0.5) {
		t.Error("a frame of the tail was dropped")
	}
	if f, _ := h.launcher.Last().Frames(); f != 2 {
		t.Errorf("engine got %d frames, want 2", f)
	}
	if s := h.store.Snapshot(); s.State != dictation.Listening {
		t.Errorf("state %v, want the microphone kept open by Listening", s.State)
	}
	h.launcher.Last().FinishTail()
	<-done
	if h.store.Audio(id, make([]byte, 640), 0.5) {
		t.Error("a frame after the end was taken")
	}
	levels := 0
	for _, ev := range h.sessionEvents(id) {
		if ev.Kind == dictation.SessionLevel {
			levels++
		}
	}
	if levels != 1 {
		t.Errorf("levels = %d, want 1, from before the release", levels)
	}
}

func TestStopDuringATail(t *testing.T) {
	for _, tc := range []struct {
		name  string
		flush bool
	}{{"with flush", true}, {"without flush, as what was released counts", false}} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true})
			id, done := startTail(t, h)
			h.launcher.Last().SetPhrases("Whole.")
			if err := h.store.Stop(context.Background(), id, tc.flush); err != nil {
				t.Fatal(err)
			}
			// It returned with the session over, so a Start right after finds room.
			if s := h.store.Snapshot(); s.Session != nil {
				t.Errorf("session after the Stop: %+v", s.Session)
			}
			<-done
			want := []dictate.EndParams{{Session: id, Flush: true, Tail: true}, {Session: id, Flush: true}}
			if got := h.launcher.Last().Ends(); !slices.Equal(got, want) {
				t.Errorf("ends %+v, want %+v", got, want)
			}
			if got := phrasesAndEnd(h.sessionEvents(id)); !slices.Equal(got, []string{"Whole.", "ended:stopped"}) {
				t.Errorf("events %v", got)
			}
			if _, err := h.store.Start(context.Background(), "c2"); err != nil {
				t.Errorf("start after the Stop: %v", err)
			}
		})
	}
}

// A Start during a tail is refused, as during any stop; a Stop first makes the room.
func TestStartDuringATail(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	_, done := startTail(t, h)
	for _, client := range []string{"c1", "c2"} {
		if _, err := h.store.Start(context.Background(), client); !errors.Is(err, dictation.ErrBusy) {
			t.Errorf("%s: %v", client, err)
		}
	}
	h.launcher.Last().FinishTail()
	<-done
}

func TestLevelsAreThrottled(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	// 100 frames 10 ms apart: one second, so at most 20 levels.
	for range 100 {
		h.store.Audio(id, make([]byte, 320), 0.5)
		h.clock.Advance(10 * time.Millisecond)
	}
	if err := h.store.Stop(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	levels := 0
	for _, ev := range h.sessionEvents(id) {
		if ev.Kind == dictation.SessionLevel {
			levels++
			if ev.RMS != 0.5 {
				t.Errorf("rms %v", ev.RMS)
			}
		}
	}
	if levels < 19 || levels > 20 {
		t.Errorf("levels = %d, want 20 for a second of audio", levels)
	}
}

func TestOneSessionAtATime(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	id, err := h.store.Start(context.Background(), "c1")
	if err != nil {
		t.Fatal(err)
	}
	if again, err := h.store.Start(context.Background(), "c1"); err != nil || again != id {
		t.Errorf("same client again: %q %v", again, err)
	}
	if _, err := h.store.Start(context.Background(), "c2"); !errors.Is(err, dictation.ErrBusy) {
		t.Errorf("another client: %v", err)
	}
	if err := h.store.Stop(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	if id2, err := h.store.Start(context.Background(), "c2"); err != nil || id2 == id {
		t.Errorf("after stop: %q %v", id2, err)
	}
}

func TestSilenceStop(t *testing.T) {
	frame := func(h *harness, id string) { h.store.Audio(id, make([]byte, 640), 0.01) }
	speak := func(text string) func(h *harness, id string) {
		return func(h *harness, id string) {
			h.launcher.Last().Speak(text)
			time.Sleep(20 * time.Millisecond) // the watcher handles the events
		}
	}
	type step struct {
		wait time.Duration // the clock moves first
		do   func(h *harness, id string)
	}
	for _, tc := range []struct {
		name  string
		steps []step
		// then the clock moves by advance.
		advance time.Duration
		ended   bool
	}{
		{"no audio yet: 30 s does not end it", nil, dictation.SilenceStop, false},
		{"no audio at all: ends at the cap", nil, dictation.FirstAudioWait, true},
		{"no audio, just under the cap", nil, dictation.FirstAudioWait - time.Second, false},
		{"30 s from the first frame", []step{{0, frame}}, dictation.SilenceStop, true},
		{"29 s from the first frame", []step{{0, frame}}, dictation.SilenceStop - time.Second, false},
		{"a slow prompt: counts from the first frame", []step{{90 * time.Second, frame}}, dictation.SilenceStop - time.Second, false},
		{"a slow prompt, then 30 s", []step{{90 * time.Second, frame}}, dictation.SilenceStop, true},
		{"later frames do not restart it", []step{{0, frame}, {20 * time.Second, frame}}, 10 * time.Second, true},
		{"speaking holds it off", []step{{0, frame}, {10 * time.Second, func(h *harness, id string) {
			h.launcher.Last().Emit(dictate.EventSpeech, dictate.SpeechEvent{Session: id, Active: true})
			time.Sleep(20 * time.Millisecond)
		}}}, 2 * dictation.FirstAudioWait, false},
		{"counts from the end of speech", []step{{0, frame}, {10 * time.Second, speak("one")}}, dictation.SilenceStop, true},
		{"just under 30 s from the end of speech", []step{{0, frame}, {10 * time.Second, speak("one")}}, dictation.SilenceStop - time.Second, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			for _, st := range tc.steps {
				h.clock.Advance(st.wait)
				st.do(h, id)
			}
			h.clock.Advance(tc.advance)
			if !tc.ended {
				time.Sleep(20 * time.Millisecond)
				h.waitState(dictation.Listening)
				return
			}
			got := phrasesAndEnd(h.sessionEvents(id))
			if got[len(got)-1] != "ended:silence" {
				t.Errorf("events %v", got)
			}
			h.waitState(dictation.Ready)
		})
	}
}

func TestStartLoadsWhenUnloaded(t *testing.T) {
	gate := make(chan struct{})
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	eng.Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	h.waitState(dictation.Unloaded)
	eng.SetLoadGate(gate)
	var (
		id  string
		err error
		wg  sync.WaitGroup
	)
	wg.Go(func() { id, err = h.store.Start(context.Background(), "cli") })
	h.waitState(dictation.Loading)
	close(gate)
	wg.Wait()
	if err != nil {
		t.Fatal(err)
	}
	if s := h.waitState(dictation.Listening); s.Session.ID != id {
		t.Errorf("session %+v", s.Session)
	}
}

func TestStartRefusals(t *testing.T) {
	for _, tc := range []struct {
		name           string
		enabled, model bool
		want           error
	}{
		{"off", false, true, dictation.ErrDisabled},
		{"no model", true, false, dictation.ErrNoModel},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: tc.enabled, model: tc.model})
			if _, err := h.store.Start(context.Background(), "c1"); !errors.Is(err, tc.want) {
				t.Errorf("Start = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestMicDenied(t *testing.T) {
	h := newHarness(t, setup{})
	h.store.MicDenied(true)
	if !h.store.Snapshot().MicDenied {
		t.Error("not recorded")
	}
	h.store.MicDenied(false)
	if h.store.Snapshot().MicDenied {
		t.Error("not cleared")
	}
}

func TestHostReports(t *testing.T) {
	h := newHarness(t, setup{})
	if s := h.store.Snapshot(); s.Accessibility != nil || s.ComposerTarget {
		t.Fatalf("before any report: %+v", s)
	}
	want := dictation.Accessibility{ListName: "Accessibility", Executable: "/x"}
	h.store.ReportAccessibility(want)
	if got := h.store.Snapshot().Accessibility; got == nil || *got != want {
		t.Errorf("accessibility %+v", got)
	}
	// A new value must publish, not only a first one.
	want.Granted = true
	h.store.ReportAccessibility(want)
	if got := h.store.Snapshot().Accessibility; got == nil || !got.Granted {
		t.Errorf("accessibility %+v", got)
	}
	h.store.ComposerTarget(true)
	if !h.store.Snapshot().ComposerTarget {
		t.Error("composer target not recorded")
	}
	h.store.ComposerTarget(false)
	if h.store.Snapshot().ComposerTarget {
		t.Error("composer target not cleared")
	}
}

func TestRemoveModel(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	if err := os.WriteFile(filepath.Join(h.dir, testModel.Name+".part"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := h.store.RemoveModel()
	if err != nil {
		t.Fatal(err)
	}
	if s.State != dictation.NoModel || s.Model.Downloaded || !s.Enabled {
		t.Errorf("snapshot %+v", s)
	}
	if !eng.Exited() {
		t.Error("engine still running")
	}
	entries, _ := os.ReadDir(h.dir)
	if len(entries) != 0 {
		t.Errorf("left %v", entries)
	}
}
