// Package procscan finds the user's processes that run in a directory, and stops
// process groups: what a thread's Claude left running in its worktree after it ended
// (a dev server a Bash call put in the background). Claude Code starts each Bash call
// in a process group of its own, so a background process outlives Claude, re-parented
// to launchd, outside Claude's group; its working directory is what still ties it to
// the thread (docs/notes/ember-fixes-2-small.md).
//
// macOS only: the process table comes from sysctl kern.proc.uid, each executable from
// kern.procargs2 (macOS hides other processes' environments, but not that), and the
// working directories from lsof (one call for every candidate).
package procscan

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Proc is one process.
type Proc struct {
	PID, PPID, PGID int
	Start           time.Time
	// Exe is the executable's path; "" when it could not be read.
	Exe string
	// Cwd is the working directory; "" when it could not be read.
	Cwd string
}

// Name is the executable's base name, or "pid N".
func (p Proc) Name() string {
	if p.Exe != "" {
		return filepath.Base(p.Exe)
	}
	return "pid " + strconv.Itoa(p.PID)
}

// List returns the current user's processes, without Exe and Cwd.
func List() ([]Proc, error) {
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil {
		return nil, fmt.Errorf("procscan: list processes: %w", err)
	}
	out := make([]Proc, 0, len(kps))
	for _, kp := range kps {
		out = append(out, Proc{
			PID: int(kp.Proc.P_pid), PPID: int(kp.Eproc.Ppid), PGID: int(kp.Eproc.Pgid),
			Start: time.Unix(kp.Proc.P_starttime.Sec, int64(kp.Proc.P_starttime.Usec)*1000),
		})
	}
	return out, nil
}

// In returns the user's processes for which pick (given a Proc without Exe and Cwd)
// is true and whose working directory is dir or below it, with Exe and Cwd. dir is
// compared with its symlinks resolved.
func In(ctx context.Context, dir string, pick func(Proc) bool) ([]Proc, error) {
	if dir == "" {
		return nil, nil
	}
	if r, err := filepath.EvalSymlinks(dir); err == nil {
		dir = r
	}
	all, err := List()
	if err != nil {
		return nil, err
	}
	var cand []Proc
	for _, p := range all {
		if pick == nil || pick(p) {
			cand = append(cand, p)
		}
	}
	if len(cand) == 0 {
		return nil, nil
	}
	cwds, err := cwdsOf(ctx, cand)
	if err != nil {
		return nil, err
	}
	var out []Proc
	for _, p := range cand {
		p.Cwd = cwds[p.PID]
		if !Inside(p.Cwd, dir) {
			continue
		}
		p.Exe = exeOf(p.PID)
		out = append(out, p)
	}
	return out, nil
}

// Inside reports whether p is root or below it. Both are cleaned absolute paths.
func Inside(p, root string) bool {
	if p == "" || root == "" {
		return false
	}
	root = filepath.Clean(root)
	return p == root || strings.HasPrefix(p, strings.TrimSuffix(root, "/")+"/")
}

// cwdsOf reads the working directories of procs with one lsof call: pid to path.
func cwdsOf(ctx context.Context, procs []Proc) (map[int]string, error) {
	pids := make([]string, len(procs))
	for i, p := range procs {
		pids[i] = strconv.Itoa(p.PID)
	}
	cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// -a: and the selections; -d cwd: only the cwd; -F pn: machine output; -w: no
	// warnings. lsof exits 1 when some pid is gone meanwhile: what it printed holds.
	out, err := exec.CommandContext(cctx, "/usr/sbin/lsof", "-w", "-a", "-d", "cwd", "-Fpn", "-p", strings.Join(pids, ",")).Output()
	var exit *exec.ExitError
	if err != nil && !errors.As(err, &exit) {
		return nil, fmt.Errorf("procscan: lsof: %w", err)
	}
	return parseLsof(out), nil
}

// parseLsof reads lsof -Fpn output: a "p<pid>" line, then "n<path>" for its cwd.
func parseLsof(out []byte) map[int]string {
	res := map[int]string{}
	pid := 0
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 1<<20)
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			continue
		}
		switch line[0] {
		case 'p':
			pid, _ = strconv.Atoi(line[1:])
		case 'n':
			if pid > 0 {
				res[pid] = line[1:]
			}
		}
	}
	return res
}

// exeOf is pid's executable path from kern.procargs2 (argc, then the path), "" when
// unreadable.
func exeOf(pid int) string {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil || len(b) < 5 {
		return ""
	}
	b = b[4:]
	if i := bytes.IndexByte(b, 0); i > 0 {
		return string(b[:i])
	}
	return ""
}

// StopGroups sends SIGTERM to each process group in pgids, then SIGKILL after grace to
// the groups that still have a process; it returns once that is done (or ctx ends).
// A group that is gone is skipped. Groups at or below 1, and the caller's own, are
// never signalled.
func StopGroups(ctx context.Context, pgids []int, grace time.Duration) {
	self := syscall.Getpgrp()
	var live []int
	for _, g := range pgids {
		if g <= 1 || g == self {
			continue
		}
		if syscall.Kill(-g, syscall.SIGTERM) == nil {
			live = append(live, g)
		}
	}
	if len(live) == 0 {
		return
	}
	t := time.NewTimer(grace)
	defer t.Stop()
	select {
	case <-t.C:
	case <-ctx.Done():
	}
	for _, g := range live {
		_ = syscall.Kill(-g, syscall.SIGKILL)
	}
}
