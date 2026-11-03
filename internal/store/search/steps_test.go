package search

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestShellWords(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{`code-foundry thread search 'login redirect'`, []string{"code-foundry", "thread", "search", "login redirect"}},
		{`code-foundry thread search "a \"b\"" c`, []string{"code-foundry", "thread", "search", `a "b"`, "c"}},
		{`a 'it'"'"'s here' b\ c`, []string{"a", "it's here", "b c"}},
		{`x && y || z; w | v`, []string{"x", "&&", "y", "||", "z", ";", "w", "|", "v"}},
		{`x ''`, []string{"x", ""}},
	}
	for _, tt := range tests {
		if got := shellWords(tt.in); !slices.Equal(got, tt.want) {
			t.Errorf("shellWords(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestSteps(t *testing.T) {
	names := func(id string) string {
		if id == "s-aaa" {
			return "Poller design"
		}
		return ""
	}
	tests := []struct {
		name    string
		tool    string
		command string
		desc    string
		result  string
		isError bool
		none    bool
		running string
		done    string
	}{
		{name: "search", tool: "Bash", command: `code-foundry thread search 'poller refetch' --limit 20`,
			result: "Messages: 12 in 3 threads (10 shown)\n", running: "Searching poller refetch…", done: "Searched poller refetch · 12 hits"},
		{name: "search, no match", tool: "Bash", command: `code-foundry thread search zzz`, result: "no matches",
			running: "Searching zzz…", done: "Searched zzz · no hits"},
		{name: "search, one", tool: "Bash", command: `/opt/cf/code-foundry thread search --json=false one`, result: "Messages: 1 in 1 thread\n",
			running: "Searching one…", done: "Searched one · 1 hit"},
		{name: "read", tool: "Bash", command: `code-foundry thread read s-aaa --since 3 --last 6 --full`,
			result: "#4 you 1d x\n  #5 claude 1d y\n#9 you 1d z\n", running: "Reading Poller design…", done: "Read Poller design · #4–#9"},
		{name: "read --id, one item", tool: "Bash", command: `code-foundry thread read --id s-zzz --last 1`, result: "#7 you 1d x\n",
			running: "Reading s-zzz…", done: "Read s-zzz · #7"},
		{name: "read, failed", tool: "Bash", command: `code-foundry thread read s-aaa`, result: "not found", isError: true,
			running: "Reading Poller design…", done: "Read Poller design · failed"},
		{name: "report", tool: "Bash", command: `code-foundry search report --search q-1 --thread s-aaa --item '#4' --quote 'x' --why 'y'`, none: true},
		{name: "other, described", tool: "Bash", command: `ls -la ~`, desc: "List home", result: "denied", isError: true,
			running: "List home…", done: "List home · failed"},
		{name: "other tool", tool: "Read", command: "", result: "x", running: "Read…", done: "Read"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in, _ := json.Marshal(bashInput{Command: tt.command, Description: tt.desc})
			st, ok := stepOf(tt.tool, in, names)
			if ok == tt.none {
				t.Fatalf("step = %v, want none %v", ok, tt.none)
			}
			if tt.none {
				return
			}
			if got := withText(st).Text; got != tt.running {
				t.Errorf("running = %q, want %q", got, tt.running)
			}
			if got := completeStep(st, tt.result, tt.isError); got.Text != tt.done || !got.Done || got.Failed != tt.isError {
				t.Errorf("done = %+v, want %q", got, tt.done)
			}
		})
	}
}

func TestCiteLink(t *testing.T) {
	h := Hit{ThreadID: "s-1", ItemID: "msg_01/1", Quote: "ünïcode 🙂 & (x)!*'", Why: "", Speaker: "user"}
	want := "[Quote](cf-cite://v1/s-1/msg_01%2F1?text=%C3%BCn%C3%AFcode%20%F0%9F%99%82%20%26%20%28x%29%21%2A%27&start=0&end=19&prefix=&suffix=)"
	if got := citeLink(h); got != want {
		t.Errorf("citeLink = %s\nwant      %s", got, want)
	}
}
