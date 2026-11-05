package fsx

import "golang.org/x/sys/unix"

// NoFollowAny makes an open fail on a symlink anywhere in the path, for a path with its links
// already resolved: a link swapped in since then is no way elsewhere.
const NoFollowAny = unix.O_NOFOLLOW_ANY
