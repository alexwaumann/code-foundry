package fsx

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

// OpenTree opens dir (cleaned), the temp folder top or a folder below it, as a Root: what is
// opened through it stays in that folder, whatever is planted or swapped in there. Anything
// on the machine can write to a temp folder, so the way down to dir is walked one name at a
// time and follows no link, and a name that is no longer a folder fails rather than leads
// somewhere else. top itself is the system's and may be spelled through links (/tmp).
func OpenTree(top, dir string) (*os.Root, error) {
	fd, err := openNoFollow(top, below(top, dir))
	if err != nil {
		return nil, fmt.Errorf("fsx: open %s: %w", dir, err)
	}
	defer func() { _ = unix.Close(fd) }()
	// By descriptor: os.OpenRoot opens a path with no O_NONBLOCK, which a FIFO swapped in at
	// dir would block forever, and it follows links.
	return os.OpenRoot(fmt.Sprintf("/dev/fd/%d", fd))
}

// openNoFollow opens the folder rel ("." or names joined by "/") below top.
func openNoFollow(top, rel string) (int, error) {
	const flags = unix.O_RDONLY | unix.O_DIRECTORY | unix.O_NONBLOCK | unix.O_CLOEXEC
	fd, err := noEINTR(func() (int, error) { return unix.Open(top, flags, 0) })
	if err != nil || rel == "." {
		return fd, err
	}
	for name := range strings.SplitSeq(rel, "/") {
		next, err := noEINTR(func() (int, error) { return unix.Openat(fd, name, flags|unix.O_NOFOLLOW, 0) })
		_ = unix.Close(fd)
		if err != nil {
			return -1, err
		}
		fd = next
	}
	return fd, nil
}

// noEINTR is open, again if a signal cut it short.
func noEINTR(open func() (int, error)) (int, error) {
	for {
		fd, err := open()
		if !errors.Is(err, syscall.EINTR) {
			return fd, err
		}
	}
}

// below is p relative to root, which holds it (Within), "." when p is root.
func below(root, p string) string {
	if rel := strings.TrimPrefix(p[len(root):], "/"); rel != "" {
		return rel
	}
	return "."
}
