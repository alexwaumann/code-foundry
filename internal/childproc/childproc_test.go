package childproc

import (
	"io"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestMergeEnv(t *testing.T) {
	tests := []struct {
		name            string
		base, overrides []string
		want            []string
	}{
		{"set", []string{"A=1"}, []string{"B=2"}, []string{"A=1", "B=2"}},
		{"override keeps position", []string{"A=1", "B=2"}, []string{"A=3"}, []string{"A=3", "B=2"}},
		{"remove", []string{"A=1", "B=2"}, []string{"A"}, []string{"B=2"}},
		{"remove then set", []string{"A=1"}, []string{"A", "A=4"}, []string{"A=4"}},
		{"remove missing", []string{"A=1"}, []string{"Z"}, []string{"A=1"}},
	}
	for _, tt := range tests {
		if got := MergeEnv(tt.base, tt.overrides); !slices.Equal(got, tt.want) {
			t.Errorf("%s: %q, want %q", tt.name, got, tt.want)
		}
	}
}

func TestStartStderrLinesAndExit(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	p, err := Start(Spec{
		Argv:    []string{"/bin/sh", "-c", `printf 'one\ntwo\npartial' >&2; read x; echo "got $x"; exit 3`},
		BaseEnv: []string{"PATH=/usr/bin:/bin"},
		StderrLine: func(l string) {
			mu.Lock()
			lines = append(lines, l)
			mu.Unlock()
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(p.Stdin(), "hi\n"); err != nil {
		t.Fatal(err)
	}
	out, _ := io.ReadAll(p.Stdout())
	<-p.Done()
	if strings.TrimSpace(string(out)) != "got hi" {
		t.Errorf("stdout %q", out)
	}
	if p.ExitCode() != 3 {
		t.Errorf("exit %d", p.ExitCode())
	}
	mu.Lock()
	defer mu.Unlock()
	if !slices.Equal(lines, []string{"one", "two", "partial"}) {
		t.Errorf("lines %q", lines)
	}
	if p.LastStderrLine() != "partial" {
		t.Errorf("last line %q", p.LastStderrLine())
	}
}

func TestSignalGroup(t *testing.T) {
	p, err := Start(Spec{Argv: []string{"/bin/sh", "-c", "sleep 30 & wait"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("process group did not exit")
	}
	if err := p.Signal(syscall.SIGTERM); err != nil {
		t.Errorf("signal after exit: %v", err)
	}
}

// SignalGroup reaches what the process left in its group after it exited, and says
// whether anything was left.
func TestSignalGroupAfterExit(t *testing.T) {
	tests := []struct {
		name string
		// script runs under /bin/sh in the new group; it prints the pid of what it
		// leaves behind, or nothing.
		script   string
		wantLeft bool
	}{
		{"leaves a sleep behind", "sleep 30 > /dev/null 2>&1 & echo $!", true},
		{"leaves nothing", "true", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, err := Start(Spec{Argv: []string{"/bin/sh", "-c", tt.script}})
			if err != nil {
				t.Fatal(err)
			}
			out, _ := io.ReadAll(p.Stdout())
			<-p.Done()
			left, err := p.SignalGroup(syscall.SIGKILL)
			if err != nil || left != tt.wantLeft {
				t.Fatalf("SignalGroup = %v, %v; want %v", left, err, tt.wantLeft)
			}
			if !tt.wantLeft {
				return
			}
			pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
			if err != nil {
				t.Fatalf("pid %q", out)
			}
			deadline := time.Now().Add(5 * time.Second)
			for syscall.Kill(pid, 0) == nil {
				if time.Now().After(deadline) {
					t.Fatalf("pid %d is still running", pid)
				}
				time.Sleep(20 * time.Millisecond)
			}
			if left, _ := p.SignalGroup(syscall.SIGKILL); left {
				t.Error("the group still had a process")
			}
		})
	}
}

func TestStartErrors(t *testing.T) {
	if _, err := Start(Spec{}); err == nil || !strings.Contains(err.Error(), "empty argv") {
		t.Errorf("empty argv: %v", err)
	}
	if _, err := Start(Spec{Argv: []string{"no-such-binary-xyz"}, BaseEnv: []string{"PATH=/nonexistent"}, Name: "x"}); err == nil ||
		!strings.HasPrefix(err.Error(), "x: ") {
		t.Errorf("missing binary: %v", err)
	}
}
