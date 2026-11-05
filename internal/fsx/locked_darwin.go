package fsx

import (
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// locked reports whether p has a flag that makes it refuse changes with EPERM, the same
// errno macOS's privacy protection gives: Finder's Locked (uchg), and its append-only and
// system relations.
func locked(p string) bool {
	fi, err := os.Lstat(p)
	if err != nil {
		return false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	return ok && st.Flags&(unix.UF_IMMUTABLE|unix.UF_APPEND|unix.SF_IMMUTABLE|unix.SF_APPEND) != 0
}
