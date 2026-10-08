package session

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"
)

// ackDetector logs what the runner feeds it ("out:<chunk>", "tr", "ack") and models
// claudestatus's "finished" rule: output nobody has acknowledged yet is unseen.
type ackDetector struct {
	mu     sync.Mutex
	log    []string
	unseen bool
}

func (d *ackDetector) Output(b []byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.log = append(d.log, "out:"+string(b))
	d.unseen = true
}

func (d *ackDetector) Transcript([]byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.log = append(d.log, "tr")
	d.unseen = true
}

func (d *ackDetector) Tick(time.Time) {}

func (d *ackDetector) Acknowledge() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.log = append(d.log, "ack")
	d.unseen = false
}

func (d *ackDetector) Status() (Status, string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.unseen {
		return StatusNeedsAttention, "finished"
	}
	return StatusIdle, "at prompt"
}

func (d *ackDetector) entries() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.log...)
}

// ackEnv is a connected session whose detector is an ackDetector.
type ackEnv struct {
	*env
	det     *ackDetector
	s       Session
	cid     string
	cancels []context.CancelFunc
}

func newAckEnv(t *testing.T) *ackEnv {
	t.Helper()
	det := &ackDetector{}
	e := newEnv(t, func(o *Options) { o.NewDetector = func(ScreenTextFn) StatusDetector { return det } })
	s := e.connected(CreateOptions{})
	spec, _ := e.terms.Spec(s.TerminalID)
	return &ackEnv{env: e, det: det, s: s, cid: argOf(spec.Argv, "--session-id")}
}

// attach opens a viewer (as TerminalService.Attach does for the GUI).
func (a *ackEnv) attach() {
	a.t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	a.t.Cleanup(cancel)
	if _, err := a.terms.Attach(ctx, a.s.TerminalID); err != nil {
		a.t.Fatal(err)
	}
	a.cancels = append(a.cancels, cancel)
}

// detach closes the newest viewer and waits until the terminal store has dropped it.
func (a *ackEnv) detach() {
	a.t.Helper()
	before := a.terms.Attached(a.s.TerminalID)
	last := len(a.cancels) - 1
	a.cancels[last]()
	a.cancels = a.cancels[:last]
	deadline := time.Now().Add(5 * time.Second)
	for a.terms.Attached(a.s.TerminalID) >= before {
		if time.Now().After(deadline) {
			a.t.Fatal("viewer never detached")
		}
		time.Sleep(time.Millisecond)
	}
}

// count returns how many detector log entries equal e.
func (a *ackEnv) count(e string) int {
	n := 0
	for _, x := range a.det.entries() {
		if x == e {
			n++
		}
	}
	return n
}

// waitLog waits until the detector log has at least n entries.
func (a *ackEnv) waitLog(n int) []string {
	a.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		got := a.det.entries()
		if len(got) >= n || time.Now().After(deadline) {
			return got
		}
		time.Sleep(time.Millisecond)
	}
}

// The acknowledge rule: a viewer attaching acknowledges, and so does every output
// chunk and transcript line fed to the detector while at least one viewer is attached.
// Detaching never does.
func TestAcknowledgeWhileViewed(t *testing.T) {
	tests := []struct {
		name  string
		steps []string // attach | detach | tr | out:<chunk>; "out:end" is appended
		want  string
	}{
		{"unviewed output is not acknowledged", []string{"out:a"}, "out:a out:end"},
		{"attach acknowledges", []string{"attach"}, "ack out:end ack"},
		{"output while viewed is acknowledged per chunk", []string{"attach", "out:a", "out:b"}, "ack out:a ack out:b ack out:end ack"},
		{"each new viewer acknowledges", []string{"attach", "attach"}, "ack ack out:end ack"},
		{"detach does not acknowledge; later output is unseen", []string{"attach", "detach", "out:a"}, "ack out:a out:end"},
		{"one of two viewers leaves: still viewed", []string{"attach", "attach", "detach", "out:a"}, "ack ack out:a ack out:end ack"},
		{"reattach acknowledges what was missed", []string{"attach", "detach", "out:a", "attach"}, "ack out:a ack out:end ack"},
		{"transcript line while viewed", []string{"attach", "tr"}, "ack tr ack out:end ack"},
		{"unviewed transcript line", []string{"tr"}, "tr out:end"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a := newAckEnv(t)
			for _, step := range append(tt.steps, "out:end") {
				switch {
				case step == "attach":
					a.attach()
				case step == "detach":
					a.detach()
				case step == "tr":
					// The transcript is tailed asynchronously: wait until the line is
					// fed before the next step, so the log order is deterministic.
					trs := a.count("tr")
					a.writeTranscript(a.cid, `{"type":"mode"}`)
					deadline := time.Now().Add(5 * time.Second)
					for a.count("tr") == trs {
						if time.Now().After(deadline) {
							t.Fatal("transcript line never fed")
						}
						time.Sleep(time.Millisecond)
					}
				case strings.HasPrefix(step, "out:"):
					if err := a.terms.Emit(a.s.TerminalID, []byte(strings.TrimPrefix(step, "out:"))); err != nil {
						t.Fatal(err)
					}
				}
			}
			want := strings.Fields(tt.want)
			a.waitLog(len(want))
			time.Sleep(20 * time.Millisecond) // anything extra would show up now
			got := a.det.entries()
			if strings.Join(got, " ") != tt.want {
				t.Fatalf("detector log = %q, want %q", strings.Join(got, " "), tt.want)
			}
		})
	}
}

// What `session list` shows: "finished" attention while nobody looks, idle once a
// viewer attaches, attention again for output after the viewer left.
func TestFinishedClearsWhenViewed(t *testing.T) {
	a := newAckEnv(t)
	_ = a.terms.Emit(a.s.TerminalID, []byte("turn done"))
	got := a.waitFor(a.s.ID, "finished", func(s Session) bool { return s.Status == StatusNeedsAttention })
	if got.StatusReason != "finished" {
		t.Errorf("reason = %q, want finished", got.StatusReason)
	}
	a.attach()
	a.waitFor(a.s.ID, "idle once viewed", func(s Session) bool { return s.Status == StatusIdle })
	_ = a.terms.Emit(a.s.TerminalID, []byte("more while viewed"))
	time.Sleep(50 * time.Millisecond)
	if s, _ := a.m.Get(context.Background(), a.s.ID); s.Status != StatusIdle {
		t.Errorf("status while viewed = %v, want idle", s.Status)
	}
	a.detach()
	_ = a.terms.Emit(a.s.TerminalID, []byte("after the viewer left"))
	a.waitFor(a.s.ID, "finished again", func(s Session) bool { return s.Status == StatusNeedsAttention })
}
