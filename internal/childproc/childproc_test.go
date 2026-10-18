package childproc

import (
	"io"
	"slices"
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

func TestStartErrors(t *testing.T) {
	if _, err := Start(Spec{}); err == nil || !strings.Contains(err.Error(), "empty argv") {
		t.Errorf("empty argv: %v", err)
	}
	if _, err := Start(Spec{Argv: []string{"no-such-binary-xyz"}, BaseEnv: []string{"PATH=/nonexistent"}, Name: "x"}); err == nil ||
		!strings.HasPrefix(err.Error(), "x: ") {
		t.Errorf("missing binary: %v", err)
	}
}
