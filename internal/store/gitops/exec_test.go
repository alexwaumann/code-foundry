package gitops

import (
	"context"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestChildEnv(t *testing.T) {
	base := []string{"HOME=/h", "GIT_DIR=/elsewhere", "GIT_TERMINAL_PROMPT=1", "LC_ALL=de_DE", "PATH=/bin"}
	got := childEnv(base, []string{"EXTRA=1"})
	for _, want := range []string{"HOME=/h", "PATH=/bin", "GIT_TERMINAL_PROMPT=0", "LC_ALL=C", "GH_PROMPT_DISABLED=1", "GIT_EDITOR=true", "EXTRA=1"} {
		if !slices.Contains(got, want) {
			t.Errorf("env lacks %s: %v", want, got)
		}
	}
	for _, bad := range []string{"GIT_DIR=/elsewhere", "GIT_TERMINAL_PROMPT=1", "LC_ALL=de_DE"} {
		if slices.Contains(got, bad) {
			t.Errorf("env still has %s", bad)
		}
	}
}

func TestExecRunner(t *testing.T) {
	ctx := context.Background()
	r := ExecRunner{}
	t.Run("captures and interleaves", func(t *testing.T) {
		res := r.Run(ctx, Cmd{Dir: t.TempDir(), Name: "/bin/sh", Args: []string{"-c", "echo out; echo err >&2; echo $GIT_TERMINAL_PROMPT"}})
		if res.Err != nil || res.ExitCode != 0 {
			t.Fatalf("res = %+v", res)
		}
		if res.Stdout != "out\n0\n" {
			t.Errorf("stdout = %q", res.Stdout)
		}
		if !strings.Contains(res.Combined, "err\n") || !strings.Contains(res.Combined, "out\n") {
			t.Errorf("combined = %q", res.Combined)
		}
	})
	t.Run("no controlling terminal, stdin is /dev/null", func(t *testing.T) {
		res := r.Run(ctx, Cmd{Dir: "/", Name: "/bin/sh", Args: []string{"-c", "if (: </dev/tty) 2>/dev/null; then echo tty; else echo notty; fi; cat"}})
		if res.Err != nil || strings.TrimSpace(res.Stdout) != "notty" {
			t.Errorf("res = %+v", res)
		}
	})
	t.Run("exit code", func(t *testing.T) {
		res := r.Run(ctx, Cmd{Dir: "/", Name: "/bin/sh", Args: []string{"-c", "echo nope >&2; exit 3"}})
		if res.Err == nil || res.ExitCode != 3 || res.Combined != "nope\n" {
			t.Errorf("res = %+v", res)
		}
	})
	t.Run("timeout", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
		defer cancel()
		res := r.Run(ctx, Cmd{Dir: "/", Name: "/bin/sleep", Args: []string{"10"}})
		if res.Err != context.DeadlineExceeded {
			t.Errorf("err = %v, want deadline exceeded", res.Err)
		}
	})
	t.Run("not found", func(t *testing.T) {
		res := r.Run(ctx, Cmd{Dir: "/", Name: "/nonexistent/bin"})
		if res.Err == nil || res.ExitCode != -1 {
			t.Errorf("res = %+v", res)
		}
	})
	t.Run("grandchild holding the pipes is not a failure", func(t *testing.T) {
		start := time.Now()
		res := ExecRunner{WaitDelay: 200 * time.Millisecond}.Run(ctx, Cmd{Dir: "/", Name: "/bin/sh", Args: []string{"-c", "sleep 3 & echo launched"}})
		if res.Err != nil || res.Stdout != "launched\n" {
			t.Errorf("res = %+v", res)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Errorf("took %s, want about WaitDelay", d)
		}
	})
}

func TestQuoteForDisplay(t *testing.T) {
	c := Cmd{Name: "/opt/homebrew/bin/gh", Args: []string{"pr", "create", "--title", "Fix it's thing", "--body", ""}}
	if got, want := c.String(), `gh pr create --title 'Fix it'\''s thing' --body ''`; got != want {
		t.Errorf("String() = %s, want %s", got, want)
	}
}

func TestLanes(t *testing.T) {
	l := newLanes(2)
	var mu sync.Mutex
	order := map[string][]int{}
	var running, peak atomic.Int32
	var wg sync.WaitGroup
	for i := range 6 {
		key := []string{"a", "b", "c"}[i%3]
		wg.Add(1)
		waits := l.submit(key, func() {
			defer wg.Done()
			n := running.Add(1)
			for {
				p := peak.Load()
				if n <= p || peak.CompareAndSwap(p, n) {
					break
				}
			}
			time.Sleep(20 * time.Millisecond)
			mu.Lock()
			order[key] = append(order[key], i)
			mu.Unlock()
			running.Add(-1)
		})
		if want := i >= 3; waits != want {
			t.Errorf("job %d on %s: waits = %v, want %v", i, key, waits, want)
		}
	}
	wg.Wait()
	l.wait()
	if p := peak.Load(); p > 2 {
		t.Errorf("peak concurrency %d, want <= 2", p)
	}
	for key, want := range map[string][]int{"a": {0, 3}, "b": {1, 4}, "c": {2, 5}} {
		if !slices.Equal(order[key], want) {
			t.Errorf("lane %s order = %v, want %v", key, order[key], want)
		}
	}
	if len(l.queue) != 0 {
		t.Errorf("lanes left behind: %v", l.queue)
	}
}
