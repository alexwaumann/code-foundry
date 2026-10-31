package thread

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Hand-written frames in the shapes of Claude Code 2.1.296's stream-json (see
// claudestream/testdata): a streamed top-level tool_use (content_block_start, then the
// assistant frame with its input), a subagent's whole frame, a tool_result, a result.
func busyStart(id, name string) string {
	return `{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":{}}}}`
}

func busyInput(id, name, input string) string {
	return `{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m-` + id + `","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func busySubagent(parent, id, name, input string) string {
	return `{"type":"assistant","parent_tool_use_id":"` + parent + `","message":{"id":"m-` + id + `","content":[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + input + `}]}}`
}

func busyResult(id string) string {
	return `{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"` + id + `","content":"ok"}]}}`
}

const busyTurnEnd = `{"type":"result","subtype":"success","is_error":false,"result":"done"}`

func TestBusyToolFollowsTopLevelCalls(t *testing.T) {
	tests := []struct {
		name   string
		frames []string
		want   []string // the line after each frame
	}{
		{
			name:   "set on tool start, argument once the input arrives",
			frames: []string{busyStart("t1", "Bash"), busyInput("t1", "Bash", `{"command":"make check"}`)},
			want:   []string{"Bash", "Bash make check"},
		},
		{
			name:   "cleared on result",
			frames: []string{busyStart("t1", "Read"), busyInput("t1", "Read", `{"file_path":"/w/src/lib/tree.ts"}`), busyResult("t1")},
			want:   []string{"Read", "Read src/lib/tree.ts", ""},
		},
		{
			name:   "cleared on turn end",
			frames: []string{busyStart("t1", "Bash"), busyInput("t1", "Bash", `{"command":"sleep 60"}`), busyTurnEnd},
			want:   []string{"Bash", "Bash sleep 60", ""},
		},
		{
			name: "subagent tool ignored, its Agent call shows",
			frames: []string{
				busyStart("a1", "Agent"), busyInput("a1", "Agent", `{"description":"Explore the store","prompt":"…"}`),
				busySubagent("a1", "s1", "Grep", `{"pattern":"busy"}`),
				`{"type":"user","parent_tool_use_id":"a1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"s1","content":"x"}]}}`,
				busyResult("a1"),
			},
			want: []string{"Agent", "Agent Explore the store", "Agent Explore the store", "Agent Explore the store", ""},
		},
		{
			name: "two in flight: the latest started, then the other",
			frames: []string{
				busyInput("t1", "Read", `{"file_path":"/w/a.go"}`),
				busyInput("t2", "Edit", `{"file_path":"/w/internal/api/gh.go"}`),
				busyResult("t2"),
				busyResult("t1"),
			},
			want: []string{"Read a.go", "Edit internal/api/gh.go", "Read a.go", ""},
		},
		{
			name: "the latest started keeps the line when the older ends first",
			frames: []string{
				busyInput("t1", "Read", `{"file_path":"/w/a.go"}`),
				busyInput("t2", "Grep", `{"pattern":"func main"}`),
				busyResult("t1"),
			},
			want: []string{"Read a.go", "Grep func main", "Grep func main"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			log := newThreadLog("s", bus.New(), time.Now, nil)
			p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
			for i, f := range tt.frames {
				p.event(claudestream.Parse([]byte(f)))
				if got := p.busy.line("/w"); got != tt.want[i] {
					t.Errorf("after frame %d: %q, want %q", i, got, tt.want[i])
				}
			}
		})
	}
}

func TestBusyToolFromCapture(t *testing.T) {
	// bash.jsonl: one Bash call in one turn. Its line shows between the call and its
	// result, and nothing is left once the turn ended.
	data, err := os.ReadFile(fixturePath("bash"))
	if err != nil {
		t.Fatal(err)
	}
	log := newThreadLog("s", bus.New(), time.Now, nil)
	p := newProjector(itemWriter{log: log, save: func(Item) {}}, runningTotals{known: true})
	var seen []string
	var sp claudestream.Splitter
	for _, line := range sp.Split(nil, data) {
		p.event(claudestream.Parse(line))
		if l := p.busy.line("/private/tmp/cf-stream-fixtures/w-bash"); l != "" && (len(seen) == 0 || seen[len(seen)-1] != l) {
			seen = append(seen, l)
		}
	}
	if len(seen) == 0 || !strings.HasPrefix(seen[len(seen)-1], "Bash ") {
		t.Errorf("lines %q, want a Bash call's", seen)
	}
	if l := p.busy.line(""); l != "" {
		t.Errorf("after the turn: %q", l)
	}
}

func TestBusyToolFor(t *testing.T) {
	tests := []struct {
		st     Status
		reason string
		want   string
	}{
		{StatusBusy, "working", "Bash make check"},
		{StatusBusy, "", "Bash make check"},
		{StatusBusy, ReasonCompacting, ""},
		{StatusNeedsAttention, "permission: Bash make check", ""},
		{StatusIdle, "", ""},
		{StatusError, ReasonInterrupted, ""},
		{StatusUnknown, "", ""},
	}
	for _, tt := range tests {
		if got := busyToolFor(tt.st, tt.reason, "Bash make check"); got != tt.want {
			t.Errorf("%v %q: %q, want %q", tt.st, tt.reason, got, tt.want)
		}
	}
}

func TestSetStatusDropsBusyTool(t *testing.T) {
	tests := []struct {
		st     Status
		reason string
		keep   bool
	}{
		{StatusBusy, "working", true},
		{StatusBusy, ReasonCompacting, false},
		{StatusIdle, "", false},
		{StatusNeedsAttention, "finished", false},
	}
	for _, tt := range tests {
		s := Thread{Status: StatusBusy, StatusReason: "working", BusyTool: "Bash make check"}
		s.setStatus(tt.st, tt.reason, time.Now())
		if got := s.BusyTool != ""; got != tt.keep {
			t.Errorf("%v %q: kept %v, want %v", tt.st, tt.reason, got, tt.keep)
		}
	}
}

func TestToolLine(t *testing.T) {
	tests := []struct {
		name, input, want string
	}{
		{"Bash", `{"command":"make check"}`, "Bash make check"},
		{"Bash", `{"command":"cd x\ngo test ./..."}`, "Bash cd x …"},
		{"Bash", `{"command":"go test\n\n"}`, "Bash go test"},
		{"Read", `{"file_path":"/w/src/lib/tree.ts"}`, "Read src/lib/tree.ts"},
		{"Read", `{"file_path":"/elsewhere/x.go"}`, "Read /elsewhere/x.go"},
		{"Edit", `{"file_path":"/w/internal/api/gh.go"}`, "Edit internal/api/gh.go"},
		{"NotebookEdit", `{"notebook_path":"/w/n.ipynb"}`, "NotebookEdit n.ipynb"},
		{"Grep", `{"pattern":"busy_tool","path":"/w/internal"}`, "Grep busy_tool"},
		{"Glob", `{"pattern":"**/*.go"}`, "Glob **/*.go"},
		{"Agent", `{"description":"Explore the store","subagent_type":"Explore"}`, "Agent Explore the store"},
		{"WebFetch", `{"url":"https://go.dev/doc"}`, "WebFetch go.dev/doc"},
		{"WebSearch", `{"query":"stream-json"}`, "WebSearch stream-json"},
		{"TodoWrite", `{"todos":[]}`, "TodoWrite"},
		{"mcp__github__get_pr", `{"number":3}`, "github get_pr"},
		{"Skill", `{"skill":"pages","args":"x"}`, "Skill pages"},
		{"Skill", `{"n":1,"later":"second"}`, "Skill second"},
		{"Bash", `{"command":"make`, "Bash"}, // partial input
		{"Bash", ``, "Bash"},
		{"Bash", `{"command":"` + strings.Repeat("x", 300) + `"}`, "Bash " + strings.Repeat("x", maxBusyTool-6) + "…"},
	}
	for _, tt := range tests {
		if got := toolLine(tt.name, tt.input, "/w/"); got != tt.want {
			t.Errorf("%s %s: %q, want %q", tt.name, tt.input, got, tt.want)
		}
	}
}

// End to end through the runner: a Claude stuck in a Bash call (CF_FAKE_CLAUDE_STALL
// replays the turn but its result) publishes the call on the record, and the record
// drops it with the process.
func TestBusyToolPublishedWhileTheCallRuns(t *testing.T) {
	lines := []string{
		busyInput("toolu_1", "Bash", `{"command":"make check"}`),
		busyTurnEnd,
	}
	path := filepath.Join(t.TempDir(), "busy.jsonl")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	e := newFixtureEnvAt(t, path, []string{"CF_FAKE_CLAUDE_STALL=1"}, func(o *Options) { o.CloseTimeout = 300 * time.Millisecond })
	s := e.create(CreateOptions{InitialPrompt: "check it"})
	e.waitFor(s.ID, "the running Bash call", func(s Thread) bool {
		return s.State == StateConnected && s.Status == StatusBusy && s.BusyTool == "Bash make check"
	})
	if err := e.m.Close(e.ctx(), s.ID); err != nil {
		t.Fatal(err)
	}
	got := e.waitFor(s.ID, "the close", func(s Thread) bool { return s.State == StateDisconnected })
	if got.BusyTool != "" {
		t.Errorf("disconnected thread keeps %q", got.BusyTool)
	}
}
