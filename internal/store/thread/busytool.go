package thread

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"unicode/utf8"
)

// The tool Claude is running now (Thread.BusyTool): what a working sidebar row says,
// "Bash make check". The projector follows the top-level tool calls in flight (busyCalls);
// the runner publishes the latest started one's line with the status (runner.go
// publishStatus), only while the status is busy and not compacting (busyToolFor). Not
// persisted. See docs/notes/sidebar-inbox-1-busy-tool.md.

// maxBusyTool caps the line in runes; the row truncates it further.
const maxBusyTool = 160

type busyCall struct {
	id, name, input string
}

// busyCalls are the top-level tool calls whose result has not arrived, in start order.
// A subagent's calls (parent_tool_use_id set) never enter: the Agent call that runs it
// stands for them. A background launch (Agent, Bash, Monitor) leaves at its immediate
// result: its run is the agents' and shells' counters, not a tool running now.
type busyCalls []busyCall

// start adds a call; a call already in flight keeps its place.
func (b *busyCalls) start(id, name, input string) {
	if id == "" || slices.ContainsFunc(*b, func(c busyCall) bool { return c.id == id }) {
		b.input(id, input)
		return
	}
	*b = append(*b, busyCall{id: id, name: name, input: input})
}

// input records a call's complete input (its assistant frame, or the streamed JSON at
// its block's stop).
func (b busyCalls) input(id, input string) {
	if input == "" {
		return
	}
	for i := range b {
		if b[i].id == id {
			b[i].input = input
		}
	}
}

// done removes a call whose result arrived.
func (b *busyCalls) done(id string) {
	*b = slices.DeleteFunc(*b, func(c busyCall) bool { return c.id == id })
}

// clear: the turn ended (or the process restarted); nothing runs.
func (b *busyCalls) clear() { *b = nil }

// line is the latest started call's line, "" when none runs.
func (b busyCalls) line(cwd string) string {
	if len(b) == 0 {
		return ""
	}
	c := b[len(b)-1]
	return toolLine(c.name, c.input, cwd)
}

// busyToolFor is the published value: the running call's line while the thread is
// busy working, "" otherwise (waiting on the user, compacting, idle, stopped).
func busyToolFor(st Status, reason, line string) string {
	if st != StatusBusy || reason == ReasonCompacting {
		return ""
	}
	return line
}

// ReasonCompacting is the busy reason while Claude compacts the conversation
// (stream_status.go).
const ReasonCompacting = "compacting"

// toolLine is "<tool> <argument>", the argument the live tool strip shows as a step's
// target (gui/frontend/src/lib/toolSummary.ts): a command's first line, a path relative
// to cwd, a pattern, a description. An MCP tool reads "<server> <tool>". Input that
// does not parse leaves the name alone.
func toolLine(name, input, cwd string) string {
	in := map[string]any{}
	_ = json.Unmarshal([]byte(input), &in) // partial or junk input: no argument
	s := func(k string) string { v, _ := in[k].(string); return v }
	arg := ""
	switch name {
	case "Bash":
		arg = firstLineOf(s("command"))
	case "Read", "Edit", "MultiEdit", "Write", "NotebookEdit":
		arg = relTo(cwd, nonEmpty(s("file_path"), s("notebook_path")))
	case "Grep", "Glob":
		arg = s("pattern")
	case "LS":
		arg = relTo(cwd, s("path"))
	case "Agent", "Task":
		arg = s("description")
	case "WebFetch":
		arg = strings.TrimPrefix(strings.TrimPrefix(s("url"), "https://"), "http://")
	case "WebSearch":
		arg = s("query")
	case "TodoWrite":
	default:
		if server, tool, ok := mcpTool(name); ok {
			name, arg = server, tool
		} else {
			arg = firstLineOf(firstString(input))
		}
	}
	return capRunes(strings.TrimSpace(name+" "+strings.TrimSpace(arg)), maxBusyTool)
}

// mcpTool splits "mcp__<server>__<tool>".
func mcpTool(name string) (server, tool string, ok bool) {
	rest, ok := strings.CutPrefix(name, "mcp__")
	if !ok {
		return "", "", false
	}
	server, tool, ok = strings.Cut(rest, "__")
	return server, tool, ok && server != "" && tool != ""
}

// firstString is the first non-empty top-level string value of a JSON object, in
// document order (what an unknown tool's call is about); "" when none.
func firstString(input string) string {
	dec := json.NewDecoder(bytes.NewReader([]byte(input)))
	if t, err := dec.Token(); err != nil || t != json.Delim('{') {
		return ""
	}
	for dec.More() {
		if _, err := dec.Token(); err != nil { // the key
			return ""
		}
		var v any
		if err := dec.Decode(&v); err != nil {
			return ""
		}
		if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

// firstLineOf is s's first non-blank line, with " …" when more follows.
func firstLineOf(s string) string {
	s = strings.TrimSpace(s)
	line, rest, more := strings.Cut(s, "\n")
	line = strings.TrimSpace(line)
	if more && strings.TrimSpace(rest) != "" {
		return line + " …"
	}
	return line
}

// relTo is path relative to cwd when inside it.
func relTo(cwd, path string) string {
	root := strings.TrimRight(cwd, "/")
	if root != "" {
		if rel, ok := strings.CutPrefix(path, root+"/"); ok {
			return rel
		}
	}
	return path
}

// capRunes cuts s to n runes, ending in "…" when cut.
func capRunes(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return strings.TrimSpace(string(r[:n-1])) + "…"
}
