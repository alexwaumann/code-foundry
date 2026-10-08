package claudestatus

import (
	"bufio"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// fixtureEvent is one record of a testdata/*.jsonl.gz capture (see testdata/README.md).
type fixtureEvent struct {
	T int64  `json:"t"` // ms since the terminal was created
	K string `json:"k"` // out, in, jsonl, screen, note, exit
	D string `json:"d"`
}

func loadFixture(tb testing.TB, name string) []fixtureEvent {
	tb.Helper()
	f, err := os.Open(filepath.Join("testdata", name+".jsonl.gz"))
	if err != nil {
		tb.Fatal(err)
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		tb.Fatal(err)
	}
	var evs []fixtureEvent
	sc := bufio.NewScanner(zr)
	sc.Buffer(make([]byte, 0, 1<<20), 1<<24)
	for sc.Scan() {
		var ev fixtureEvent
		if err := json.Unmarshal(sc.Bytes(), &ev); err != nil {
			tb.Fatalf("%s: %v", name, err)
		}
		evs = append(evs, ev)
	}
	if err := sc.Err(); err != nil {
		tb.Fatal(err)
	}
	return evs
}

// replayOpts selects which inputs reach the detector, to show how it degrades.
type replayOpts struct {
	tick         time.Duration // Tick period (default 1s)
	tickOffset   time.Duration // first Tick at this offset
	noTitle      bool          // strip OSC 0/2 from the output
	noTranscript bool          // drop JSONL lines
	noScreen     bool          // screen func fails
	noInput      bool          // never call Input
}

// transition is a change of status, or of attention reason kind.
type transition struct {
	At     time.Duration
	Status Status
	Kind   string // reason prefix for NeedsAttention ("permission", "finished", ...)
	Reason string
}

func (tr transition) String() string {
	return fmt.Sprintf("%6dms %-15s %s", tr.At.Milliseconds(), tr.Status, tr.Reason)
}

var titleOSC = regexp.MustCompile("\x1b\\][02];[^\x07\x1b]*(\x07|\x1b\\\\)")

var replayBase = time.Date(2026, 10, 8, 2, 0, 0, 0, time.UTC)

func replay(evs []fixtureEvent, o replayOpts) ([]transition, *Detector) {
	if o.tick == 0 {
		o.tick = time.Second
	}
	now := replayBase
	// The capture sampled the screen every 250 ms, so the last screen record can lag
	// the output already delivered. A real screen func reflects all output so far, so
	// screen() looks ahead to the next sample if it lies within one sampling period of
	// the last output.
	type sample struct {
		at   time.Duration
		text string
	}
	var screens []sample
	var outputs []time.Duration
	for _, ev := range evs {
		switch ev.K {
		case "screen":
			screens = append(screens, sample{time.Duration(ev.T) * time.Millisecond, ev.D})
		case "out":
			outputs = append(outputs, time.Duration(ev.T)*time.Millisecond)
		}
	}
	d := New(func() (string, error) {
		if o.noScreen {
			return "", errors.New("no screen")
		}
		at := now.Sub(replayBase)
		nextOut := time.Duration(1 << 62)
		for _, t := range outputs {
			if t > at {
				nextOut = t
				break
			}
		}
		text := ""
		for _, s := range screens {
			if s.at <= at {
				text = s.text
				continue
			}
			// The next sample shows the current screen if no output arrives before it.
			if s.at < nextOut && s.at <= at+260*time.Millisecond {
				text = s.text
			}
			break
		}
		return text, nil
	}, WithClock(func() time.Time { return now }))

	var out []transition
	record := func() {
		st, reason := d.Status()
		kind := ""
		if st == NeedsAttention {
			kind, _, _ = strings.Cut(reason, ":")
		}
		if n := len(out); n > 0 && out[n-1].Status == st && out[n-1].Kind == kind {
			return
		}
		out = append(out, transition{At: now.Sub(replayBase), Status: st, Kind: kind, Reason: reason})
	}
	record()
	next := o.tickOffset
	tickUntil := func(t time.Duration) {
		for next <= t {
			now = replayBase.Add(next)
			d.Tick(now)
			record()
			next += o.tick
		}
	}
	var last time.Duration
	for _, ev := range evs {
		at := time.Duration(ev.T) * time.Millisecond
		tickUntil(at)
		now = replayBase.Add(at)
		last = at
		switch ev.K {
		case "out":
			data := ev.D
			if o.noTitle {
				data = titleOSC.ReplaceAllString(data, "")
			}
			d.Output([]byte(data))
		case "in":
			if !o.noInput {
				d.Input([]byte(ev.D))
			}
		case "jsonl":
			if !o.noTranscript {
				d.Transcript([]byte(ev.D))
			}
		}
		record()
	}
	tickUntil(last + 3*time.Second)
	return out, d
}

func TestReplayTrace(t *testing.T) {
	name := os.Getenv("CLAUDESTATUS_TRACE")
	if name == "" {
		t.Skip("set CLAUDESTATUS_TRACE=<fixture> to print a replay timeline")
	}
	var o replayOpts
	for _, f := range strings.Split(os.Getenv("CLAUDESTATUS_TRACE_OPTS"), ",") {
		switch f {
		case "notitle":
			o.noTitle = true
		case "notranscript":
			o.noTranscript = true
		case "noscreen":
			o.noScreen = true
		case "noinput":
			o.noInput = true
		}
	}
	trs, _ := replay(loadFixture(t, name), o)
	for _, tr := range trs {
		t.Log(tr)
	}
}

func TestReplayTraceAll(t *testing.T) {
	if os.Getenv("CLAUDESTATUS_TRACE_ALL") == "" {
		t.Skip("set CLAUDESTATUS_TRACE_ALL=1 to print every fixture under every variant")
	}
	variants := map[string]replayOpts{"full": {}, "notitle": {noTitle: true}, "notranscript": {noTranscript: true},
		"noscreen": {noScreen: true}, "noinput": {noInput: true}}
	for _, name := range []string{"trust", "text", "permission", "question", "plan", "interrupt", "api-error",
		"long-tool", "ghostty-notify", "inline-renderer"} {
		evs := loadFixture(t, name)
		for _, v := range []string{"full", "notitle", "notranscript", "noscreen", "noinput"} {
			trs, _ := replay(evs, variants[v])
			var parts []string
			for _, tr := range trs {
				s := fmt.Sprintf("%d:%s", tr.At.Milliseconds(), tr.Status)
				if tr.Kind != "" {
					s += "(" + tr.Kind + ")"
				}
				parts = append(parts, s)
			}
			t.Logf("%-15s %-12s %s", name, v, strings.Join(parts, " "))
		}
	}
}
