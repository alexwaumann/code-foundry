package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// "Other audio: Lower" (docs/notes/dictation-other-audio.md): while a hold lasts, the default
// output ramps down to duckFactor of its volume and back. The ramp is Hex's output_ducking.rs
// (MIT, see frontend/public/HEX-LICENSE.md). It runs on the ducker's one goroutine, so nothing
// the hold does ever waits for it.
//
// The volume must never stay low. A marker on disk says what to put back from before the first
// write until the volume is back, so a crash or a kill is put right at the next launch.

const (
	// duckFactor is the share of its volume the output keeps while lowered.
	duckFactor = 0.2
	// duckTick is how often a ramp writes.
	duckTick = 16 * time.Millisecond
	// duckEpsilon is how far apart two volumes can be and count as the same.
	duckEpsilon = 0.002
	// duckRampTime is how long a ramp takes. duckSettleTime bounds the wait for the hardware
	// to report what was asked for: Bluetooth may acknowledge a channel late.
	duckRampTime   = time.Second
	duckSettleTime = 1500 * time.Millisecond
	// duckLongest ends a lowering whose release never came, as a lost release only heals at
	// the next modifier key.
	duckLongest = 10 * time.Minute
	// duckQuitWait bounds what quitting waits for. What it does not finish, the next launch does.
	duckQuitWait = 500 * time.Millisecond
	// duckMaxChannels bounds what a device can claim.
	duckMaxChannels = 256
)

// audioOutput is a set of volumes lowered and restored together: a device's channels, or its
// master volume.
type audioOutput interface {
	// read is the volumes now, each 0 to 1; false when they cannot be read.
	read() ([]float32, bool)
	// write sets them all; false when any failed.
	write(values []float32) bool
}

// audioHardware finds outputs (coreAudio; a fake in tests).
type audioHardware interface {
	// defaultOutput opens the default output; false when there is none it can lower.
	defaultOutput() (uid string, elements []uint32, out audioOutput, ok bool)
	// output opens a device's elements again; false when it is not connected.
	output(uid string, elements []uint32) (audioOutput, bool)
}

// volumeElements is which of a device's volumes to lower: its channels when each can be read
// and set, else its master. A master write would destroy a balance that can be read but not
// restored channel by channel, so then none. Nil means leave the device alone.
func volumeElements(channels uint32, settable, readable func(element uint32) bool) []uint32 {
	if channels > duckMaxChannels {
		return nil
	}
	elements := make([]uint32, 0, channels)
	for e := uint32(1); e <= channels; e++ {
		elements = append(elements, e)
	}
	if len(elements) > 0 && all(elements, settable) && all(elements, readable) {
		return elements
	}
	if slices.ContainsFunc(elements, readable) {
		return nil
	}
	if settable(0) && readable(0) {
		return []uint32{0}
	}
	return nil
}

func all(elements []uint32, f func(uint32) bool) bool {
	return !slices.ContainsFunc(elements, func(e uint32) bool { return !f(e) })
}

func sameVolumes(a, b []float32) bool {
	return slices.EqualFunc(a, b, func(x, y float32) bool { return math.Abs(float64(x-y)) < duckEpsilon })
}

func scaled(values []float32, factor float32) []float32 {
	out := make([]float32, len(values))
	for i, v := range values {
		out[i] = v * factor
	}
	return out
}

// duckRamp moves an output between its volumes and a share of them. Scaling each channel by
// the same factor keeps the balance.
type duckRamp struct {
	out      audioOutput
	original []float32
	accepted []float32 // what the hardware last reported
	from     []float32
	target   []float32
	// restoring: on the way back. settled: at the target. finished: nothing more to do.
	restoring, settled, finished bool
	// lost: finished without knowing the volume is back, so the marker must stay.
	lost bool
}

// newDuckRamp reads out as it is now; false when it cannot.
func newDuckRamp(out audioOutput) (*duckRamp, bool) {
	v, ok := out.read()
	if !ok || len(v) == 0 {
		return nil, false
	}
	return &duckRamp{out: out, original: v, accepted: slices.Clone(v), from: slices.Clone(v), target: slices.Clone(v)}, true
}

// changedByHand reports whether someone moved a settled volume, and ends the ramp if so: their
// volume stands. A volume that cannot be read says nothing, and is lost.
func (r *duckRamp) changedByHand() bool {
	if !r.settled {
		return false
	}
	v, ok := r.out.read()
	if ok && sameVolumes(v, r.accepted) {
		return false
	}
	r.finished, r.lost = true, !ok
	return true
}

func (r *duckRamp) retarget(factor float32, restoring bool) {
	if r.finished || r.changedByHand() {
		return
	}
	if v, ok := r.out.read(); ok {
		r.from = v
	} else {
		r.from = slices.Clone(r.accepted)
	}
	r.target = scaled(r.original, factor)
	r.restoring, r.settled = restoring, false
}

// tick moves to where the ramp should be `elapsed` after it began.
func (r *duckRamp) tick(elapsed time.Duration) {
	if r.finished || r.settled {
		return
	}
	t := min(max(float32(elapsed)/float32(duckRampTime), 0), 1)
	eased := t * t * (3 - 2*t)
	values := make([]float32, len(r.from))
	for i := range values {
		values[i] = r.from[i] + (r.target[i]-r.from[i])*eased
	}
	if !r.out.write(values) {
		r.rollback()
		return
	}
	actual, ok := r.out.read()
	if !ok {
		r.rollback()
		return
	}
	r.accepted = actual
	if t >= 1 && (sameVolumes(actual, r.target) || elapsed >= duckSettleTime) {
		r.settled = true
		r.finished = r.restoring
	}
}

// rollback puts every channel back after a write that failed on some of them.
func (r *duckRamp) rollback() {
	r.finished = true
	r.lost = !r.out.write(r.original)
}

// restoreNow puts the volume back in one write, for quitting.
func (r *duckRamp) restoreNow() {
	if r.finished || r.changedByHand() {
		return
	}
	r.rollback()
}

// duckMarker says what to put back on a device. Lowered is where the volume rests once
// Settled; before that a ramp is moving and the volume can be anywhere between the two.
type duckMarker struct {
	UID      string    `json:"uid"`
	Elements []uint32  `json:"elements"`
	Original []float32 `json:"original"`
	Lowered  []float32 `json:"lowered"`
	Settled  bool      `json:"settled"`
	// Partial: a write back failed, and may have moved some channels and not others.
	Partial bool `json:"partial,omitempty"`
}

// duckVerdict is what to do with a marker left behind.
type duckVerdict int

const (
	duckKeep    duckVerdict = iota // say nothing yet: the device is not here
	duckForget                     // nothing to put back
	duckRestore                    // the volume is still ours: put it back
)

// decideRecovery reads a marker left by a process that did not finish. found is whether the
// device answered, with current its volumes.
//
// A volume that has moved was moved by hand, and stands. Settled, ours is exactly where it
// was left. Unsettled, a ramp was moving when the process died, so any point on the way
// counts, with the channels in step; that window lasts about a second. After a failed write
// back the channels need not be in step.
func decideRecovery(m duckMarker, current []float32, found bool) duckVerdict {
	switch {
	case !found:
		return duckKeep
	case len(m.Original) == 0 || len(current) != len(m.Original) || len(m.Lowered) != len(m.Original):
		return duckForget
	case sameVolumes(current, m.Original):
		return duckForget
	case m.Settled && sameVolumes(current, m.Lowered):
		return duckRestore
	case !m.Settled && onTheWay(m, current):
		return duckRestore
	}
	return duckForget
}

// onTheWay reports whether every channel of current is between Lowered and Original, and, unless
// the marker is Partial, at one point between them.
func onTheWay(m duckMarker, current []float32) bool {
	point := float32(-1)
	for i, v := range current {
		lo, hi := m.Lowered[i], m.Original[i]
		if hi-lo < duckEpsilon {
			if math.Abs(float64(v-hi)) >= duckEpsilon {
				return false
			}
			continue
		}
		p := (v - lo) / (hi - lo)
		if p < -duckEpsilon || p > 1+duckEpsilon {
			return false
		}
		if !m.Partial && point >= 0 && math.Abs(float64(p-point)) >= 2*duckEpsilon/float64(hi-lo) {
			return false
		}
		point = p
	}
	return true
}

// duckMarkers keeps one marker per device in dir. A device left low stays on record until it
// comes back, while another device can still be lowered.
type duckMarkers struct{ dir string }

func (s duckMarkers) path(uid string) string {
	sum := sha256.Sum256([]byte(uid))
	return filepath.Join(s.dir, hex.EncodeToString(sum[:8])+".json")
}

func (s duckMarkers) save(m duckMarker) error {
	b, err := json.Marshal(m)
	if err != nil {
		return fmt.Errorf("lowered audio marker: %w", err)
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return fmt.Errorf("lowered audio marker: %w", err)
	}
	return writeFileAtomic(s.path(m.UID), b)
}

func (s duckMarkers) remove(uid string) error {
	if err := os.Remove(s.path(uid)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("lowered audio marker: %w", err)
	}
	return nil
}

// list is every marker on disk. One that cannot be read is dropped: it can only be a write cut
// short before anything was lowered, or something that is not ours.
func (s duckMarkers) list(log *slog.Logger) []duckMarker {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	var out []duckMarker
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		path := filepath.Join(s.dir, e.Name())
		b, err := os.ReadFile(path)
		var m duckMarker
		if err == nil {
			err = json.Unmarshal(b, &m)
		}
		if err != nil || m.UID == "" {
			log.Warn("dictation: dropping a lowered audio marker", "file", e.Name(), "err", err)
			_ = os.Remove(path)
			continue
		}
		out = append(out, m)
	}
	return out
}

// duckArm is a hold on its way to lowering the audio.
type duckArm struct {
	after    time.Duration
	released <-chan struct{}
}

// ducker lowers the default output for holds. loop owns everything below the channels; the
// methods it calls are the state machine, driven directly by tests.
type ducker struct {
	hw      audioHardware
	markers duckMarkers
	log     *slog.Logger

	arms chan duckArm
	quit chan struct{}
	done chan struct{}
	once sync.Once

	ramp    *duckRamp
	marker  duckMarker
	started time.Time
}

// newDucker returns a ducker keeping its markers in dir; start runs it.
func newDucker(hw audioHardware, dir string, log *slog.Logger) *ducker {
	return &ducker{
		hw: hw, markers: duckMarkers{dir: dir}, log: log,
		arms: make(chan duckArm, 1), quit: make(chan struct{}), done: make(chan struct{}),
	}
}

// start runs the ducker, which first puts back what an earlier run left low, whatever the
// setting says now. Call it where no other process of this home can be lowering: a second
// launch must have ended first.
func (d *ducker) start() { go d.loop() }

// lower lowers the output once `after` has passed, until released closes. It returns at once.
func (d *ducker) lower(after time.Duration, released <-chan struct{}) {
	select {
	case d.arms <- duckArm{after: after, released: released}:
	default:
		d.log.Warn("dictation: the audio ducker is busy; leaving the audio as it is")
	}
}

// close puts the volume back now and stops, for quitting. Safe to call more than once.
func (d *ducker) close() {
	d.once.Do(func() { close(d.quit) })
	select {
	case <-d.done:
	case <-time.After(duckQuitWait):
		d.log.Warn("dictation: quitting before the audio was back; the next launch will finish it")
	}
}

func (d *ducker) loop() {
	defer close(d.done)
	d.recoverStale()
	var (
		reach, longest <-chan time.Time
		released       <-chan struct{}
	)
	for {
		var tick <-chan time.Time
		if d.ramp != nil && !d.ramp.settled {
			tick = time.After(duckTick)
		}
		select {
		case <-d.quit:
			d.quitNow()
			return
		case a := <-d.arms:
			reach, released, longest = time.After(a.after), a.released, nil
		case <-reach:
			reach = nil
			select {
			case <-released: // the next turn lets go
			default:
				d.reached(time.Now())
				longest = time.After(duckLongest)
			}
		case <-released:
			reach, released, longest = nil, nil, nil
			d.released(time.Now())
		case <-longest:
			d.log.Warn("dictation: no release after a long hold; the audio goes back")
			reach, released, longest = nil, nil, nil
			d.released(time.Now())
		case <-tick:
			d.step(time.Now())
		}
	}
}

// recoverStale puts back what a process that died left low.
func (d *ducker) recoverStale() {
	for _, m := range d.markers.list(d.log) {
		out, found := d.hw.output(m.UID, m.Elements)
		var current []float32
		if found {
			current, found = out.read()
		}
		verdict := decideRecovery(m, current, found)
		if verdict == duckKeep {
			continue
		}
		if verdict == duckRestore {
			if !out.write(m.Original) {
				d.log.Warn("dictation: could not put the audio back; trying again later")
				m.Settled, m.Partial = false, true
				if err := d.markers.save(m); err != nil {
					d.log.Warn("dictation: update the lowered audio marker", "err", err)
				}
				continue
			}
			d.log.Info("dictation: put back a volume an earlier run left lowered")
		}
		d.forget(m.UID)
	}
}

func (d *ducker) forget(uid string) {
	if err := d.markers.remove(uid); err != nil {
		d.log.Warn("dictation: remove the lowered audio marker", "err", err)
	}
}

// reached: a hold has lasted long enough. A ramp still on its way back turns around, keeping
// the volume it started from. Without a marker on disk nothing is lowered.
func (d *ducker) reached(now time.Time) {
	if d.ramp == nil {
		d.recoverStale()
		uid, elements, out, ok := d.hw.defaultOutput()
		if !ok {
			d.log.Debug("dictation: no output volume to lower")
			return
		}
		ramp, ok := newDuckRamp(out)
		if !ok {
			d.log.Debug("dictation: cannot read the output's volume")
			return
		}
		m := duckMarker{UID: uid, Elements: elements, Original: ramp.original, Lowered: scaled(ramp.original, duckFactor)}
		if err := d.markers.save(m); err != nil {
			d.log.Warn("dictation: leaving the audio as it is", "err", err)
			return
		}
		d.ramp, d.marker = ramp, m
	}
	d.ramp.retarget(duckFactor, false)
	d.started = now
	d.settle()
}

// released: the hold is over.
func (d *ducker) released(now time.Time) {
	if d.ramp == nil {
		return
	}
	d.ramp.retarget(1, true)
	d.started = now
	if !d.ramp.finished && d.marker.Settled {
		// Before the first write: from here the volume is not where the marker says.
		d.marker.Settled = false
		d.saveMarker()
	}
	d.settle()
}

// step moves the ramp on.
func (d *ducker) step(now time.Time) {
	if d.ramp == nil {
		return
	}
	d.ramp.tick(now.Sub(d.started))
	d.settle()
}

// quitNow puts the volume back without a ramp.
func (d *ducker) quitNow() {
	if d.ramp == nil {
		return
	}
	d.ramp.restoreNow()
	d.settle()
}

// settle keeps the marker in step with the ramp.
func (d *ducker) settle() {
	r := d.ramp
	switch {
	case r.finished:
		d.ramp = nil
		if r.lost {
			d.log.Warn("dictation: lost the output while it was lowered; the next hold or launch tries again")
			d.marker.Settled, d.marker.Partial = false, true
			d.saveMarker()
			return
		}
		d.forget(d.marker.UID)
	case r.settled && !d.marker.Settled:
		d.marker.Settled, d.marker.Lowered = true, slices.Clone(r.accepted)
		d.saveMarker()
	}
}

func (d *ducker) saveMarker() {
	if err := d.markers.save(d.marker); err != nil {
		d.log.Warn("dictation: update the lowered audio marker", "err", err)
	}
}
