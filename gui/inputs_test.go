package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/dictate"
)

func TestInputTransport(t *testing.T) {
	tests := []struct {
		name   string
		kind   uint32
		uid    string
		source uint32
		want   dictate.Transport
	}{
		{"the internal microphone", transportBuiltIn, "BuiltInMicrophoneDevice", 0, dictate.TransportBuiltIn},
		{"an older Mac's internal source", transportBuiltIn, "AppleHDAEngineInput:1B,0,1,0:1", 'i'<<24 | 'm'<<16 | 'i'<<8 | 'c', dictate.TransportBuiltIn},
		{"the jack on Apple silicon", transportBuiltIn, "BuiltInHeadphoneInputDevice", 0, dictate.TransportOther},
		{"an older Mac's jack", transportBuiltIn, "AppleHDAEngineInput:1B,0,1,0:1", sourceExternalMic, dictate.TransportOther},
		{"an older Mac's line in", transportBuiltIn, "AppleHDAEngineInput:1B,0,1,0:1", sourceLineIn, dictate.TransportOther},
		{"Bluetooth", transportBluetooth, "x", 0, dictate.TransportBluetooth},
		{"Bluetooth LE", transportBluetoothLE, "x", 0, dictate.TransportBluetooth},
		{"USB", transportUSB, "x", 0, dictate.TransportUSB},
		{"virtual", transportVirtual, "x", 0, dictate.TransportVirtual},
		{"aggregate", transportAggregate, "x", 0, dictate.TransportVirtual},
		{"auto aggregate", transportAutoAggregate, "x", 0, dictate.TransportVirtual},
		{"Continuity, wired", transportContinuityWire, "x", 0, dictate.TransportContinuity},
		{"Continuity, wireless", transportContinuityAir, "x", 0, dictate.TransportContinuity},
		{"Thunderbolt", 't'<<24 | 'h'<<16 | 'u'<<8 | 'n', "x", 0, dictate.TransportOther},
		{"unknown", 0, "x", 0, dictate.TransportOther},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := inputTransport(tt.kind, tt.uid, tt.source); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
	// The values CoreAudio's headers and Hex's tests give.
	if transportContinuityWire != 0x63637764 || transportContinuityAir != 0x6363776c {
		t.Error("the Continuity codes moved")
	}
}

func TestInputNames(t *testing.T) {
	log := slog.New(slog.DiscardHandler)
	path := filepath.Join(t.TempDir(), "input-names.json")
	n := loadInputNames(path, log)
	n.note([]dictate.Input{{UID: "a", Name: "Shure MV7"}, {UID: "b"}})
	if n.names["a"] != "Shure MV7" || n.names["b"] != "" {
		t.Fatalf("names %v", n.names)
	}
	// Across a launch, with the device gone.
	if got := loadInputNames(path, log).names["a"]; got != "Shure MV7" {
		t.Errorf("after a launch: %q", got)
	}
	n.note([]dictate.Input{{UID: "a", Name: "Renamed"}})
	if got := loadInputNames(path, log).names["a"]; got != "Renamed" {
		t.Errorf("after a rename: %q", got)
	}
	if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadInputNames(path, log).names; len(got) != 0 {
		t.Errorf("a bad file: %v", got)
	}
}

// fakeInputs is the Mac's inputs.
type fakeInputs struct {
	inputList
	calls   int
	changed chan struct{}
}

func (f *fakeInputs) list() inputList {
	f.calls++
	return f.inputList
}

func (f *fakeInputs) changes() <-chan struct{} { return f.changed }

// inputConn is the daemon as the reporter sees it.
type inputConn struct {
	dictationConn
	mu   sync.Mutex
	sent []*v1.DictationInputs
	err  error
}

func (c *inputConn) Inputs(_ context.Context, in *v1.DictationInputs) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, in)
	return c.err
}

func (c *inputConn) reports() []*v1.DictationInputs {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.sent)
}

func TestInputReporter(t *testing.T) {
	mac := dictate.Input{UID: "mac", Name: "MacBook Pro Microphone", Transport: dictate.TransportBuiltIn}
	on := func(in *v1.DictationInputs) *v1.DictationSnapshot {
		return &v1.DictationSnapshot{Enabled: true, Inputs: in}
	}
	reported := &v1.DictationInputs{DefaultUid: "mac", Devices: []*v1.DictationInput{{Uid: "mac", Name: mac.Name, Transport: "built_in"}}}
	rig := func(t *testing.T) (*inputReporter, *fakeInputs, *inputConn) {
		t.Helper()
		host := &fakeInputs{inputList: inputList{Devices: []dictate.Input{mac}, Default: "mac"}}
		return newInputReporter(host, filepath.Join(t.TempDir(), "names.json"), slog.New(slog.DiscardHandler)), host, &inputConn{}
	}

	t.Run("nothing while dictation is off", func(t *testing.T) {
		r, host, conn := rig(t)
		r.update(holdUpdate{conn: conn, snap: &v1.DictationSnapshot{}})
		r.check(time.Now())
		r.wg.Wait()
		if host.calls != 0 || len(conn.reports()) != 0 {
			t.Errorf("%d lists, reports %v", host.calls, conn.reports())
		}
	})
	t.Run("reports once, then the snapshot agrees", func(t *testing.T) {
		r, _, conn := rig(t)
		r.update(holdUpdate{conn: conn, snap: on(nil)})
		r.wg.Wait()
		if got := conn.reports(); len(got) != 1 || got[0].GetDefaultUid() != "mac" || got[0].GetDevices()[0].GetTransport() != "built_in" {
			t.Fatalf("reports %v", got)
		}
		r.update(holdUpdate{conn: conn, snap: on(reported)})
		r.check(time.Now())
		r.wg.Wait()
		if n := len(conn.reports()); n != 1 {
			t.Errorf("%d reports", n)
		}
	})
	t.Run("a device coming is reported", func(t *testing.T) {
		r, host, conn := rig(t)
		r.update(holdUpdate{conn: conn, snap: on(reported)})
		host.Devices = append(host.Devices, dictate.Input{UID: "pods", Name: "AirPods Pro", Transport: dictate.TransportBluetooth})
		host.Default = "pods"
		r.check(time.Now())
		r.wg.Wait()
		if got := conn.reports(); len(got) != 1 || len(got[0].GetDevices()) != 2 || got[0].GetDefaultUid() != "pods" {
			t.Fatalf("reports %v", got)
		}
	})
	t.Run("the lid is reported", func(t *testing.T) {
		r, host, conn := rig(t)
		r.update(holdUpdate{conn: conn, snap: on(reported)})
		host.LidClosed = true
		r.check(time.Now())
		r.wg.Wait()
		if got := conn.reports(); len(got) != 1 || !got[0].GetLidClosed() {
			t.Fatalf("reports %v", got)
		}
	})
	t.Run("a report not taken is tried again a recheck later, not sooner", func(t *testing.T) {
		r, _, conn := rig(t)
		conn.err = errors.New("no daemon")
		at := time.Now()
		r.update(holdUpdate{conn: conn, snap: on(nil)})
		r.check(at.Add(time.Second))
		r.wg.Wait()
		if n := len(conn.reports()); n != 1 {
			t.Fatalf("%d reports", n)
		}
		r.check(at.Add(inputRecheck + time.Second))
		r.wg.Wait()
		if n := len(conn.reports()); n != 2 {
			t.Fatalf("%d reports", n)
		}
	})
	t.Run("a restarted daemon is told again", func(t *testing.T) {
		r, _, conn := rig(t)
		r.update(holdUpdate{conn: conn, snap: on(nil)})
		r.lost()
		r.update(<-r.updates)
		r.update(holdUpdate{conn: conn, snap: on(nil)})
		r.wg.Wait()
		if n := len(conn.reports()); n != 2 {
			t.Fatalf("%d reports", n)
		}
	})
	t.Run("a named mic that has gone keeps its name", func(t *testing.T) {
		r, host, conn := rig(t)
		host.Devices = append(host.Devices, dictate.Input{UID: "shure", Name: "Shure MV7", Transport: dictate.TransportUSB})
		r.update(holdUpdate{conn: conn, snap: &v1.DictationSnapshot{Enabled: true, Microphone: "shure"}})
		r.wg.Wait()
		host.Devices = host.Devices[:1]
		r.update(holdUpdate{conn: conn, snap: &v1.DictationSnapshot{Enabled: true, Microphone: "shure"}})
		r.wg.Wait()
		got := conn.reports()
		if last := got[len(got)-1]; len(last.GetDevices()) != 1 || last.GetMicrophoneName() != "Shure MV7" {
			t.Fatalf("report %v", last)
		}
	})
	t.Run("run listens only once dictation is on, and a change reports at once", func(t *testing.T) {
		r, host, conn := rig(t)
		host.changed = make(chan struct{}, 1)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan struct{})
		go func() {
			defer close(done)
			r.run(ctx)
		}()
		r.observe(conn, on(reported))
		host.changed <- struct{}{}
		deadline := time.Now().Add(2 * time.Second)
		for host.changed != nil && len(host.changed) > 0 && time.Now().Before(deadline) {
			time.Sleep(time.Millisecond)
		}
		cancel()
		<-done
		if len(host.changed) != 0 {
			t.Error("the change was not read")
		}
	})
}
