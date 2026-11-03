// Package capability is the daemon's scoped credentials (docs/notes/search-5-agent-daemon.md):
// a bearer token that is not the daemon's token and lets its holder do only what its
// Scope allows, until it is revoked or expires.
//
// Agent search's hidden run carries one instead of the daemon token, so the CLI inside it
// can search and read threads and report hits for its own search and nothing else, even
// when the user's Claude settings allow it more commands (a `Bash(code-foundry *)` rule):
// a prompt injection in a transcript cannot use the CLI to start a thread, send a
// message or change a setting.
//
// The loopback listener's auth (internal/daemon) looks a token up here: the daemon's own
// token passes as before, a scoped one passes only for AllowProcedure's procedures and
// with its Scope in the request context, where the command handler (internal/api) checks
// AllowCommand before it invokes anything.
package capability

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// ErrDenied is a scoped token's refusal.
var ErrDenied = errors.New("not allowed for agent search's credential")

// TokenPrefix starts every scoped token, so one is told from the daemon token at a glance
// (in a log line, never the token itself).
const TokenPrefix = "cfcap_"

// Scope is what a scoped token may do.
type Scope struct {
	// Search is the agent search the token belongs to: thread.search, thread.read and
	// search.report with --search Search.
	Search string
}

// procedures are the RPCs a scoped token may call: what the CLI needs to run a verb (its
// reachability probe, the command list it parses flags from, and Invoke). Invoke is then
// limited by AllowCommand.
var procedures = map[string]bool{
	codefoundryv1connect.HealthServicePingProcedure:    true,
	codefoundryv1connect.CommandServiceListProcedure:   true,
	codefoundryv1connect.CommandServiceInvokeProcedure: true,
}

// AllowProcedure reports whether a scoped token may call the procedure at path (an HTTP
// request path, /codefoundry.v1.Service/Method). Every other path, Connect or not, is
// refused.
func (s Scope) AllowProcedure(path string) bool { return procedures[path] }

// readCommands are the read-only commands a search's run uses.
var readCommands = map[string]bool{"thread.search": true, "thread.read": true}

// AllowCommand reports, as nil or an ErrDenied error, whether a scoped token may invoke
// command name with args: thread.search and thread.read (read-only), and search.report
// for its own search only.
func (s Scope) AllowCommand(name string, args map[string]string) error {
	switch {
	case s.Search == "":
	case readCommands[name]:
		return nil
	case name == "search.report":
		if args["search"] == s.Search {
			return nil
		}
		return fmt.Errorf("%w: search.report for another search than %s", ErrDenied, s.Search)
	}
	return fmt.Errorf("%w: %s (agent search may only run thread.search, thread.read and search.report)", ErrDenied, name)
}

type scopeKey struct{}

// WithScope is ctx for a request made with a scoped token.
func WithScope(ctx context.Context, s Scope) context.Context {
	return context.WithValue(ctx, scopeKey{}, s)
}

// FromContext is the scope of the request ctx belongs to; false for the daemon token (or
// any in-process caller).
func FromContext(ctx context.Context) (Scope, bool) {
	s, ok := ctx.Value(scopeKey{}).(Scope)
	return s, ok
}

// Registry holds the scoped tokens issued and not yet revoked. Tokens are kept by their
// SHA-256, so a lookup compares no secret byte by byte.
type Registry struct {
	now func() time.Time

	mu     sync.Mutex
	grants map[[sha256.Size]byte]grant
}

type grant struct {
	scope   Scope
	expires time.Time
}

// NewRegistry returns an empty registry; now is the clock (nil: time.Now).
func NewRegistry(now func() time.Time) *Registry {
	if now == nil {
		now = time.Now
	}
	return &Registry{now: now, grants: map[[sha256.Size]byte]grant{}}
}

// Issue makes a token for scope that expires after ttl at the latest; revoke ends it
// sooner (idempotent).
func (r *Registry) Issue(scope Scope, ttl time.Duration) (token string, revoke func(), err error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", nil, fmt.Errorf("capability token: %w", err)
	}
	token = TokenPrefix + hex.EncodeToString(b[:])
	key := sha256.Sum256([]byte(token))
	r.mu.Lock()
	r.grants[key] = grant{scope: scope, expires: r.now().Add(ttl)}
	r.mu.Unlock()
	return token, func() {
		r.mu.Lock()
		delete(r.grants, key)
		r.mu.Unlock()
	}, nil
}

// Lookup is token's scope; false when it was never issued, was revoked or has expired.
func (r *Registry) Lookup(token string) (Scope, bool) {
	if r == nil || token == "" {
		return Scope{}, false
	}
	key := sha256.Sum256([]byte(token))
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.grants[key]
	if !ok {
		return Scope{}, false
	}
	if !r.now().Before(g.expires) {
		delete(r.grants, key)
		return Scope{}, false
	}
	return g.scope, true
}
