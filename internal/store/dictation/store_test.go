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
	return dictation.Model{Name: "test.bin", Title: "Test", URL: "http://invalid/test.bin", Size: int64(len(body)), SHA256: hex.EncodeToString(sum[:])}
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
	attended atomic.Bool
	enables  atomic.Int32
	sessions *bus.Subscription[dictation.SessionEvent]
}

type setup struct {
	enabled, model, attended bool
	launcher                 *dictationtest.Launcher
	opts                     func(*dictation.Options)
}

func newHarness(t *testing.T, s setup) *harness {
	t.Helper()
	h := &harness{t: t, bus: bus.New(), clock: dictationtest.NewClock(time.Unix(1_000_000, 0)), launcher: s.launcher, dir: t.TempDir()}
	if h.launcher == nil {
		h.launcher = &dictationtest.Launcher{}
	}
	h.enabled.Store(s.enabled)
	h.attended.Store(s.attended)
	if s.model {
		if err := os.WriteFile(filepath.Join(h.dir, testModel.Name), modelBody(), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	h.sessions = bus.Subscribe[dictation.SessionEvent](h.bus, 1024)
	opts := dictation.Options{
		Dir: h.dir, Bus: h.bus, Model: testModel, Clock: h.clock, Launch: h.launcher.Launch,
		Enabled:  h.enabled.Load,
		Attended: h.attended.Load,
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
			h := newHarness(t, setup{enabled: tc.enabled, model: tc.model, attended: true})
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
	h := newHarness(t, setup{model: true, attended: true})
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

func TestPresenceUnload(t *testing.T) {
	for _, tc := range []struct {
		name     string
		attended bool
		want     dictation.State
	}{
		{"attended stays loaded", true, dictation.Ready},
		{"away unloads", false, dictation.Unloaded},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true, attended: tc.attended})
			h.waitState(dictation.Ready)
			h.clock.Advance(dictation.UnloadAfter - time.Second)
			h.waitState(dictation.Ready)
			h.clock.Advance(time.Second)
			h.waitState(tc.want)
			away := tc.want == dictation.Unloaded
			// Away stops the engine (freeing more than an unload in it would).
			if eng := h.launcher.Last(); eng.Exited() != away {
				t.Errorf("engine exited = %v", eng.Exited())
			}
			// Back: running and loaded again.
			h.attended.Store(true)
			h.store.AttendedChanged(true)
			h.waitState(dictation.Ready)
			want := 1
			if away {
				want = 2
			}
			if !h.launcher.Last().Loaded() || h.launcher.Count() != want {
				t.Errorf("launches %d, want %d", h.launcher.Count(), want)
			}
		})
	}
}

func TestPresenceFlapDoesNotUnloadEarly(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
	h.waitState(dictation.Ready)
	h.store.AttendedChanged(false)
	h.clock.Advance(5 * time.Minute)
	h.store.AttendedChanged(true)
	h.store.AttendedChanged(false)
	h.clock.Advance(9 * time.Minute) // 14 min since the first, 9 since the last
	h.waitState(dictation.Ready)
	h.clock.Advance(time.Minute)
	h.waitState(dictation.Unloaded)
}

func TestIdleUnloadWaitsForSession(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true})
	h.waitState(dictation.Ready)
	id, err := h.store.Start(context.Background(), "cli")
	if err != nil {
		t.Fatal(err)
	}
	eng := h.launcher.Last()
	// Keep it talking past the unload deadline: speech holds the silence stop off.
	eng.Emit(dictate.EventSpeech, dictate.SpeechEvent{Session: id, Active: true})
	h.wait("speech handled", func(dictation.Snapshot) bool { return true })
	time.Sleep(20 * time.Millisecond)
	h.clock.Advance(dictation.UnloadAfter)
	if s := h.waitState(dictation.Listening); s.Session == nil || s.Session.ID != id {
		t.Fatalf("session %+v", s.Session)
	}
	if eng.Exited() {
		t.Fatal("stopped under an open session")
	}
	if err := h.store.Stop(context.Background(), id, false); err != nil {
		t.Fatal(err)
	}
	h.waitState(dictation.Unloaded)
	h.wait("engine exit", func(dictation.Snapshot) bool { return eng.Exited() })
}

func TestPressureUnloadReloadsOnStart(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
	h.waitState(dictation.Ready)
	eng := h.launcher.Last()
	eng.Emit(dictate.EventUnloaded, dictate.UnloadedEvent{Reason: "memory-pressure"})
	h.waitState(dictation.Unloaded)
	// Presence does not bring it back; the next use does.
	h.store.AttendedChanged(true)
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

func TestPressureUnloadEndsSession(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
	h := newHarness(t, setup{enabled: true, model: true, attended: true, launcher: l})
	s := h.waitState(dictation.Failed)
	if s.Error == "" || h.clock.Pending() != 0 {
		t.Errorf("snapshot %+v, pending timers %d", s, h.clock.Pending())
	}
}

func TestSessionPhrasesAndFlush(t *testing.T) {
	for _, tc := range []struct {
		name  string
		flush bool
		want  []string
	}{
		{"flush keeps the tail", true, []string{"hello there", "and the tail", "ended:stopped"}},
		{"no flush drops it", false, []string{"hello there", "ended:stopped"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
			if r, ended, ok := h.store.SessionEnded(id); !ok || !ended || r != dictation.EndStopped {
				t.Errorf("SessionEnded = %v %v %v", r, ended, ok)
			}
			// Stopping again is fine.
			if err := h.store.Stop(context.Background(), id, true); err != nil {
				t.Error(err)
			}
		})
	}
}

func TestLevelsAreThrottled(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
	for _, tc := range []struct {
		name string
		// script runs after Start; then the clock moves by advance.
		script  func(e *dictationtest.Engine, id string)
		advance time.Duration
		ended   bool
	}{
		{"30 s of nothing", nil, dictation.SilenceStop, true},
		{"29 s of nothing", nil, dictation.SilenceStop - time.Second, false},
		{"speaking holds it off", func(e *dictationtest.Engine, id string) {
			e.Emit(dictate.EventSpeech, dictate.SpeechEvent{Session: id, Active: true})
		}, 2 * dictation.SilenceStop, false},
		{"counts from the end of speech", func(e *dictationtest.Engine, id string) {
			e.Speak("one")
		}, dictation.SilenceStop, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, setup{enabled: true, model: true, attended: true})
			h.waitState(dictation.Ready)
			id, err := h.store.Start(context.Background(), "c1")
			if err != nil {
				t.Fatal(err)
			}
			if tc.script != nil {
				h.clock.Advance(10 * time.Second)
				tc.script(h.launcher.Last(), id)
				time.Sleep(20 * time.Millisecond) // the watcher handles the events
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
	h.clock.Advance(dictation.UnloadAfter)
	h.waitState(dictation.Unloaded)
	h.launcher.SetSetup(func(e *dictationtest.Engine) { e.SetLoadGate(gate) })
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
			h := newHarness(t, setup{enabled: tc.enabled, model: tc.model, attended: true})
			if _, err := h.store.Start(context.Background(), "c1"); !errors.Is(err, tc.want) {
				t.Errorf("Start = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestMicDenied(t *testing.T) {
	h := newHarness(t, setup{attended: true})
	h.store.MicDenied(true)
	if !h.store.Snapshot().MicDenied {
		t.Error("not recorded")
	}
	h.store.MicDenied(false)
	if h.store.Snapshot().MicDenied {
		t.Error("not cleared")
	}
}

func TestRemoveModel(t *testing.T) {
	h := newHarness(t, setup{enabled: true, model: true, attended: true})
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
