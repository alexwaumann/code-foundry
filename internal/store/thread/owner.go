package thread

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fsx"
)

// Owned threads (docs/notes/plugins-6-thread-terminal.md): a thread someone other than
// the user owns, a plugin's ("plugin:<name>", thread/create). The store treats the owner
// as an opaque tag set once at Create: an owned thread runs, stops at cache expiry,
// starts on a message and counts its usage like any other, but a filtered List leaves it
// out unless asked (ListOptions.Owner, All), and clients hide it from the user's lists.
// Its creator gives it a cwd of its own (CreateOptions.Cwd) rather than the home dir.

// ownerPattern is an owner tag: a kind, a colon, a name ("plugin:gh-actions").
var ownerPattern = regexp.MustCompile(`^[a-z]+:[a-z0-9][a-z0-9-]{0,63}$`)

// checkOwner validates CreateOptions.Owner.
func checkOwner(o CreateOptions) (string, error) {
	owner := strings.TrimSpace(o.Owner)
	switch {
	case owner == "":
		return "", nil
	case !ownerPattern.MatchString(owner):
		return "", fmt.Errorf("%w: owner %q: want kind:name (plugin:hello)", ErrInvalidArgument, o.Owner)
	case o.CreatedBy != "":
		return "", fmt.Errorf("%w: an owned thread is not created by another thread", ErrInvalidArgument)
	}
	return owner, nil
}

// noProjectCwd is the cwd of a thread without a project: Options.Home, or cwd, which
// must be an existing directory inside it.
func (m *Manager) noProjectCwd(cwd string) (string, error) {
	if cwd == "" {
		return m.opts.Home, nil
	}
	if !filepath.IsAbs(cwd) {
		return "", fmt.Errorf("%w: cwd %q is not an absolute path", ErrInvalidArgument, cwd)
	}
	cwd = filepath.Clean(cwd)
	if !fsx.Within(m.opts.Home, cwd) {
		return "", fmt.Errorf("%w: cwd %s is outside your home directory", ErrInvalidArgument, cwd)
	}
	if fi, err := os.Stat(cwd); err != nil || !fi.IsDir() {
		return "", fmt.Errorf("%w: cwd %s is not a directory", ErrInvalidArgument, cwd)
	}
	return cwd, nil
}

// ownerMatches reports whether a thread owned by owner ("" for the user's) is in the
// list o asks for.
func (o ListOptions) ownerMatches(owner string) bool {
	switch {
	case o.Owner == "":
		return owner == "" || o.All
	case strings.HasSuffix(o.Owner, ":"):
		return strings.HasPrefix(owner, o.Owner)
	default:
		return owner == o.Owner
	}
}

// Owned returns the threads owned by owner (or, ending in ":", any owner with that
// prefix), archived ones too, in creation order.
func (s *Snapshot) Owned(owner string) []Thread {
	if s == nil || owner == "" {
		return nil
	}
	o := ListOptions{Owner: owner}
	var out []Thread
	for _, t := range s.Threads {
		if o.ownerMatches(t.Owner) {
			out = append(out, t)
		}
	}
	return out
}
