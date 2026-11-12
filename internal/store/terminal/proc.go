package terminal

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Reading another process's working directory and command line, for the facts
// (facts.go). macOS only, and no cgo: the working directory comes from the proc_info
// system call (what libproc's proc_pidinfo wraps), the command line from the
// kern.procargs2 sysctl (what ps reads), a process group's members from kern.proc.pgrp.
// Each is one system call of a few microseconds; nothing is spawned.

// proc_info(2) arguments: PROC_INFO_CALL_PIDINFO with the PROC_PIDVNODEPATHINFO flavour,
// which fills a struct proc_vnodepathinfo: the current directory's struct
// vnode_info_path (a 152-byte struct vnode_info, then a MAXPATHLEN path), then the root
// directory's.
const (
	procInfoCallPidinfo   = 2
	procPidVnodePathInfo  = 9
	vnodeInfoSize         = 152
	maxPathLen            = 1024
	vnodePathInfoSize     = vnodeInfoSize + maxPathLen
	procVnodePathInfoSize = 2 * vnodePathInfoSize
)

// cwdOf returns process pid's current working directory.
func cwdOf(pid int) (string, error) {
	if pid <= 0 {
		return "", fmt.Errorf("cwd of pid %d: %w", pid, unix.ESRCH)
	}
	var buf [procVnodePathInfoSize]byte
	// x/sys deprecates the darwin syscall numbers in favour of libSystem wrappers; the
	// wrapper here is libproc's proc_pidinfo, which would need cgo outside its owning
	// goroutine. proc_info has been 336 since 10.5, and TestCwdOf pins the call.
	//lint:ignore SA1019 no cgo wrapper for proc_pidinfo; see above
	n, _, errno := unix.Syscall6(unix.SYS_PROC_INFO, procInfoCallPidinfo, uintptr(pid), procPidVnodePathInfo, 0,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if errno != 0 {
		return "", fmt.Errorf("cwd of pid %d: %w", pid, errno)
	}
	if int(n) != len(buf) {
		return "", fmt.Errorf("cwd of pid %d: proc_info returned %d bytes, want %d", pid, n, len(buf))
	}
	path := buf[vnodeInfoSize:vnodePathInfoSize]
	if i := bytes.IndexByte(path, 0); i >= 0 {
		path = path[:i]
	}
	if len(path) == 0 {
		return "", fmt.Errorf("cwd of pid %d: empty path", pid)
	}
	return string(path), nil
}

// maxCommandLine caps a published command line. A longer one is cut and ends in "…",
// which a quoted line never does (quoteArg quotes any non-ASCII byte), so a cut line can
// be told apart: CommandCut.
const maxCommandLine = 4096

// commandEllipsis ends a command line cut at maxCommandLine.
const commandEllipsis = "…"

// CommandCut reports whether a command line (Terminal.Foreground, LastCommand) was cut
// at its cap, so it cannot be run again as is.
func CommandCut(line string) bool { return strings.HasSuffix(line, commandEllipsis) }

// groupCommand returns the command line of process group pg's job: its leader's argv
// (a job-control shell makes a pipeline's first process the leader), else, once the
// leader has gone, the oldest member's. A process whose arguments cannot be read (one
// owned by root, such as sudo) gives its short name. "" when the group is empty.
func groupCommand(pg int) string {
	if pg <= 0 {
		return ""
	}
	if line, err := commandLine(pg); err == nil {
		return line
	}
	kps, err := unix.SysctlKinfoProcSlice("kern.proc.pgrp", pg)
	if err != nil || len(kps) == 0 {
		return ""
	}
	slices.SortFunc(kps, func(a, b unix.KinfoProc) int {
		if c := a.Proc.P_starttime.Sec - b.Proc.P_starttime.Sec; c != 0 {
			return int(c)
		}
		return int(a.Proc.P_starttime.Usec - b.Proc.P_starttime.Usec)
	})
	for _, kp := range kps {
		pid := int(kp.Proc.P_pid)
		if line, err := commandLine(pid); err == nil {
			return line
		}
		if name := unix.ByteSliceToString(kp.Proc.P_comm[:]); name != "" {
			return quoteArg(name)
		}
	}
	return ""
}

// commandLine is pid's argv from kern.procargs2, quoted for a shell (quoteArgs).
func commandLine(pid int) (string, error) {
	b, err := unix.SysctlRaw("kern.procargs2", pid)
	if err != nil {
		return "", err
	}
	argv, err := parseProcargs(b)
	if err != nil {
		return "", fmt.Errorf("pid %d: %w", pid, err)
	}
	return quoteArgs(argv), nil
}

// parseProcargs reads kern.procargs2: argc (a 32-bit int), the executable's path and its
// NUL padding, then argc NUL-terminated arguments (the environment follows).
func parseProcargs(b []byte) ([]string, error) {
	if len(b) < 4 {
		return nil, errors.New("procargs2: too short")
	}
	argc := int(binary.LittleEndian.Uint32(b))
	b = b[4:]
	i := bytes.IndexByte(b, 0)
	if i < 0 {
		return nil, errors.New("procargs2: no executable path")
	}
	b = b[i:]
	for len(b) > 0 && b[0] == 0 {
		b = b[1:]
	}
	argv := make([]string, 0, min(argc, 64))
	for range argc {
		if len(b) == 0 {
			break
		}
		j := bytes.IndexByte(b, 0)
		if j < 0 {
			argv = append(argv, string(b))
			break
		}
		argv = append(argv, string(b[:j]))
		b = b[j+1:]
	}
	if len(argv) == 0 {
		return nil, errors.New("procargs2: no arguments")
	}
	return argv, nil
}

// quoteArgs joins argv into a line a POSIX shell reads back as argv (quoteArg), cut at
// maxCommandLine.
func quoteArgs(argv []string) string {
	var sb strings.Builder
	for i, a := range argv {
		if i > 0 {
			sb.WriteByte(' ')
		}
		sb.WriteString(quoteArg(a))
		if sb.Len() > maxCommandLine {
			break
		}
	}
	s := sb.String()
	if len(s) <= maxCommandLine {
		return s
	}
	k := maxCommandLine // s[k] is the first byte left out: back up to a whole rune
	for k > 0 && !utf8.RuneStart(s[k]) {
		k--
	}
	return s[:k] + commandEllipsis
}

// quoteArg is a as one shell word: as is when it is made only of characters no shell
// treats specially, else in single quotes (a quote inside as '\”).
func quoteArg(a string) string {
	if a == "" {
		return "''"
	}
	safe := true
	for i := 0; i < len(a); i++ {
		c := a[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte("@%+=:,./-_", c) >= 0) {
			safe = false
			break
		}
	}
	if safe {
		return a
	}
	return "'" + strings.ReplaceAll(a, "'", `'\''`) + "'"
}
