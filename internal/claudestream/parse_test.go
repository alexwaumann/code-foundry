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
		{
			// Claude Code 2.1.299: a background run, a nested foreground pair, the
			// background run woken again by SendMessage.
			name: "agents",
			want: map[string]int{"Task": 18, "Result": 6},
			check: func(t *testing.T, evs []Event) {
				var started, notified []*Task
				var progress, updated *Task
				for _, ev := range evs {
					tk, ok := ev.(*Task)
					if !ok {
						continue
					}
					switch tk.Subtype {
					case TaskStarted:
						started = append(started, tk)
					case TaskNotification:
						notified = append(notified, tk)
					case TaskProgress:
						if progress == nil {
							progress = tk
						}
					case TaskUpdated:
						if updated == nil {
							updated = tk
						}
					}
				}
				if len(started) != 5 || len(notified) != 5 {
					t.Fatalf("started %d, notified %d", len(started), len(notified))
				}
				bg, shell, outer, inner, again := started[0], started[1], started[2], started[3], started[4]
				if bg.TaskType != TaskTypeAgent || !bg.IsBackgrounded || bg.SpawnDepth != 1 || bg.Description != "Slow count" ||
					bg.SubagentType != "general-purpose" || bg.ToolUseID == "" || bg.RunID == "" {
					t.Errorf("background start %+v", bg)
				}
				if shell.TaskType != "local_bash" || !shell.OwnedBySubagent || shell.ParentTaskID != bg.TaskID {
					t.Errorf("shell start %+v", shell)
				}
				if outer.IsBackgrounded || outer.SpawnDepth != 1 || inner.SpawnDepth != 2 || inner.ParentTaskID != outer.TaskID {
					t.Errorf("nested starts %+v / %+v", outer, inner)
				}
				if again.TaskID != bg.TaskID || again.ToolUseID == bg.ToolUseID || again.RunID == bg.RunID || again.Prompt == "" {
					t.Errorf("resumed start %+v (first %+v)", again, bg)
				}
				if progress.LastToolName != "Bash" || progress.Usage == nil || progress.Usage.ToolUses != 1 ||
					!strings.HasPrefix(progress.Description, "Running ") {
					t.Errorf("progress %+v", progress)
				}
				if updated.Patch == nil || updated.Patch.Status != "completed" || updated.Patch.EndTime == 0 {
					t.Errorf("updated %+v", updated)
				}
				n := notified[1] // the background run's (the shell's comes first)
				if n.TaskID != bg.TaskID || n.Status != "completed" || n.Report() != "three" || n.Handback != "send" ||
					n.Usage == nil || n.Usage.TotalTokens == 0 || !strings.Contains(n.Summary, "SubagentHandback") {
					t.Errorf("notification %+v report %q", n, n.Report())
				}
			},
		},
		{
			// A background run stopped with TaskStop.
			name: "agents-stop",
			want: map[string]int{"Task": 6},
			check: func(t *testing.T, evs []Event) {
				for _, ev := range evs {
					tk, ok := ev.(*Task)
					if !ok || tk.TaskID != "a8625072e13dedaad" {
						continue
					}
					switch tk.Subtype {
					case TaskUpdated:
						if tk.Patch == nil || tk.Patch.Status != "killed" {
							t.Errorf("updated %+v", tk.Patch)
						}
					case TaskNotification:
						if tk.Status != "stopped" || tk.Report() != "Long wait" {
							t.Errorf("notification %+v", tk)
						}
					}
				}
			},
		},
		{
			// A process resumed after its predecessor was killed with a background run
			// open: Claude reports the run stopped before anything else.
			name: "agents-resume",
			want: map[string]int{"Task": 1, "Result": 2},
			check: func(t *testing.T, evs []Event) {
				tk, ok := evs[0].(*Task)
				if !ok || tk.Subtype != TaskNotification || tk.Status != "stopped" || !strings.Contains(tk.Summary, "didn't finish") {
					t.Errorf("first event %+v", evs[0])
				}
			},
		},
		{
			// Claude Code 2.1.300: the thread's own background shell (Bash
			// run_in_background), done after the turn; Claude then starts a turn itself.
			name: "shells",
			want: map[string]int{"Task": 3, "BackgroundTasks": 2, "Result": 2},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				st := sh.started
				if st.TaskType != TaskTypeShell || !st.IsBackgrounded || st.OwnedBySubagent || st.ParentTaskID != "" ||
					st.TaskID != "by3gxdr0o" || st.Description != "Run sleep 15 then echo done in background" {
					t.Errorf("start %+v", st)
				}
				if sh.call.Name != "Bash" || sh.call.ID != st.ToolUseID || !strings.Contains(string(sh.call.Input), `"run_in_background":true`) {
					t.Errorf("call %+v", sh.call)
				}
				if !strings.Contains(string(sh.result.ToolUseResult), `"backgroundTaskId":"by3gxdr0o"`) {
					t.Errorf("launch result %s", sh.result.ToolUseResult)
				}
				if sh.updated.Patch == nil || sh.updated.Patch.Status != "completed" || sh.updated.Patch.EndTime == 0 {
					t.Errorf("updated %+v", sh.updated.Patch)
				}
				n := sh.notified
				if n.Status != "completed" || n.ToolUseID != st.ToolUseID || n.Usage != nil ||
					n.Summary != `Background command "Run sleep 15 then echo done in background" completed (exit code 0)` {
					t.Errorf("notification %+v", n)
				}
				// The end comes between the turn's result and the turn Claude starts itself.
				if sh.at[n] < sh.results[0] || sh.at[n] > sh.results[1] {
					t.Errorf("notification at %d, results at %v", sh.at[n], sh.results)
				}
				if first, last := sh.lists[0], sh.lists[len(sh.lists)-1]; len(first.Tasks) != 1 || first.Tasks[0].TaskID != st.TaskID ||
					first.Tasks[0].TaskType != TaskTypeShell || len(last.Tasks) != 0 {
					t.Errorf("background task lists %+v … %+v", first, last)
				}
			},
		},
		{
			// A background shell that exits 3.
			name: "shells-fail",
			want: map[string]int{"Task": 3, "Result": 2},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				if sh.updated.Patch == nil || sh.updated.Patch.Status != "failed" {
					t.Errorf("updated %+v", sh.updated.Patch)
				}
				if n := sh.notified; n.Status != "failed" || !strings.HasSuffix(n.Summary, "failed with exit code 3") {
					t.Errorf("notification %+v", n)
				}
			},
		},
		{
			// A background shell stopped with TaskStop in the same turn.
			name: "shells-stop",
			want: map[string]int{"Task": 3, "Result": 1},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				if sh.updated.Patch == nil || sh.updated.Patch.Status != "killed" {
					t.Errorf("updated %+v", sh.updated.Patch)
				}
				if n := sh.notified; n.Status != "stopped" || n.Report() != sh.started.Description {
					t.Errorf("notification %+v", n)
				}
			},
		},
		{
			// A Monitor call whose command ends (a file appeared) after the turn.
			name: "shells-monitor",
			want: map[string]int{"Task": 3, "Result": 2},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				if st := sh.started; st.TaskType != TaskTypeShell || !st.IsBackgrounded || st.Description != "Wait for ready file" {
					t.Errorf("start %+v", st)
				}
				if sh.call.Name != "Monitor" || !strings.Contains(string(sh.result.ToolUseResult), `"taskId":"byocrxron"`) {
					t.Errorf("call %+v result %s", sh.call, sh.result.ToolUseResult)
				}
				if n := sh.notified; n.Status != "completed" || n.Summary != `Monitor "Wait for ready file" stream ended` {
					t.Errorf("notification %+v", n)
				}
			},
		},
		{
			// A Monitor whose output line starts a turn while it keeps running.
			name: "shells-monitor-events",
			want: map[string]int{"Task": 3, "Result": 3},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				if sh.at[sh.notified] < sh.results[1] {
					t.Errorf("the monitor ended at %d, before the event's turn ended (results %v)", sh.at[sh.notified], sh.results)
				}
			},
		},
		{
			// stdin closed with the shell running: claude stays; SIGTERM stops the shell
			// (the notification first) and exits 143.
			name: "shells-close",
			want: map[string]int{"Task": 3, "Result": 1},
			check: func(t *testing.T, evs []Event) {
				sh := shellFramesOf(t, evs)
				if sh.notified.Status != "stopped" || sh.notified.OutputFile != "" || sh.at[sh.notified] > sh.at[sh.updated] {
					t.Errorf("notification %+v (at %d, updated at %d)", sh.notified, sh.at[sh.notified], sh.at[sh.updated])
				}
				if sh.updated.Patch == nil || sh.updated.Patch.Status != "killed" {
					t.Errorf("updated %+v", sh.updated.Patch)
				}
			},
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

// shellFrames are a capture's one background shell: its frames, the call that started
// it and the call's result, the background task lists, where each came.
type shellFrames struct {
	started, updated, notified *Task
	call                       Block
	result                     *User
	lists                      []*BackgroundTasks
	results                    []int
	at                         map[*Task]int
}

func shellFramesOf(t *testing.T, evs []Event) shellFrames {
	t.Helper()
	sh := shellFrames{at: map[*Task]int{}}
	for i, ev := range evs {
		switch e := ev.(type) {
		case *Task:
			sh.at[e] = i
			switch e.Subtype {
			case TaskStarted:
				sh.started = e
			case TaskUpdated:
				sh.updated = e
			case TaskNotification:
				sh.notified = e
			}
		case *BackgroundTasks:
			sh.lists = append(sh.lists, e)
		case *Result:
			sh.results = append(sh.results, i)
		}
	}
	if sh.started == nil || sh.updated == nil || sh.notified == nil {
		t.Fatalf("shell frames %+v", sh)
	}
	for _, ev := range evs {
		switch e := ev.(type) {
		case *Assistant:
			for _, b := range e.Message.Content {
				if b.Type == "tool_use" && b.ID == sh.started.ToolUseID {
					sh.call = b
				}
			}
		case *User:
			for _, b := range e.Blocks() {
				if b.Type == "tool_result" && b.ToolUseID == sh.started.ToolUseID {
					sh.result = e
				}
			}
		}
	}
	if sh.call.ID == "" || sh.result == nil {
		t.Fatalf("no call or result for %s", sh.started.ToolUseID)
	}
	return sh
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

// The api_retry line is not in a capture (a 429 is hard to force); its shape is Claude
// Code 2.1.296's SDKAPIRetryMessage schema, read from the binary.
func TestParseAPIRetry(t *testing.T) {
	tests := []struct {
		name string
		line string
		want APIRetry
	}{
		{
			name: "rate limited",
			line: `{"type":"system","subtype":"api_retry","attempt":3,"max_retries":10,"retry_delay_ms":20000,"error_status":429,"error":"rate_limit","uuid":"u1","session_id":"s1"}`,
			want: APIRetry{Attempt: 3, MaxRetries: 10, RetryDelayMs: 20000, ErrorStatus: intp(429), Error: "rate_limit"},
		},
		{
			name: "connection error without a response",
			line: `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":500,"error_status":null,"error":"connection","no_response":{"waited_ms":30000,"retry_wait_ms":500},"uuid":"u2","session_id":"s1"}`,
			want: APIRetry{Attempt: 1, MaxRetries: 10, RetryDelayMs: 500, Error: "connection"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ev, ok := Parse([]byte(tt.line)).(*APIRetry)
			if !ok {
				t.Fatalf("parsed %T, want *APIRetry", Parse([]byte(tt.line)))
			}
			if ev.Attempt != tt.want.Attempt || ev.MaxRetries != tt.want.MaxRetries || ev.RetryDelayMs != tt.want.RetryDelayMs || ev.Error != tt.want.Error {
				t.Errorf("got %+v, want %+v", ev, tt.want)
			}
			if (ev.ErrorStatus == nil) != (tt.want.ErrorStatus == nil) || (ev.ErrorStatus != nil && *ev.ErrorStatus != *tt.want.ErrorStatus) {
				t.Errorf("error_status = %v, want %v", ev.ErrorStatus, tt.want.ErrorStatus)
			}
			if tt.name == "connection error without a response" && (ev.NoResponse == nil || ev.NoResponse.WaitedMs != 30000) {
				t.Errorf("no_response = %+v", ev.NoResponse)
			}
		})
	}
}

func intp(v int) *int { return &v }
