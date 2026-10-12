package claudestream

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fixture lines were captured from Claude Code 2.1.296 with haiku (docs/notes/
// rendered-threads-1-daemon.md); big fields (the initialize command list, thinking
// signatures, image data) are trimmed.
func fixture(t *testing.T, name string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var sp Splitter
	return sp.Split(nil, data)
}

// kindOf names a parsed event for tallies: its Go type, plus the subtype for system
// frames and the event type for stream events.
func kindOf(ev Event) string {
	switch e := ev.(type) {
	case *StreamEvent:
		if e.Event.Type == "content_block_delta" && e.Event.Delta != nil {
			return "delta:" + e.Event.Delta.Type
		}
		return "stream:" + e.Event.Type
	case *Unknown:
		return "unknown:" + e.Type + "/" + e.Subtype
	default:
		return strings.TrimPrefix(fmt.Sprintf("%T", ev), "*claudestream.")
	}
}

func TestParseFixtures(t *testing.T) {
	tests := []struct {
		name string
		want map[string]int // minimum counts
		// check sees every parsed event in order.
		check func(t *testing.T, evs []Event)
	}{
		{
			name: "text-table",
			want: map[string]int{"Init": 1, "Assistant": 1, "Result": 1, "delta:text_delta": 5, "CommandLifecycle": 3, "RateLimit": 1, "controlResponseLine": 1},
			check: func(t *testing.T, evs []Event) {
				a := only[*Assistant](t, evs)
				if len(a.Message.Content) != 1 || !strings.Contains(a.Message.Content[0].Text, "| 3 | Earth |") {
					t.Errorf("assistant content = %+v", a.Message.Content)
				}
				r := only[*Result](t, evs)
				if r.Subtype != "success" || r.IsError || r.StopReason != "end_turn" || r.TotalCostUSD <= 0 || r.Usage == nil || r.Usage.OutputTokens == 0 {
					t.Errorf("result = %+v", r)
				}
				// The streamed text adds up to the final block.
				var sb strings.Builder
				for _, ev := range evs {
					if s, ok := ev.(*StreamEvent); ok && s.Event.Delta != nil {
						sb.WriteString(s.Event.Delta.Text)
					}
				}
				if sb.String() != a.Message.Content[0].Text {
					t.Errorf("deltas %q != final %q", sb.String(), a.Message.Content[0].Text)
				}
			},
		},
		{
			name: "write-allow",
			want: map[string]int{"controlRequestLine": 1, "User": 1, "delta:input_json_delta": 1, "stream:content_block_start": 2},
			check: func(t *testing.T, evs []Event) {
				u := only[*User](t, evs)
				b := u.Blocks()
				if len(b) != 1 || b[0].Type != "tool_result" || b[0].ToolUseID == "" || !strings.Contains(b[0].ResultText(), "File created successfully") {
					t.Errorf("tool result = %+v", b)
				}
				var tr struct {
					Type     string `json:"type"`
					FilePath string `json:"filePath"`
				}
				if err := json.Unmarshal(u.ToolUseResult, &tr); err != nil || tr.Type != "create" || !strings.HasSuffix(tr.FilePath, "hello.txt") {
					t.Errorf("tool_use_result = %s (%v)", u.ToolUseResult, err)
				}
			},
		},
		{
			name: "write-deny",
			want: map[string]int{"controlRequestLine": 1, "User": 1},
			check: func(t *testing.T, evs []Event) {
				b := only[*User](t, evs).Blocks()
				if len(b) != 1 || !b[0].IsError || b[0].ResultText() != "The user denied this." {
					t.Errorf("denied tool result = %+v", b)
				}
			},
		},
		{
			name: "ask",
			want: map[string]int{"controlRequestLine": 1, "User": 1},
		},
		{
			name: "bash",
			want: map[string]int{"controlRequestLine": 1, "User": 1},
			check: func(t *testing.T, evs []Event) {
				b := only[*User](t, evs).Blocks()
				if len(b) != 1 || b[0].IsError || !strings.Contains(b[0].ResultText(), "finished") {
					t.Errorf("bash result = %+v", b)
				}
			},
		},
		{
			name: "task",
			want: map[string]int{"Task": 4, "controlRequestLine": 1},
			check: func(t *testing.T, evs []Event) {
				var sub []*Assistant
				for _, ev := range evs {
					if a, ok := ev.(*Assistant); ok && a.ParentToolUseID != "" {
						sub = append(sub, a)
					}
					if s, ok := ev.(*StreamEvent); ok && s.ParentToolUseID != "" {
						t.Errorf("subagent output was streamed: %s", s.Raw)
					}
				}
				if len(sub) != 1 || sub[0].SubagentType != "general-purpose" || sub[0].Message.Content[0].Name != "Write" {
					t.Errorf("subagent frames = %d %+v", len(sub), sub)
				}
			},
		},
		{
			name: "interrupt",
			want: map[string]int{"Result": 1, "Assistant": 1},
			check: func(t *testing.T, evs []Event) {
				a := only[*Assistant](t, evs)
				r := only[*Result](t, evs)
				if !a.Aborted || !r.Interrupted() || !r.IsError || r.Subtype != "error_during_execution" {
					t.Errorf("assistant aborted=%v result=%+v", a.Aborted, r)
				}
			},
		},
		{
			name: "interrupt-pending",
			want: map[string]int{"ControlCancel": 1, "Result": 1},
		},
		{
			name: "compact",
			want: map[string]int{"CompactBoundary": 1, "Result": 2, "Status": 2},
			check: func(t *testing.T, evs []Event) {
				cb := only[*CompactBoundary](t, evs)
				if cb.Metadata.Trigger != "manual" || cb.Metadata.PreTokens == 0 {
					t.Errorf("compact boundary = %+v", cb.Metadata)
				}
				var synthetic, replay int
				for _, ev := range evs {
					if u, ok := ev.(*User); ok {
						if u.IsSynthetic && strings.Contains(u.Text(), "Summary") {
							synthetic++
						}
						if u.IsReplay && strings.Contains(u.Text(), "<local-command-stdout>") {
							replay++
						}
					}
				}
				if synthetic != 1 || replay != 1 {
					t.Errorf("summary users = %d, local command outputs = %d", synthetic, replay)
				}
			},
		},
		{
			name: "image",
			want: map[string]int{"Assistant": 1, "Result": 1},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var evs []Event
			got := map[string]int{}
			for _, line := range fixture(t, tt.name) {
				ev := Parse(line)
				if u, ok := ev.(*Unknown); ok && u.Err != nil {
					t.Fatalf("parse %s: %v", line, u.Err)
				}
				if !bytes.Equal(ev.RawJSON(), line) {
					t.Fatalf("raw not kept")
				}
				got[kindOf(ev)]++
				evs = append(evs, ev)
			}
			for k, n := range tt.want {
				if got[k] < n {
					t.Errorf("%s: %d, want at least %d (all: %v)", k, got[k], n, got)
				}
			}
			for k := range got {
				if strings.HasPrefix(k, "unknown:") {
					t.Errorf("unmodelled line kind %s", k)
				}
			}
			if tt.check != nil {
				tt.check(t, evs)
			}
		})
	}
}

// only returns the single event of type T among evs (failing on none or several).
func only[T Event](t *testing.T, evs []Event) T {
	t.Helper()
	var out []T
	for _, ev := range evs {
		if x, ok := ev.(T); ok {
			out = append(out, x)
		}
	}
	if len(out) != 1 {
		var zero T
		t.Fatalf("%T: %d events, want 1", zero, len(out))
	}
	return out[0]
}

func TestParseTolerant(t *testing.T) {
	tests := []struct {
		name, line string
		wantType   string
		wantErr    bool
	}{
		{"not json", `hello`, "", true},
		{"unknown type", `{"type":"brand_new","x":1}`, "brand_new", false},
		{"unknown system subtype", `{"type":"system","subtype":"hook_started","hook":"x"}`, "system", false},
		{"bad field type", `{"type":"result","duration_ms":"soon"}`, "result", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			u, ok := Parse([]byte(tt.line)).(*Unknown)
			if !ok {
				t.Fatalf("not Unknown")
			}
			if u.Type != tt.wantType || (u.Err != nil) != tt.wantErr || string(u.Raw) != tt.line {
				t.Errorf("got type=%q err=%v raw=%s", u.Type, u.Err, u.Raw)
			}
		})
	}
	// Extra fields on a known type are ignored.
	if _, ok := Parse([]byte(`{"type":"assistant","message":{"id":"m","content":[{"type":"text","text":"x","new_field":1}]},"brand_new":true}`)).(*Assistant); !ok {
		t.Error("assistant with extra fields not parsed")
	}
}

func TestResultInterrupted(t *testing.T) {
	for reason, want := range map[string]bool{"aborted_streaming": true, "aborted_tools": true, "completed": false, "": false} {
		if got := (&Result{TerminalReason: reason}).Interrupted(); got != want {
			t.Errorf("%q: %v", reason, got)
		}
	}
}

func TestSplitter(t *testing.T) {
	tests := []struct {
		name    string
		max     int
		chunks  []string
		want    []string
		skipped int
		rest    string
	}{
		{"one chunk", 0, []string{"a\nb\n"}, []string{"a", "b"}, 0, ""},
		{"split across chunks", 0, []string{"ab", "c\nd", "e\n"}, []string{"abc", "de"}, 0, ""},
		{"blank lines dropped", 0, []string{"\n\n  \na\n"}, []string{"a"}, 0, ""},
		{"long line skipped mid-chunk", 4, []string{"12345\nok\n"}, []string{"ok"}, 1, ""},
		{"long line skipped across chunks", 4, []string{"123", "456", "789\nok\n"}, []string{"ok"}, 1, ""},
		{"partial rest", 0, []string{"a\nb"}, []string{"a"}, 0, "b"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sp := Splitter{Max: tt.max}
			var got []string
			for _, c := range tt.chunks {
				for _, l := range sp.Split(nil, []byte(c)) {
					got = append(got, string(l))
				}
			}
			if fmt.Sprint(got) != fmt.Sprint(tt.want) || sp.Skipped != tt.skipped || string(sp.Rest()) != tt.rest {
				t.Errorf("got %q skipped=%d rest=%q", got, sp.Skipped, sp.Rest())
			}
		})
	}
	// A multi-megabyte line survives ReadLines.
	big := strings.Repeat("x", 5<<20)
	var n []int
	if err := ReadLines(strings.NewReader(`{"a":1}`+"\n"+big+"\n"+"tail"), 0, func(l []byte) { n = append(n, len(l)) }); err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(n) != fmt.Sprint([]int{7, 5 << 20, 4}) {
		t.Errorf("line lengths %v", n)
	}
	if err := ReadLines(errReader{}, 0, func([]byte) {}); err == nil {
		t.Error("read error not returned")
	}
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("boom") }

func TestPermissionResultWire(t *testing.T) {
	input := json.RawMessage(`{"file_path":"/x"}`)
	tests := []struct {
		name string
		r    PermissionResult
		want string
	}{
		{"allow keeps input", PermissionResult{Allow: true}, `{"behavior":"allow","updatedInput":{"file_path":"/x"}}`},
		{"allow for session", PermissionResult{Allow: true, UpdatedPermissions: json.RawMessage(`[{"type":"setMode","mode":"acceptEdits","destination":"session"}]`)},
			`{"behavior":"allow","updatedInput":{"file_path":"/x"},"updatedPermissions":[{"destination":"session","mode":"acceptEdits","type":"setMode"}]}`},
		{"allow with answers", PermissionResult{Allow: true, UpdatedInput: json.RawMessage(`{"questions":[],"answers":{"Q":"A"}}`)},
			`{"behavior":"allow","updatedInput":{"answers":{"Q":"A"},"questions":[]}}`},
		{"deny default message", PermissionResult{}, `{"behavior":"deny","message":"The user denied this tool use."}`},
		{"deny and interrupt", PermissionResult{Message: "no", Interrupt: true}, `{"behavior":"deny","interrupt":true,"message":"no"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b, err := json.Marshal(tt.r.wire(input))
			if err != nil {
				t.Fatal(err)
			}
			var got, want any
			_ = json.Unmarshal(b, &got)
			_ = json.Unmarshal([]byte(tt.want), &want)
			if fmt.Sprint(got) != fmt.Sprint(want) {
				t.Errorf("got %s want %s", b, tt.want)
			}
		})
	}
}
