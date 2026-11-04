package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"

	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/dictate"
)

// The Mac's input devices for the Microphone row (docs/notes/dictation-microphone.md). The host
// lists them and reports to the daemon as it reports Accessibility: only while dictation is on,
// when the snapshot says otherwise, so a restarted daemon is told again.

const (
	// inputRecheck catches what no notification says: the lid, a missed change.
	inputRecheck = 5 * time.Second
	// CoreAudio's transport types.
	transportBuiltIn        uint32 = 'b'<<24 | 'l'<<16 | 't'<<8 | 'n'
	transportBluetooth      uint32 = 'b'<<24 | 'l'<<16 | 'u'<<8 | 'e'
	transportBluetoothLE    uint32 = 'b'<<24 | 'l'<<16 | 'e'<<8 | 'a'
	transportUSB            uint32 = 'u'<<24 | 's'<<16 | 'b'<<8 | ' '
	transportVirtual        uint32 = 'v'<<24 | 'i'<<16 | 'r'<<8 | 't'
	transportAggregate      uint32 = 'g'<<24 | 'r'<<16 | 'u'<<8 | 'p'
	transportAutoAggregate  uint32 = 'f'<<24 | 'g'<<16 | 'r'<<8 | 'p'
	transportContinuityWire uint32 = 'c'<<24 | 'c'<<16 | 'w'<<8 | 'd'
	transportContinuityAir  uint32 = 'c'<<24 | 'c'<<16 | 'w'<<8 | 'l'
	// The built-in input's data sources that closing the lid leaves on.
	sourceExternalMic uint32 = 'e'<<24 | 'm'<<16 | 'i'<<8 | 'c'
	sourceLineIn      uint32 = 'l'<<24 | 'i'<<16 | 'n'<<8 | 'e'
)

// inputTransport reads CoreAudio's transport type. A built-in input counts as the internal
// microphone unless it is the headphone jack: Apple silicon lists that as its own device, older
// Macs as the input's external-microphone or line-in source.
func inputTransport(kind uint32, uid string, source uint32) dictate.Transport {
	switch kind {
	case transportBuiltIn:
		if strings.Contains(uid, "HeadphoneInput") || source == sourceExternalMic || source == sourceLineIn {
			return dictate.TransportOther
		}
		return dictate.TransportBuiltIn
	case transportBluetooth, transportBluetoothLE:
		return dictate.TransportBluetooth
	case transportUSB:
		return dictate.TransportUSB
	case transportVirtual, transportAggregate, transportAutoAggregate:
		return dictate.TransportVirtual
	case transportContinuityWire, transportContinuityAir:
		return dictate.TransportContinuity
	}
	return dictate.TransportOther
}

// inputList is the Mac's inputs at a moment.
type inputList struct {
	Devices   []dictate.Input
	Default   string
	LidClosed bool
}

// inputHost is what reporting reads (coreAudioInputs; a fake in tests).
type inputHost interface {
	list() inputList
	// changes receives when a device comes or goes or the default moves. The first call
	// starts listening, so nothing listens before dictation is on.
	changes() <-chan struct{}
}

// inputNames remembers the last name seen for each device, across launches: a device that is
// gone is no longer listed, and the row still has to name it.
type inputNames struct {
	path  string
	log   *slog.Logger
	names map[string]string
}

func loadInputNames(path string, log *slog.Logger) *inputNames {
	n := &inputNames{path: path, log: log, names: map[string]string{}}
	b, err := os.ReadFile(path)
	if err != nil {
		return n
	}
	if err := json.Unmarshal(b, &n.names); err != nil || n.names == nil {
		log.Warn("dictation: starting the input names afresh", "err", err)
		n.names = map[string]string{}
	}
	return n
}

// note records what list shows, saving when something is new.
func (n *inputNames) note(devices []dictate.Input) {
	changed := false
	for _, d := range devices {
		if d.Name != "" && n.names[d.UID] != d.Name {
			n.names[d.UID] = d.Name
			changed = true
		}
	}
	if !changed {
		return
	}
	b, err := json.Marshal(n.names)
	if err == nil {
		err = writeFileAtomic(n.path, b)
	}
	if err != nil {
		n.log.Warn("dictation: save the input names", "err", err)
	}
}

// inputReport is what the daemon should know.
func inputReport(l inputList, microphone string, names *inputNames) *v1.DictationInputs {
	out := &v1.DictationInputs{DefaultUid: l.Default, LidClosed: l.LidClosed, MicrophoneName: names.names[microphone]}
	for _, d := range l.Devices {
		out.Devices = append(out.Devices, &v1.DictationInput{Uid: d.UID, Name: d.Name, Transport: string(d.Transport)})
	}
	return out
}

// inputReporter keeps the daemon's inputs right. The fields from conn down belong to the
// goroutine in run; tests call update and check from theirs.
type inputReporter struct {
	os      inputHost
	log     *slog.Logger
	updates chan holdUpdate
	ctx     context.Context
	wg      sync.WaitGroup // reports in flight, for tests

	names  *inputNames
	conn   dictationConn
	snap   *v1.DictationSnapshot
	sent   *v1.DictationInputs
	sentAt time.Time
}

// newInputReporter returns a reporter keeping names at namesPath; run starts it.
func newInputReporter(os_ inputHost, namesPath string, log *slog.Logger) *inputReporter {
	return &inputReporter{os: os_, log: log, updates: make(chan holdUpdate, 1), ctx: context.Background(), names: loadInputNames(namesPath, log)}
}

// observe takes a snapshot from the dictation watcher. It never blocks: only the latest matters.
func (r *inputReporter) observe(conn dictationConn, snap *v1.DictationSnapshot) {
	u := holdUpdate{conn: conn, snap: snap}
	for {
		select {
		case r.updates <- u:
			return
		default:
		}
		select {
		case <-r.updates:
		default:
		}
	}
}

// lost says the watcher's stream ended.
func (r *inputReporter) lost() { r.observe(nil, nil) }

func (r *inputReporter) run(ctx context.Context) {
	r.ctx = ctx
	ticker := time.NewTicker(inputRecheck)
	defer ticker.Stop()
	for {
		var changes <-chan struct{}
		if r.snap.GetEnabled() {
			changes = r.os.changes()
		}
		select {
		case <-ctx.Done():
			return
		case u := <-r.updates:
			r.update(u)
		case <-changes:
			r.check(time.Now())
		case now := <-ticker.C:
			r.check(now)
		}
	}
}

func (r *inputReporter) update(u holdUpdate) {
	r.conn = u.conn
	if u.snap == nil {
		r.sent = nil // a restarted daemon knows nothing of the last report
		return
	}
	r.snap = u.snap
	r.check(time.Now())
}

// check tells the daemon when its snapshot says otherwise. A failed report is tried again a
// recheck later. Nothing at all while dictation is off.
func (r *inputReporter) check(now time.Time) {
	if !r.snap.GetEnabled() {
		return
	}
	list := r.os.list()
	r.names.note(list.Devices)
	want := inputReport(list, r.snap.GetMicrophone(), r.names)
	conn := r.conn
	if conn == nil || proto.Equal(want, r.snap.GetInputs()) {
		r.sent = nil
		return
	}
	if proto.Equal(want, r.sent) && now.Sub(r.sentAt) < inputRecheck {
		return
	}
	r.sent, r.sentAt = want, now
	r.wg.Add(1)
	go func() {
		defer r.wg.Done()
		if err := conn.Inputs(r.ctx, want); err != nil {
			r.log.Debug("dictation: report the inputs", "err", err)
		}
	}()
}
