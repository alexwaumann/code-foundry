package procscan

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"reflect"
	"slices"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func TestParseListen(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want map[int][]Listener
	}{
		{"empty", "", map[int][]Listener{}},
		{"IPv4 loopback", "p10\ng10\nf3\ntIPv4\nn127.0.0.1:9398\n", map[int][]Listener{10: {{"127.0.0.1", 9398, "IPv4"}}}},
		{"any address", "p10\ng10\nf4\ntIPv6\nn*:3000\n", map[int][]Listener{10: {{"*", 3000, "IPv6"}}}},
		{"IPv6 loopback", "p10\ng10\nf5\ntIPv6\nn[::1]:5173\n", map[int][]Listener{10: {{"[::1]", 5173, "IPv6"}}}},
		{"two families, one port", "p10\ng10\nf3\ntIPv4\nn127.0.0.1:5173\nf4\ntIPv6\nn[::1]:5173\n",
			map[int][]Listener{10: {{"127.0.0.1", 5173, "IPv4"}, {"[::1]", 5173, "IPv6"}}}},
		{"two processes of a group", "p10\ng10\nf3\ntIPv4\nn*:8080\np11\ng10\nf7\ntIPv4\nn*:8081\n",
			map[int][]Listener{10: {{"*", 8080, "IPv4"}, {"*", 8081, "IPv4"}}}},
		{"a forked worker repeats its parent's socket", "p10\ng10\nf3\ntIPv4\nn*:8080\np11\ng10\nf3\ntIPv4\nn*:8080\n",
			map[int][]Listener{10: {{"*", 8080, "IPv4"}}}},
		{"two groups", "p10\ng10\nf3\ntIPv4\nn*:1\np20\ng20\nf3\ntIPv4\nn*:2\n", map[int][]Listener{10: {{"*", 1, "IPv4"}}, 20: {{"*", 2, "IPv4"}}}},
		{"no group yet", "p10\nf3\ntIPv4\nn*:1\n", map[int][]Listener{}},
		{"no port", "p10\ng10\nf3\ntIPv4\nn*:*\nf4\nnlocalhost\n", map[int][]Listener{}},
		{"a port out of range", "p10\ng10\nf3\nn*:70000\n", map[int][]Listener{}},
		{"family reset per file", "p10\ng10\nf3\ntIPv6\nn*:1\nf4\nn*:2\n", map[int][]Listener{10: {{"*", 1, "IPv6"}, {"*", 2, ""}}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseListen([]byte(tt.out)); !reflect.DeepEqual(got, tt.want) {
				t.Errorf("parseListen = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestPorts(t *testing.T) {
	tests := []struct {
		name string
		ls   []Listener
		want []int
	}{
		{"none", nil, nil},
		{"one", []Listener{{"*", 3000, "IPv4"}}, []int{3000}},
		{"loopbacks and any are one port", []Listener{{"*", 3000, "IPv6"}, {"127.0.0.1", 3000, "IPv4"}, {"[::1]", 3000, "IPv6"}}, []int{3000}},
		{"distinct ports keep their order", []Listener{{"*", 5173, "IPv4"}, {"*", 24678, "IPv4"}, {"[::1]", 5173, "IPv6"}}, []int{5173, 24678}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Ports(tt.ls); !slices.Equal(got, tt.want) {
				t.Errorf("Ports = %v, want %v", got, tt.want)
			}
		})
	}
}

// ListeningIn finds a child's listening socket by its process group; Stdouts reads its
// standard output; Children lists it.
func TestListeningInLive(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	cmd := exec.Command(py, "-c", "import socket,time;s=socket.socket();s.bind(('127.0.0.1',"+strconv.Itoa(port)+"));s.listen();time.sleep(30)")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	pgid := cmd.Process.Pid
	ctx := context.Background()
	var got map[int][]Listener
	for range 50 {
		if got, err = ListeningIn(ctx, []int{pgid, 999999}); err != nil {
			t.Fatal(err)
		}
		if len(got[pgid]) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if ps := Ports(got[pgid]); !slices.Equal(ps, []int{port}) {
		t.Fatalf("ports of %d = %v, want [%d] (%v)", pgid, ps, port, got)
	}
	kids, err := Children(syscall.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.ContainsFunc(kids, func(p Proc) bool { return p.PID == pgid && p.PGID == pgid }) {
		t.Errorf("Children = %v, want %d leading its group", kids, pgid)
	}
	outs, err := Stdouts(ctx, []int{pgid})
	if err != nil {
		t.Fatal(err)
	}
	if outs[pgid] == "" {
		t.Errorf("Stdouts = %v, want one for %d", outs, pgid)
	}
	if got, err := ListeningIn(ctx, []int{999999}); err != nil || len(got) != 0 {
		t.Errorf("ListeningIn(gone) = %v, %v; want empty", got, err)
	}
}

func TestTreeGroups(t *testing.T) {
	const self = 50
	tests := []struct {
		name  string
		procs []Proc
		roots []int
		want  map[int][]int
	}{
		{"no roots", []Proc{{PID: 10, PPID: 1, PGID: 10}}, nil, map[int][]int{}},
		{"the root's group is there even when its leader is gone", nil, []int{10}, map[int][]int{10: {10}}},
		{"children in the root's group add nothing",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 11, PPID: 10, PGID: 10}, {PID: 12, PPID: 11, PGID: 10}},
			[]int{10}, map[int][]int{10: {10}}},
		{"a detached child: its own group, its parent in the tree",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 11, PPID: 10, PGID: 10}, {PID: 20, PPID: 11, PGID: 20}},
			[]int{10}, map[int][]int{10: {10, 20}}},
		{"a job-control shell: one group per job",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 20, PPID: 10, PGID: 20}, {PID: 30, PPID: 10, PGID: 30}},
			[]int{10}, map[int][]int{10: {10, 20, 30}}},
		{"a group member orphaned to launchd keeps its children in",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 11, PPID: 1, PGID: 10}, {PID: 20, PPID: 11, PGID: 20}},
			[]int{10}, map[int][]int{10: {10, 20}}},
		{"a member of a descendant's group, orphaned, keeps its children in",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 20, PPID: 10, PGID: 20}, {PID: 21, PPID: 1, PGID: 20}, {PID: 30, PPID: 21, PGID: 30}},
			[]int{10}, map[int][]int{10: {10, 20, 30}}},
		{"a double fork and setsid: no tie left",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 20, PPID: 1, PGID: 20}},
			[]int{10}, map[int][]int{10: {10}}},
		{"two trees stay apart",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 11, PPID: 10, PGID: 11}, {PID: 20, PPID: 2, PGID: 20}, {PID: 21, PPID: 20, PGID: 21}},
			[]int{10, 20}, map[int][]int{10: {10, 11}, 20: {20, 21}}},
		{"launchd's and the daemon's groups are not followed",
			[]Proc{{PID: 10, PPID: 2, PGID: 10}, {PID: 11, PPID: 10, PGID: self}, {PID: 12, PPID: 10, PGID: 1},
				{PID: self, PPID: 2, PGID: self}, {PID: 13, PPID: self, PGID: 13}, {PID: 14, PPID: 1, PGID: 1}, {PID: 15, PPID: 14, PGID: 15}},
			[]int{10}, map[int][]int{10: {10}}},
		{"a root that is launchd or the daemon is none", []Proc{{PID: 10, PPID: 1, PGID: 10}}, []int{0, 1, self}, map[int][]int{}},
		{"a ppid cycle ends", []Proc{{PID: 10, PPID: 11, PGID: 10}, {PID: 11, PPID: 10, PGID: 11}}, []int{10}, map[int][]int{10: {10, 11}}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := treeGroups(tt.procs, tt.roots, self)
			for _, gs := range got {
				slices.Sort(gs)
			}
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("treeGroups = %v, want %v", got, tt.want)
			}
		})
	}
}

// ListeningUnder finds what a group probe misses: a listener its parent started in a
// session of its own, as node's detached spawn does.
func TestListeningUnderLive(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("no python3")
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	listener := "import socket,time;s=socket.socket();s.bind(('127.0.0.1'," + strconv.Itoa(port) + "));s.listen();time.sleep(30)"
	parent := "import subprocess,sys,time;p=subprocess.Popen([sys.executable,'-c'," + strconv.Quote(listener) + "],start_new_session=True);print(p.pid,flush=True);time.sleep(30)"
	cmd := exec.Command(py, "-c", parent)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	var child int
	if _, err := fmt.Fscan(out, &child); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-child, syscall.SIGKILL) })
	root := cmd.Process.Pid
	ctx := context.Background()
	var got map[int][]Listener
	for range 50 {
		if got, err = ListeningUnder(ctx, []int{root, 999999}); err != nil {
			t.Fatal(err)
		}
		if len(got[root]) > 0 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if ps := Ports(got[root]); !slices.Equal(ps, []int{port}) {
		t.Fatalf("ports under %d = %v, want [%d] (%v)", root, ps, port, got)
	}
	byGroup, err := ListeningIn(ctx, []int{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(byGroup) != 0 {
		t.Errorf("the root's own group listens on %v: the child did not leave it", byGroup)
	}
}
