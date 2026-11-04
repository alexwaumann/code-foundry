package main

import (
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"
)

// fakeOutput is a device's volumes. failWrites fails that many writes after changing the first
// channel, as a device that took one channel and refused the next.
type fakeOutput struct {
	mu         sync.Mutex
	values     []float32
	writes     int
	failWrites int
	gone       bool
}

func (o *fakeOutput) read() ([]float32, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.gone {
		return nil, false
	}
	return slices.Clone(o.values), true
}

func (o *fakeOutput) write(v []float32) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.writes++
	if o.gone {
		return false
	}
	if o.failWrites > 0 {
		o.failWrites--
		o.values[0] = v[0]
		return false
	}
	o.values = slices.Clone(v)
	return true
}

func (o *fakeOutput) set(v ...float32) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.values = v
}

func (o *fakeOutput) now() []float32 {
	o.mu.Lock()
	defer o.mu.Unlock()
	return slices.Clone(o.values)
}

func wantVolumes(t *testing.T, got []float32, want ...float32) {
	t.Helper()
	if !sameVolumes(got, want) {
		t.Fatalf("volumes %v, want %v", got, want)
	}
}

func TestDuckRampPreservesBalanceAndRestores(t *testing.T) {
	for _, original := range [][]float32{{0.3, 0.8}, {0, 0.8}, {0.5}} {
		for _, factor := range []float32{0, 0.2, 1} {
			out := &fakeOutput{values: slices.Clone(original)}
			r, ok := newDuckRamp(out)
			if !ok {
				t.Fatal("no ramp")
			}
			r.retarget(factor, false)
			r.tick(duckRampTime / 2)
			wantVolumes(t, out.now(), scaled(original, (1+factor)/2)...)
			r.tick(duckRampTime)
			wantVolumes(t, out.now(), scaled(original, factor)...)
			r.retarget(1, true)
			r.tick(duckRampTime)
			wantVolumes(t, out.now(), original...)
			if !r.finished || r.lost {
				t.Errorf("finished %v lost %v", r.finished, r.lost)
			}
		}
	}
}

func TestDuckRampRespectsAHandAndFinishesInterruptedRamps(t *testing.T) {
	out := &fakeOutput{values: []float32{0.3, 0.8}}
	r, _ := newDuckRamp(out)
	r.retarget(0.2, false)
	r.tick(duckRampTime)
	out.set(0.5, 0.5)
	r.retarget(1, true)
	r.tick(duckRampTime)
	wantVolumes(t, out.now(), 0.5, 0.5)
	if !r.finished || r.lost {
		t.Errorf("finished %v lost %v", r.finished, r.lost)
	}

	// Released on the way down: back from wherever it had got to.
	out = &fakeOutput{values: []float32{0.3, 0.8}}
	r, _ = newDuckRamp(out)
	r.retarget(0, false)
	r.tick(duckRampTime / 10)
	r.retarget(1, true)
	r.tick(duckRampTime)
	wantVolumes(t, out.now(), 0.3, 0.8)
}

func TestDuckRampRollsBackEveryChannelOnPartialFailure(t *testing.T) {
	out := &fakeOutput{values: []float32{0.3, 0.8}, failWrites: 1}
	r, _ := newDuckRamp(out)
	r.retarget(0.2, false)
	r.tick(duckRampTime / 2)
	if !r.finished || r.lost {
		t.Errorf("finished %v lost %v", r.finished, r.lost)
	}
	wantVolumes(t, out.now(), 0.3, 0.8)

	// A rollback that fails too says so.
	out = &fakeOutput{values: []float32{0.3, 0.8}, failWrites: 2}
	r, _ = newDuckRamp(out)
	r.retarget(0.2, false)
	r.tick(duckRampTime / 2)
	if !r.finished || !r.lost {
		t.Errorf("finished %v lost %v", r.finished, r.lost)
	}
}

// A volume that reports late settles anyway, after the bound.
func TestDuckRampSettlesOnASlowDevice(t *testing.T) {
	out := &slowOutput{fakeOutput{values: []float32{0.5}}}
	r, _ := newDuckRamp(out)
	r.retarget(0.2, false)
	r.tick(duckRampTime)
	if r.settled {
		t.Fatal("settled before the device reported")
	}
	r.tick(duckSettleTime)
	if !r.settled {
		t.Fatal("not settled at the bound")
	}
}

// slowOutput ignores writes, as a device that has not caught up.
type slowOutput struct{ fakeOutput }

func (o *slowOutput) write([]float32) bool { return true }

func TestVolumeElements(t *testing.T) {
	yes := func(uint32) bool { return true }
	no := func(uint32) bool { return false }
	only := func(want ...uint32) func(uint32) bool {
		return func(e uint32) bool { return slices.Contains(want, e) }
	}
	tests := []struct {
		name               string
		channels           uint32
		settable, readable func(uint32) bool
		want               []uint32
	}{
		{"channels", 2, yes, yes, []uint32{1, 2}},
		{"master only", 2, only(0), only(0), []uint32{0}},
		{"no channels reported", 0, yes, yes, []uint32{0}},
		{"a readable balance it cannot set", 2, only(0), yes, nil},
		{"one channel cannot be set", 2, only(0, 1), yes, nil},
		{"nothing", 2, no, no, nil},
		{"master cannot be read", 2, only(0), no, nil},
		{"a device claiming too much", duckMaxChannels + 1, yes, yes, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := volumeElements(tt.channels, tt.settable, tt.readable); !slices.Equal(got, tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestDecideRecovery(t *testing.T) {
	settled := duckMarker{Original: []float32{0.5, 1}, Lowered: []float32{0.1, 0.2}, Settled: true}
	moving := duckMarker{Original: []float32{0.5, 1}, Lowered: []float32{0.1, 0.2}}
	tests := []struct {
		name    string
		m       duckMarker
		current []float32
		found   bool
		want    duckVerdict
	}{
		{"the device is not here", settled, nil, false, duckKeep},
		{"left lowered", settled, []float32{0.1, 0.2}, true, duckRestore},
		{"moved by hand since", settled, []float32{0.4, 0.4}, true, duckForget},
		{"turned up in step", settled, []float32{0.3, 0.6}, true, duckForget},
		{"already back", settled, []float32{0.5, 1}, true, duckForget},
		{"died at the start of a ramp", moving, []float32{0.5, 1}, true, duckForget},
		{"died on a ramp", moving, []float32{0.3, 0.6}, true, duckRestore},
		{"died at the bottom of a ramp", moving, []float32{0.1, 0.2}, true, duckRestore},
		{"below the ramp", moving, []float32{0.05, 0.1}, true, duckForget},
		{"above the ramp", moving, []float32{0.6, 1}, true, duckForget},
		{"out of step", moving, []float32{0.45, 0.25}, true, duckForget},
		{"a silent channel on a ramp", duckMarker{Original: []float32{0, 1}, Lowered: []float32{0, 0.2}}, []float32{0, 0.6}, true, duckRestore},
		{"a silent channel raised", duckMarker{Original: []float32{0, 1}, Lowered: []float32{0, 0.2}}, []float32{0.3, 0.6}, true, duckForget},
		{"a write back half done", duckMarker{Original: []float32{0.5, 1}, Lowered: []float32{0.1, 0.2}, Partial: true}, []float32{0.5, 0.2}, true, duckRestore},
		{"a write back half done, then raised", duckMarker{Original: []float32{0.5, 1}, Lowered: []float32{0.1, 0.2}, Partial: true}, []float32{0.8, 0.2}, true, duckForget},
		{"channels changed", settled, []float32{0.1}, true, duckForget},
		{"an empty marker", duckMarker{}, nil, true, duckForget},
		{"a short marker", duckMarker{Original: []float32{0.5, 1}, Lowered: []float32{0.1}}, []float32{0.1, 0.2}, true, duckForget},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := decideRecovery(tt.m, tt.current, tt.found); got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

// fakeAudio is the Mac's outputs by UID, one of them the default.
type fakeAudio struct {
	outs map[string]*fakeOutput
	def  string
}

func (a *fakeAudio) defaultOutput() (string, []uint32, audioOutput, bool) {
	o, ok := a.outs[a.def]
	if !ok {
		return "", nil, nil, false
	}
	return a.def, []uint32{1, 2}, o, true
}

func (a *fakeAudio) output(uid string, _ []uint32) (audioOutput, bool) {
	o, ok := a.outs[uid]
	return o, ok
}

type duckRig struct {
	d   *ducker
	hw  *fakeAudio
	out *fakeOutput
	at  time.Time
}

func newDuckRig(t *testing.T) *duckRig {
	t.Helper()
	out := &fakeOutput{values: []float32{0.5, 1}}
	hw := &fakeAudio{outs: map[string]*fakeOutput{"speakers": out}, def: "speakers"}
	return &duckRig{d: newDucker(hw, t.TempDir(), slog.New(slog.DiscardHandler)), hw: hw, out: out, at: time.Unix(1000, 0)}
}

// run ticks the ramp through its whole length.
func (r *duckRig) run() {
	r.at = r.at.Add(duckRampTime)
	r.d.step(r.at)
}

func (r *duckRig) reach()   { r.d.reached(r.at) }
func (r *duckRig) release() { r.d.released(r.at) }

// markers reads what the disk says, as the next launch would.
func (r *duckRig) markers() []duckMarker { return r.d.markers.list(r.d.log) }

// relaunch is a new process on the same home, the old one gone without a word.
func (r *duckRig) relaunch() {
	r.d = newDucker(r.hw, r.d.markers.dir, r.d.log)
	r.d.recoverStale()
}

func TestDuckerLowersAndRestores(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	m := r.markers()
	if len(m) != 1 || m[0].Settled || m[0].UID != "speakers" {
		t.Fatalf("no marker before the first write: %+v", m)
	}
	if r.out.writes != 0 {
		t.Fatalf("%d writes before the first tick", r.out.writes)
	}
	r.run()
	wantVolumes(t, r.out.now(), 0.1, 0.2)
	if m := r.markers(); len(m) != 1 || !m[0].Settled {
		t.Fatalf("marker after settling: %+v", m)
	}
	r.release()
	if m := r.markers(); len(m) != 1 || m[0].Settled {
		t.Fatalf("marker must be unsettled before the way back: %+v", m)
	}
	r.run()
	wantVolumes(t, r.out.now(), 0.5, 1)
	if m := r.markers(); len(m) != 0 {
		t.Fatalf("marker after restoring: %+v", m)
	}
}

func TestDuckerRespectsAHandDuringAHold(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	r.run()
	r.out.set(0.7, 0.7)
	r.release()
	r.run()
	wantVolumes(t, r.out.now(), 0.7, 0.7)
	if m := r.markers(); len(m) != 0 {
		t.Fatalf("marker left: %+v", m)
	}
}

// A hold on the heels of the last one turns the ramp around, and the volume it goes back to in
// the end is the first one, not a point on the way.
func TestDuckerTurnsARampAround(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	r.run()
	r.release()
	r.at = r.at.Add(duckRampTime / 2)
	r.d.step(r.at)
	r.reach()
	r.run()
	wantVolumes(t, r.out.now(), 0.1, 0.2)
	r.release()
	r.run()
	wantVolumes(t, r.out.now(), 0.5, 1)
}

func TestDuckerQuitting(t *testing.T) {
	tests := []struct {
		name  string
		setup func(r *duckRig)
	}{
		{"settled", func(r *duckRig) { r.reach(); r.run() }},
		{"on the way down", func(r *duckRig) { r.reach(); r.at = r.at.Add(duckRampTime / 2); r.d.step(r.at) }},
		{"on the way back", func(r *duckRig) {
			r.reach()
			r.run()
			r.release()
			r.at = r.at.Add(duckRampTime / 2)
			r.d.step(r.at)
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newDuckRig(t)
			tt.setup(r)
			r.d.quitNow()
			wantVolumes(t, r.out.now(), 0.5, 1)
			if m := r.markers(); len(m) != 0 {
				t.Fatalf("marker left: %+v", m)
			}
		})
	}
	t.Run("a hand stands", func(t *testing.T) {
		r := newDuckRig(t)
		r.reach()
		r.run()
		r.out.set(0.7, 0.7)
		r.d.quitNow()
		wantVolumes(t, r.out.now(), 0.7, 0.7)
	})
}

func TestDuckerRecoversACrash(t *testing.T) {
	tests := []struct {
		name  string
		setup func(r *duckRig)
		want  []float32
	}{
		{"settled low", func(r *duckRig) { r.reach(); r.run() }, []float32{0.5, 1}},
		{"on the way down", func(r *duckRig) { r.reach(); r.at = r.at.Add(duckRampTime / 2); r.d.step(r.at) }, []float32{0.5, 1}},
		{"on the way back", func(r *duckRig) {
			r.reach()
			r.run()
			r.release()
			r.at = r.at.Add(duckRampTime / 2)
			r.d.step(r.at)
		}, []float32{0.5, 1}},
		{"before the first write", func(r *duckRig) { r.reach() }, []float32{0.5, 1}},
		{"moved by hand after the crash", func(r *duckRig) { r.reach(); r.run(); r.out.set(0.3, 0.3) }, []float32{0.3, 0.3}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newDuckRig(t)
			tt.setup(r)
			r.relaunch()
			wantVolumes(t, r.out.now(), tt.want...)
			if m := r.markers(); len(m) != 0 {
				t.Fatalf("marker left: %+v", m)
			}
		})
	}
}

// A device that is away waits for its return, and another can be lowered meanwhile. Lowering
// must not take a volume left low for the one to go back to.
func TestDuckerKeepsAnAbsentDevice(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	r.run()
	speakers := r.out
	delete(r.hw.outs, "speakers")
	r.relaunch()
	if m := r.markers(); len(m) != 1 {
		t.Fatalf("marker gone with the device: %+v", m)
	}

	other := &fakeOutput{values: []float32{1, 1}}
	r.hw.outs["headphones"], r.hw.def = other, "headphones"
	r.reach()
	r.run()
	wantVolumes(t, other.now(), 0.2, 0.2)
	if m := r.markers(); len(m) != 2 {
		t.Fatalf("markers: %+v", m)
	}
	r.release()
	r.run()
	wantVolumes(t, other.now(), 1, 1)

	r.hw.outs["speakers"], r.hw.def = speakers, "speakers"
	r.reach()
	wantVolumes(t, speakers.now(), 0.5, 1)
	if m := r.markers(); len(m) != 1 || !sameVolumes(m[0].Original, []float32{0.5, 1}) {
		t.Fatalf("the hold after it must start from the true volume: %+v", m)
	}
}

// The device goes in the middle of a hold: the marker stays for when it is back.
func TestDuckerLosesTheDeviceMidHold(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	r.run()
	r.out.gone = true
	r.release()
	r.run()
	if r.d.ramp != nil {
		t.Fatal("still ramping a device that is gone")
	}
	if m := r.markers(); len(m) != 1 {
		t.Fatalf("marker gone with the device: %+v", m)
	}
	r.out.gone = false
	r.relaunch()
	wantVolumes(t, r.out.now(), 0.5, 1)
}

func TestDuckerRecoveryWriteFails(t *testing.T) {
	r := newDuckRig(t)
	r.reach()
	r.run()
	r.out.failWrites = 1
	r.relaunch()
	if m := r.markers(); len(m) != 1 {
		t.Fatalf("marker dropped by a failed write: %+v", m)
	}
	r.relaunch()
	wantVolumes(t, r.out.now(), 0.5, 1)
}

// Nothing is lowered that the disk could not bring back.
func TestDuckerNeedsItsMarker(t *testing.T) {
	r := newDuckRig(t)
	file := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	r.d.markers.dir = filepath.Join(file, "sub")
	r.reach()
	r.run()
	if r.d.ramp != nil || r.out.writes != 0 {
		t.Fatalf("lowered with no marker: %v, %d writes", r.d.ramp, r.out.writes)
	}
}

func TestDuckerNoOutput(t *testing.T) {
	r := newDuckRig(t)
	r.hw.def = "nothing"
	r.reach()
	r.release()
	r.run()
	if len(r.markers()) != 0 {
		t.Fatal("a marker for nothing")
	}
}

func TestDuckMarkersDropWhatTheyCannotRead(t *testing.T) {
	dir := t.TempDir()
	s := duckMarkers{dir: dir}
	if err := s.save(duckMarker{UID: "a", Original: []float32{1}, Lowered: []float32{0.2}}); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"cut.json": `{"uid":`, "nouid.json": `{}`} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	got := s.list(slog.New(slog.DiscardHandler))
	if len(got) != 1 || got[0].UID != "a" {
		t.Fatalf("got %+v", got)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("left %v, %v", entries, err)
	}
	if err := s.remove("a"); err != nil {
		t.Fatal(err)
	}
	if err := s.remove("a"); err != nil {
		t.Errorf("removing twice: %v", err)
	}
	if err := (duckMarkers{dir: filepath.Join(dir, "none")}).remove("a"); errors.Is(err, os.ErrNotExist) {
		t.Errorf("no directory: %v", err)
	}
}

// The loop itself, on the real clock.
func TestDuckerLoop(t *testing.T) {
	wait := func(t *testing.T, what string, ok func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !ok() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(time.Millisecond)
		}
	}
	low := func(o *fakeOutput) func() bool {
		return func() bool { return sameVolumes(o.now(), []float32{0.1, 0.2}) }
	}
	back := func(o *fakeOutput) func() bool {
		return func() bool { return sameVolumes(o.now(), []float32{0.5, 1}) }
	}

	t.Run("a hold released before it counts leaves the volume alone", func(t *testing.T) {
		r := newDuckRig(t)
		r.d.start()
		defer r.d.close()
		released := make(chan struct{})
		r.d.lower(30*time.Millisecond, released)
		close(released)
		time.Sleep(80 * time.Millisecond)
		if r.out.writes != 0 || len(r.markers()) != 0 {
			t.Fatalf("%d writes, markers %+v", r.out.writes, r.markers())
		}
	})
	t.Run("a hold lowers, and its release restores", func(t *testing.T) {
		r := newDuckRig(t)
		r.d.start()
		defer r.d.close()
		released := make(chan struct{})
		r.d.lower(time.Millisecond, released)
		wait(t, "the volume to fall", low(r.out))
		close(released)
		wait(t, "the volume to return", back(r.out))
	})
	t.Run("quitting restores at once and is safe twice", func(t *testing.T) {
		r := newDuckRig(t)
		r.d.start()
		released := make(chan struct{})
		r.d.lower(time.Millisecond, released)
		wait(t, "the volume to fall", low(r.out))
		r.d.close()
		wantVolumes(t, r.out.now(), 0.5, 1)
		r.d.close()
	})
	t.Run("starting puts back what a crash left", func(t *testing.T) {
		r := newDuckRig(t)
		r.reach()
		r.run()
		r.d = newDucker(r.hw, r.d.markers.dir, r.d.log)
		r.d.start()
		defer r.d.close()
		wait(t, "the volume to return", back(r.out))
	})
}
