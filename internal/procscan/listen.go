package procscan

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Listening ports and standard outputs: what a thread's background shell or an action's
// run serves, and which of Claude's children a shell is (docs/notes/thread-servers.md,
// docs/notes/action-run-ports.md). Each is one lsof call however many processes it covers.

// Listener is one TCP socket a process listens on.
type Listener struct {
	// Host is the address as lsof prints it: "*", "127.0.0.1", "[::1]".
	Host string
	Port int
	// Family is "IPv4" or "IPv6".
	Family string
}

// lsofTimeout bounds one lsof call.
const lsofTimeout = 10 * time.Second

// ListeningIn returns the TCP sockets the processes of each process group in pgids
// listen on, by process group. A group that is gone, or listens on nothing, is absent.
// An error is lsof failing to run (missing, killed, timed out), not finding nothing.
func ListeningIn(ctx context.Context, pgids []int) (map[int][]Listener, error) {
	if len(pgids) == 0 {
		return map[int][]Listener{}, nil
	}
	gs := make([]string, len(pgids))
	for i, g := range pgids {
		gs[i] = strconv.Itoa(g)
	}
	// -n -P: numeric hosts and ports; -i TCP -s TCP:LISTEN: listening TCP sockets; -a: and
	// the groups (-g); -F pgtn: pid, group, family, name. Exit 1 is "nothing found".
	out, err := lsof(ctx, "-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-g", strings.Join(gs, ","), "-Fpgtn")
	if err != nil {
		return nil, err
	}
	return parseListen(out), nil
}

// ListeningUnder returns the TCP sockets each process tree in roots listens on, by root:
// one sysctl and one lsof call however many roots. A tree is what treeGroups says, so a
// child that left its parent's group (node's detached spawn, Python's start_new_session)
// counts. A root listening on nothing is absent. An error is as for ListeningIn.
func ListeningUnder(ctx context.Context, roots []int) (map[int][]Listener, error) {
	if len(roots) == 0 {
		return map[int][]Listener{}, nil
	}
	procs, err := List()
	if err != nil {
		return nil, err
	}
	groups := treeGroups(procs, roots, syscall.Getpgrp())
	var all []int
	for _, gs := range groups {
		all = append(all, gs...)
	}
	slices.Sort(all)
	byGroup, err := ListeningIn(ctx, slices.Compact(all))
	if err != nil {
		return nil, err
	}
	res := make(map[int][]Listener, len(roots))
	for root, gs := range groups {
		for _, g := range gs {
			for _, l := range byGroup[g] {
				if !slices.Contains(res[root], l) {
					res[root] = append(res[root], l)
				}
			}
		}
	}
	return res, nil
}

// treeGroups returns the process groups of each root's tree, the root's own group (the
// root's pid: it leads one) first. A tree is the root's group, every descendant of a
// member, and the whole group of every such descendant, until nothing new turns up; so
// a member whose parent exited (re-parented to launchd, still in the group) keeps its
// own children in. A process that left the group and lost its parent too (a double fork
// and setsid) has no tie left to the tree and is not found. Groups at or below 1 and
// self (the daemon's own) are never followed.
func treeGroups(procs []Proc, roots []int, self int) map[int][]int {
	kids := map[int][]Proc{}
	members := map[int][]Proc{}
	for _, p := range procs {
		kids[p.PPID] = append(kids[p.PPID], p)
		members[p.PGID] = append(members[p.PGID], p)
	}
	res := make(map[int][]int, len(roots))
	for _, root := range roots {
		if root <= 1 || root == self {
			continue
		}
		groups := []int{root}
		seen := map[int]bool{}
		todo := slices.Clone(members[root])
		for len(todo) > 0 {
			p := todo[len(todo)-1]
			todo = todo[:len(todo)-1]
			if seen[p.PID] {
				continue
			}
			seen[p.PID] = true
			todo = append(todo, kids[p.PID]...)
			if p.PGID > 1 && p.PGID != self && !slices.Contains(groups, p.PGID) {
				groups = append(groups, p.PGID)
				todo = append(todo, members[p.PGID]...)
			}
		}
		res[root] = groups
	}
	return res
}

// Stdouts returns the standard output (file descriptor 1) of each of pids that has one,
// by pid: a path, or a description lsof gives ("pipe", "/dev/null").
func Stdouts(ctx context.Context, pids []int) (map[int]string, error) {
	if len(pids) == 0 {
		return map[int]string{}, nil
	}
	ps := make([]string, len(pids))
	for i, p := range pids {
		ps[i] = strconv.Itoa(p)
	}
	out, err := lsof(ctx, "-a", "-d", "1", "-Fpn", "-p", strings.Join(ps, ","))
	if err != nil {
		return nil, err
	}
	return parseLsof(out), nil
}

// Children returns the current user's processes whose parent is ppid.
func Children(ppid int) ([]Proc, error) {
	all, err := List()
	if err != nil {
		return nil, err
	}
	var out []Proc
	for _, p := range all {
		if p.PPID == ppid {
			out = append(out, p)
		}
	}
	return out, nil
}

// lsof runs /usr/sbin/lsof -w with args (no shell). lsof exits 1 when a selection
// matched nothing or a process went away meanwhile: what it printed holds.
func lsof(ctx context.Context, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, lsofTimeout)
	defer cancel()
	out, err := exec.CommandContext(cctx, "/usr/sbin/lsof", append([]string{"-w"}, args...)...).Output()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 1) {
		return nil, fmt.Errorf("procscan: lsof: %w", err)
	}
	return out, nil
}

// parseListen reads lsof -F pgtn output: "p<pid>", "g<pgid>", then per file "f<fd>",
// "t<IPv4|IPv6>" and "n<host>:<port>". A name without a port is skipped, and a group
// lists each socket once.
func parseListen(out []byte) map[int][]Listener {
	res := map[int][]Listener{}
	pgid := 0
	family := ""
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pgid, family = 0, ""
		case 'g':
			pgid, _ = strconv.Atoi(line[1:])
		case 'f':
			family = ""
		case 't':
			family = line[1:]
		case 'n':
			i := strings.LastIndexByte(line, ':')
			if pgid <= 0 || i < 2 {
				continue
			}
			port, err := strconv.Atoi(line[i+1:])
			if err != nil || port <= 0 || port > 65535 {
				continue
			}
			l := Listener{Host: line[1:i], Port: port, Family: family}
			if !slices.Contains(res[pgid], l) {
				res[pgid] = append(res[pgid], l)
			}
		}
	}
	return res
}

// Ports returns the distinct ports of ls in their order: "*:3000", "127.0.0.1:3000" and
// "[::1]:3000" are one port (localhost:3000 to a browser).
func Ports(ls []Listener) []int {
	var out []int
	for _, l := range ls {
		if !slices.Contains(out, l.Port) {
			out = append(out, l.Port)
		}
	}
	return out
}
