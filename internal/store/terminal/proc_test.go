package terminal

import (
	"encoding/binary"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

func TestCwdOf(t *testing.T) {
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	wd, _ = filepath.EvalSymlinks(wd)
	if got, err := cwdOf(os.Getpid()); err != nil || got != wd {
		t.Errorf("cwdOf(self) = %q, %v; want %q", got, err, wd)
	}

	dir, _ := filepath.EvalSymlinks(t.TempDir())
	cmd := exec.Command("/bin/sleep", "600")
	cmd.Dir = dir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	if got, err := cwdOf(pid); err != nil || got != dir {
		t.Errorf("cwdOf(child) = %q, %v; want %q", got, err, dir)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if _, err := cwdOf(pid); !errors.Is(err, syscall.ESRCH) {
		t.Errorf("cwdOf(gone) err = %v, want ESRCH", err)
	}
	if _, err := cwdOf(0); err == nil {
		t.Error("cwdOf(0) did not fail")
	}
}

// startGroup starts argv in a process group of its own and kills the group at cleanup.
func startGroup(t *testing.T, argv ...string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pg := cmd.Process.Pid
	t.Cleanup(func() { _ = syscall.Kill(-pg, syscall.SIGKILL); _ = cmd.Wait() })
	return cmd
}

func TestGroupCommand(t *testing.T) {
	leader := startGroup(t, "/bin/sleep", "600")
	if got := groupCommand(leader.Process.Pid); got != "sleep 600" && got != "/bin/sleep 600" {
		t.Errorf("groupCommand(leader alive) = %q, want sleep 600", got)
	}

	// The leader exits and leaves a member behind: the oldest member names the job.
	gone := startGroup(t, "/bin/sh", "-c", `/bin/sleep 601 & exit 0`)
	pg := gone.Process.Pid
	_ = gone.Wait()
	// The member is a fork of sh until it has exec'd sleep: wait for that.
	deadline := time.Now().Add(time.Minute)
	got := ""
	for got != "/bin/sleep 601" && time.Now().Before(deadline) {
		if got = groupCommand(pg); got != "/bin/sleep 601" {
			time.Sleep(20 * time.Millisecond)
		}
	}
	if got != "/bin/sleep 601" {
		t.Errorf("groupCommand(leader gone) = %q, want /bin/sleep 601", got)
	}

	if got := groupCommand(0); got != "" {
		t.Errorf("groupCommand(0) = %q", got)
	}
}

func procargs(argc uint32, rest string) []byte {
	b := binary.LittleEndian.AppendUint32(nil, argc)
	return append(b, rest...)
}

func TestParseProcargs(t *testing.T) {
	tests := []struct {
		name    string
		in      []byte
		want    []string
		wantErr bool
	}{
		{name: "argv then env", in: procargs(2, "/bin/sleep\x00\x00\x00\x00sleep\x00600\x00PATH=/bin\x00"), want: []string{"sleep", "600"}},
		{name: "no padding", in: procargs(1, "/bin/ls\x00ls\x00"), want: []string{"ls"}},
		{name: "an empty argument", in: procargs(3, "/bin/echo\x00echo\x00\x00x\x00"), want: []string{"echo", "", "x"}},
		{name: "argc larger than what is there", in: procargs(5, "/bin/a\x00a\x00b"), want: []string{"a", "b"}},
		{name: "too short", in: []byte{1, 0}, wantErr: true},
		{name: "no path end", in: procargs(1, "/bin/a"), wantErr: true},
		{name: "no arguments", in: procargs(0, "/bin/a\x00\x00"), wantErr: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseProcargs(tt.in)
			if (err != nil) != tt.wantErr || !slices.Equal(got, tt.want) {
				t.Errorf("parseProcargs = %q, %v; want %q (error %v)", got, err, tt.want, tt.wantErr)
			}
		})
	}
}

func TestQuoteArgs(t *testing.T) {
	tests := []struct {
		argv []string
		want string
	}{
		{[]string{"sleep", "5"}, "sleep 5"},
		{[]string{"git", "log", "--format=%h %s"}, "git log '--format=%h %s'"},
		{[]string{"echo", "it's"}, `echo 'it'\''s'`},
		{[]string{"printf", ""}, "printf ''"},
		{[]string{"/usr/bin/env", "A=b", "user@host:~/x"}, "/usr/bin/env A=b 'user@host:~/x'"},
		{[]string{"echo", "*", "$HOME"}, "echo '*' '$HOME'"},
		{[]string{"echo", "…"}, "echo '…'"},
	}
	for _, tt := range tests {
		if got := quoteArgs(tt.argv); got != tt.want {
			t.Errorf("quoteArgs(%q) = %q, want %q", tt.argv, got, tt.want)
		}
		if CommandCut(quoteArgs(tt.argv)) {
			t.Errorf("CommandCut(%q) = true", quoteArgs(tt.argv))
		}
	}

	long := quoteArgs([]string{"echo", strings.Repeat("a", 5000)})
	if !CommandCut(long) || len(long) > maxCommandLine+len(commandEllipsis) || !strings.HasPrefix(long, "echo aaa") {
		t.Errorf("a long line is not cut: %d bytes, cut %v", len(long), CommandCut(long))
	}
	// Cut inside a multi-byte rune: the line stays valid UTF-8.
	wide := quoteArgs([]string{"echo", "'" + strings.Repeat("é", 3000)})
	if !CommandCut(wide) || !utf8.ValidString(wide) {
		t.Errorf("a cut wide line: cut %v, valid %v", CommandCut(wide), utf8.ValidString(wide))
	}
}

// What one facts sample costs (docs/notes/shell-5-terminal.md): the cwd, and a running
// job's command line.
func BenchmarkCwdOf(b *testing.B) {
	pid := os.Getpid()
	for b.Loop() {
		if _, err := cwdOf(pid); err != nil {
			b.Fatal(err)
		}
	}
}

func BenchmarkGroupCommand(b *testing.B) {
	cmd := exec.Command("/bin/sleep", "600")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		b.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	for b.Loop() {
		if groupCommand(cmd.Process.Pid) == "" {
			b.Fatal("no command")
		}
	}
}
