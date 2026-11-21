package claudestream

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// wireLine is one line of a probe capture (testdata/*.wire.jsonl): what crossed the pipe,
// "out" to Claude or "in" from it, t milliseconds into the run. Captured from Claude Code
// 2.1.284 (docs/notes/cancel-queued-messages.md), trimmed to what the tests read.
type wireLine struct {
	T   int             `json:"t"`
	Dir string          `json:"dir"`
	Msg json.RawMessage `json:"msg"`
}

func wireFixture(t *testing.T, name string) []wireLine {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".wire.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []wireLine
	for _, l := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		var w wireLine
		if err := json.Unmarshal([]byte(l), &w); err != nil {
			t.Fatal(err)
		}
		out = append(out, w)
	}
	return out
}

// answerTo is the captured response to the capture's request with subtype, its
// request id replaced by id.
func answerTo(t *testing.T, lines []wireLine, subtype, id string) string {
	t.Helper()
	reqID := ""
	for _, l := range lines {
		var m struct {
			Type      string `json:"type"`
			RequestID string `json:"request_id"`
			Request   struct {
				Subtype string `json:"subtype"`
			} `json:"request"`
			Response struct {
				RequestID string `json:"request_id"`
			} `json:"response"`
		}
		_ = json.Unmarshal(l.Msg, &m)
		switch {
		case l.Dir == "out" && m.Type == "control_request" && m.Request.Subtype == subtype:
			reqID = m.RequestID
		case l.Dir == "in" && m.Type == "control_response" && reqID != "" && m.Response.RequestID == reqID:
			return strings.Replace(string(l.Msg), `"request_id":"`+reqID+`"`, `"request_id":"`+id+`"`, 1)
		}
	}
	t.Fatalf("no %s answered in the capture", subtype)
	return ""
}

// CancelAsyncMessage asks by the message's uuid and trusts Claude's answer: true while
// the message waits in the queue, false once Claude has read it.
func TestConnCancelAsyncMessage(t *testing.T) {
	tests := []struct {
		fixture string
		want    bool
	}{
		{fixture: "cancel-queued", want: true},
		{fixture: "cancel-late", want: false},
		{fixture: "cancel-first-of-two", want: true},
		{fixture: "cancel-then-interrupt", want: true},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			lines := wireFixture(t, tt.fixture)
			f := newFakeCLI(t, Options{})
			type res struct {
				ok  bool
				err error
			}
			done := make(chan res, 1)
			go func() {
				ok, err := f.conn.CancelAsyncMessage(context.Background(), "u-1")
				done <- res{ok, err}
			}()
			req := f.read()
			body := req["request"].(map[string]any)
			if body["subtype"] != "cancel_async_message" || body["message_uuid"] != "u-1" {
				t.Fatalf("request %v", req)
			}
			f.emit(answerTo(t, lines, "cancel_async_message", req["request_id"].(string)))
			r := <-done
			if r.err != nil || r.ok != tt.want {
				t.Errorf("cancelled = %v, %v; want %v", r.ok, r.err, tt.want)
			}
		})
	}
}

// The frames around a cancel parse as the projection reads them: the cancelled message's
// lifecycle says "cancelled", and an interrupted turn's own prompt gets one too.
func TestCancelLifecycleFrames(t *testing.T) {
	lines := wireFixture(t, "cancel-then-interrupt")
	var states []string
	for _, l := range lines {
		if l.Dir != "in" {
			continue
		}
		if e, ok := Parse(l.Msg).(*CommandLifecycle); ok {
			states = append(states, e.CommandUUID[:8]+":"+e.State)
		}
	}
	want := "363ffd53:queued 363ffd53:started a7a9e7bb:queued a7a9e7bb:cancelled 363ffd53:cancelled"
	if got := strings.Join(states, " "); got != want {
		t.Errorf("lifecycle = %s\nwant %s", got, want)
	}
}
