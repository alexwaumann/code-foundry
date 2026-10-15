package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// A fake `claude -p` for the rendered runner's tests. The test binary re-executes
// itself as claude (Options.Claude = os.Args[0]) with CF_FAKE_CLAUDE set to a captured
// stream (internal/claudestream/testdata): it answers the control requests the daemon
// sends, and for every user message replays the next turn of the capture (lines up to
// and including a result), stopping at each can_use_tool until the daemon answers.
// Everything the daemon writes to stdin is appended to CF_FAKE_CLAUDE_LOG (and to
// CF_FAKE_CLAUDE_LOG.<pid>, this process's own), and argv to CF_FAKE_CLAUDE_ARGV (and
// CF_FAKE_CLAUDE_ARGV.<pid>). CF_FAKE_CLAUDE_SPAWN names a directory where each process
// writes <pid>.json: its argv, working directory and environment (fakeSpawn).
//
// Signals end the process the way Claude ends on its own: SIGUSR1 exits 0 (/exit),
// SIGUSR2 exits 1 (a crash), each after a stderr line.
//
// MCP: CF_FAKE_CLAUDE_MCP names a capture like claudestream/testdata/mcp.jsonl; mcp_status
// answers with its first mcp_status reply, and mcp_reconnect of a server takes that
// server's entry from the last reply when it changed there, else answers with the
// server's error (or "Server not found"). Without it mcp_status answers no servers.
//
// Slash commands: CF_FAKE_CLAUDE_COMMANDS names a capture like
// claudestream/testdata/commands.jsonl; initialize answers with its initialize reply's
// commands (fakeInitCommands). Without it initialize lists none.
//
// Knobs for the effort restart's tests: CF_FAKE_CLAUDE_EXIT_DELAY (a duration) keeps
// the process alive that long after stdin closes; CF_FAKE_CLAUDE_RESUME_EXIT (a code)
// makes a process started with --resume print to stderr and exit with it at once.
// CF_FAKE_CLAUDE_RESUME_HANG (any value) makes a process started with --resume never
// answer initialize. CF_FAKE_CLAUDE_ONCE=<path> limits RESUME_EXIT and RESUME_HANG to the
// first resumed process (the one that creates <path>); later ones start normally.
// CF_FAKE_CLAUDE_INIT_DELAY (a duration) holds the initialize answer that long, and
// CF_FAKE_CLAUDE_INIT_GATE=<path> holds it until <path> exists (the lifecycle tests'
// slow start).
//
// Turns Claude starts by itself (a background shell or agent ended while the thread was
// idle): with CF_FAKE_CLAUDE_UNPROMPTED=<dir>, only the first turn waits for a user
// message; turn n (2, 3, …) replays once the file <dir>/turn-<n> exists, and pauses
// before its first system/init line until <dir>/turn-<n>.init exists. Both waits end
// when stdin closes (the rest of the turn is then dropped, as a killed claude would).

const fakeClaudeEnv = "CF_FAKE_CLAUDE"

func TestMain(m *testing.M) {
	if fixture := os.Getenv(fakeClaudeEnv); fixture != "" {
		os.Exit(fakeStreamClaude(fixture))
	}
	os.Exit(m.Run())
}

func fixturePath(name string) string {
	p, _ := filepath.Abs(filepath.Join("..", "..", "claudestream", "testdata", name+".jsonl"))
	return p
}

// fakeTurns splits a capture into turns, dropping what the fake makes itself (the
// initialize response) and what belongs to the daemon's side.
func fakeTurns(path string) ([][]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var turns [][]string
	var cur []string
	for _, l := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(l) == "" {
			continue
		}
		var head struct {
			Type     string `json:"type"`
			Response struct {
				RequestID string `json:"request_id"`
			} `json:"response"`
		}
		_ = json.Unmarshal([]byte(l), &head)
		if head.Type == "control_response" {
			continue // responses to the capture's own requests
		}
		cur = append(cur, l)
		if head.Type == "result" {
			turns = append(turns, cur)
			cur = nil
		}
	}
	if len(cur) > 0 {
		turns = append(turns, cur)
	}
	return turns, nil
}

// fakeSpawn is what a fake claude process recorded about itself (CF_FAKE_CLAUDE_SPAWN).
type fakeSpawn struct {
	Argv []string `json:"argv"`
	Cwd  string   `json:"cwd"`
	Env  []string `json:"env"`
}

func fakeStreamClaude(fixture string) int {
	pid := strconv.Itoa(os.Getpid())
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGUSR1, syscall.SIGUSR2)
	go func() {
		code := 0
		if <-sigs == syscall.SIGUSR2 {
			code = 1
		}
		fmt.Fprintf(os.Stderr, "fake claude: exit %d\n", code)
		os.Exit(code)
	}()
	if p := os.Getenv("CF_FAKE_CLAUDE_ARGV"); p != "" {
		b, _ := json.Marshal(os.Args)
		_ = os.WriteFile(p, b, 0o600)
		_ = os.WriteFile(p+"."+pid, b, 0o600)
	}
	if dir := os.Getenv("CF_FAKE_CLAUDE_SPAWN"); dir != "" {
		cwd, _ := os.Getwd()
		b, _ := json.Marshal(fakeSpawn{Argv: os.Args, Cwd: cwd, Env: os.Environ()})
		// Written whole, then renamed: a reader never sees a partial record.
		tmp := filepath.Join(dir, pid+".tmp")
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, filepath.Join(dir, pid+".json"))
		}
	}
	resumeExit, resumeHang := os.Getenv("CF_FAKE_CLAUDE_RESUME_EXIT"), os.Getenv("CF_FAKE_CLAUDE_RESUME_HANG") != ""
	resumeFails := (resumeExit != "" || resumeHang) && slices.Contains(os.Args, "--resume") && fakeOnce()
	if resumeFails && resumeExit != "" {
		fmt.Fprintln(os.Stderr, "fake claude: cannot resume")
		n, _ := strconv.Atoi(resumeExit)
		return n
	}
	turns, err := fakeTurns(fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude:", err)
		return 2
	}
	var logf, ownLog *os.File
	if p := os.Getenv("CF_FAKE_CLAUDE_LOG"); p != "" {
		logf, _ = os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
		ownLog, _ = os.OpenFile(p+"."+pid, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	}
	mcp, err := newFakeMcp(os.Getenv("CF_FAKE_CLAUDE_MCP"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude:", err)
		return 2
	}
	commands, err := fakeInitCommands(os.Getenv("CF_FAKE_CLAUDE_COMMANDS"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude:", err)
		return 2
	}
	var outMu sync.Mutex
	write := func(line string) {
		outMu.Lock()
		defer outMu.Unlock()
		_, _ = os.Stdout.WriteString(line + "\n")
	}
	var mu sync.Mutex
	waiting := map[string]chan struct{}{}
	var replay sync.WaitGroup
	next := 0
	unprompted := os.Getenv("CF_FAKE_CLAUDE_UNPROMPTED")
	stdinClosed := make(chan struct{})
	// waitFile waits for path to exist; false once stdin closed.
	waitFile := func(path string) bool {
		for {
			if _, err := os.Stat(path); err == nil {
				return true
			}
			select {
			case <-stdinClosed:
				return false
			case <-time.After(5 * time.Millisecond):
			}
		}
	}
	// play writes a turn's lines, stopping at each can_use_tool until the daemon answers
	// and, with initGate, before the first system/init until that file exists. False when
	// stdin closed at the gate.
	play := func(turn []string, initGate string) bool {
		for _, l := range turn {
			var req struct {
				Type      string `json:"type"`
				Subtype   string `json:"subtype"`
				RequestID string `json:"request_id"`
				Request   struct {
					Subtype string `json:"subtype"`
				} `json:"request"`
			}
			_ = json.Unmarshal([]byte(l), &req)
			if initGate != "" && req.Type == "system" && req.Subtype == "init" {
				if !waitFile(initGate) {
					return false
				}
				initGate = ""
			}
			var ch chan struct{}
			if req.Type == "control_request" && req.Request.Subtype == "can_use_tool" {
				ch = make(chan struct{})
				mu.Lock()
				waiting[req.RequestID] = ch
				mu.Unlock()
			}
			write(l)
			if ch != nil {
				<-ch
			}
		}
		return true
	}
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(nil, 64<<20)
	for sc.Scan() {
		line := sc.Text()
		if logf != nil {
			_, _ = logf.WriteString(line + "\n")
			_, _ = ownLog.WriteString(line + "\n")
		}
		var m struct {
			Type      string         `json:"type"`
			RequestID string         `json:"request_id"`
			Request   map[string]any `json:"request"`
			Response  struct {
				RequestID string `json:"request_id"`
			} `json:"response"`
		}
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			continue
		}
		switch m.Type {
		case "control_request":
			resp := map[string]any{"subtype": "success", "request_id": m.RequestID}
			switch m.Request["subtype"] {
			case "initialize":
				if resumeFails && resumeHang {
					continue // never answers: the daemon's handshake timeout ends it
				}
				if d, err := time.ParseDuration(os.Getenv("CF_FAKE_CLAUDE_INIT_DELAY")); err == nil {
					time.Sleep(d) // a slow start: messages sent meanwhile wait in stdin
				}
				if gate := os.Getenv("CF_FAKE_CLAUDE_INIT_GATE"); gate != "" {
					for {
						if _, err := os.Stat(gate); err == nil {
							break
						}
						time.Sleep(5 * time.Millisecond)
					}
				}
				resp["response"] = map[string]any{"pid": os.Getpid(), "current_permission_mode": "default", "commands": commands}
			case "set_cwd":
				resp["response"] = map[string]any{"status": "ok", "cwd": m.Request["path"], "changed": true}
			case "mcp_status":
				resp["response"] = map[string]any{"mcpServers": mcp.servers()}
			case "mcp_reconnect":
				name, _ := m.Request["serverName"].(string)
				if msg := mcp.reconnect(name); msg != "" {
					resp = map[string]any{"subtype": "error", "request_id": m.RequestID, "error": msg}
				}
			case "set_permission_mode":
				if m.Request["mode"] == "bogus" {
					resp = map[string]any{"subtype": "error", "request_id": m.RequestID, "error": "Cannot set permission mode"}
				}
			case "interrupt":
				// Claude withdraws what it asked: the capture carries on (its own
				// control_cancel_request follows the can_use_tool).
				mu.Lock()
				for id, ch := range waiting {
					close(ch)
					delete(waiting, id)
				}
				mu.Unlock()
			}
			b, _ := json.Marshal(map[string]any{"type": "control_response", "response": resp})
			write(string(b))
		case "control_response":
			mu.Lock()
			if ch, ok := waiting[m.Response.RequestID]; ok {
				close(ch)
				delete(waiting, m.Response.RequestID)
			}
			mu.Unlock()
		case "user":
			if next >= len(turns) || (unprompted != "" && next > 0) {
				continue
			}
			turn, first := turns[next], next == 0
			next++
			replay.Add(1)
			go func() {
				defer replay.Done()
				play(turn, "")
				if unprompted == "" || !first {
					return
				}
				for n := 2; n <= len(turns); n++ {
					gate := filepath.Join(unprompted, "turn-"+strconv.Itoa(n))
					if !waitFile(gate) || !play(turns[n-1], gate+".init") {
						return
					}
				}
			}()
		}
	}
	close(stdinClosed)
	// stdin closed: nobody will answer a pending request.
	mu.Lock()
	for id, ch := range waiting {
		close(ch)
		delete(waiting, id)
	}
	mu.Unlock()
	replay.Wait()
	if d, err := time.ParseDuration(os.Getenv("CF_FAKE_CLAUDE_EXIT_DELAY")); err == nil {
		time.Sleep(d)
	}
	return 0
}

// fakeOnce reports whether this process takes a one-time failure: always without
// CF_FAKE_CLAUDE_ONCE, else only the first process to create its file.
func fakeOnce() bool {
	p := os.Getenv("CF_FAKE_CLAUDE_ONCE")
	if p == "" {
		return true
	}
	f, err := os.OpenFile(p, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

// fakeMcp is the fake's MCP servers (CF_FAKE_CLAUDE_MCP).
type fakeMcp struct {
	mu     sync.Mutex
	now    []map[string]any
	latest map[string]map[string]any
}

func newFakeMcp(path string) (*fakeMcp, error) {
	f := &fakeMcp{latest: map[string]map[string]any{}}
	if path == "" {
		return f, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var replies [][]map[string]any
	for _, l := range strings.Split(string(data), "\n") {
		var m struct {
			Response struct {
				Response struct {
					McpServers []map[string]any `json:"mcpServers"`
				} `json:"response"`
			} `json:"response"`
		}
		if json.Unmarshal([]byte(l), &m) == nil && m.Response.Response.McpServers != nil {
			replies = append(replies, m.Response.Response.McpServers)
		}
	}
	if len(replies) == 0 {
		return nil, fmt.Errorf("%s has no mcp_status reply", path)
	}
	f.now = replies[0]
	for _, s := range replies[len(replies)-1] {
		f.latest[s["name"].(string)] = s
	}
	return f, nil
}

func (f *fakeMcp) servers() []map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.now)
}

// reconnect returns the error Claude would answer, "" for success.
func (f *fakeMcp) reconnect(name string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	i := slices.IndexFunc(f.now, func(s map[string]any) bool { return s["name"] == name })
	if i < 0 {
		return "Server not found: " + name
	}
	if to, ok := f.latest[name]; ok && to["status"] != f.now[i]["status"] {
		f.now[i] = to
		return ""
	}
	if msg, _ := f.now[i]["error"].(string); msg != "" {
		return msg
	}
	return ""
}
