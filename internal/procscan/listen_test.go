package procscan

import (
	"context"
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
