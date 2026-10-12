package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// A fake `claude -p` for the rendered runner's tests. The test binary re-executes
// itself as claude (Options.Claude = os.Args[0]) with CF_FAKE_CLAUDE set to a captured
// stream (internal/claudestream/testdata): it answers the control requests the daemon
// sends, and for every user message replays the next turn of the capture (lines up to
// and including a result), stopping at each can_use_tool until the daemon answers.
// Everything the daemon writes to stdin is appended to CF_FAKE_CLAUDE_LOG, and argv to
// CF_FAKE_CLAUDE_ARGV.

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

func fakeStreamClaude(fixture string) int {
	if p := os.Getenv("CF_FAKE_CLAUDE_ARGV"); p != "" {
		b, _ := json.Marshal(os.Args)
		_ = os.WriteFile(p, b, 0o600)
	}
	turns, err := fakeTurns(fixture)
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake claude:", err)
		return 2
	}
	var logf *os.File
	if p := os.Getenv("CF_FAKE_CLAUDE_LOG"); p != "" {
		logf, _ = os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
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
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(nil, 64<<20)
	for sc.Scan() {
		line := sc.Text()
		if logf != nil {
			_, _ = logf.WriteString(line + "\n")
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
				resp["response"] = map[string]any{"pid": os.Getpid(), "current_permission_mode": "default"}
			case "set_cwd":
				resp["response"] = map[string]any{"status": "ok", "cwd": m.Request["path"], "changed": true}
			case "set_permission_mode":
				if m.Request["mode"] == "bogus" {
					resp = map[string]any{"subtype": "error", "request_id": m.RequestID, "error": "Cannot set permission mode"}
				}
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
			if next >= len(turns) {
				continue
			}
			turn := turns[next]
			next++
			replay.Add(1)
			go func() {
				defer replay.Done()
				for _, l := range turn {
					var req struct {
						Type      string `json:"type"`
						RequestID string `json:"request_id"`
						Request   struct {
							Subtype string `json:"subtype"`
						} `json:"request"`
					}
					_ = json.Unmarshal([]byte(l), &req)
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
			}()
		}
	}
	// stdin closed: nobody will answer a pending request.
	mu.Lock()
	for id, ch := range waiting {
		close(ch)
		delete(waiting, id)
	}
	mu.Unlock()
	replay.Wait()
	return 0
}
