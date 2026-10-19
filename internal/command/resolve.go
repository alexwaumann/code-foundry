package command

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Id suffixes (docs/notes/agents-5-cli.md). An arg whose spec names an IDKind takes the
// full id or a unique suffix of at least MinIDSuffix characters ("a478e649" for
// s-7754a478e649). Invoke resolves it before Run, through the kind's IDLister, which
// the domain registering the commands sets (RegisterThread for threads, RegisterAction
// for runs, ...): every command gets it from its spec, none resolves by hand.

// IDKind is what kind of id an argument holds.
type IDKind int

const (
	// NoID: the arg is not an id (or not resolved).
	NoID IDKind = iota
	// ThreadID: "s-" + 12 hex digits.
	ThreadID
	// RunID: an action run, "r-" + 12 hex digits.
	RunID
	// SubscriptionID: a wake subscription, "sub-" + 12 hex digits.
	SubscriptionID
	// TerminalID: "t-" + 12 hex digits.
	TerminalID
)

// MinIDSuffix is the shortest suffix an id arg resolves.
const MinIDSuffix = 4

// idKinds are each kind's prefix (a value with it is taken as a full id) and noun.
var idKinds = map[IDKind]struct{ prefix, noun string }{
	ThreadID:       {"s-", "thread"},
	RunID:          {"r-", "action run"},
	SubscriptionID: {"sub-", "subscription"},
	TerminalID:     {"t-", "terminal"},
}

// IDLister returns every id of a kind the daemon knows now.
type IDLister func(ctx context.Context) ([]string, error)

// SetIDLister makes Invoke resolve args of kind with list. A kind without one passes
// its values through.
func (r *Registry) SetIDLister(kind IDKind, list IDLister) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.idListers == nil {
		r.idListers = make(map[IDKind]IDLister)
	}
	r.idListers[kind] = list
}

func (r *Registry) idLister(kind IDKind) IDLister {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.idListers[kind]
}

// SetIDFallback makes a suffix of kind that names none of its listed ids resolve
// against list instead: the threads removed within the last day (removedThreadIDs), so
// a removed thread's suffix reaches the command, which says it was removed (E4 4.5).
func (r *Registry) SetIDFallback(kind IDKind, list IDLister) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.idFallbacks == nil {
		r.idFallbacks = make(map[IDKind]IDLister)
	}
	r.idFallbacks[kind] = list
}

// resolveRef resolves one suffix ref of kind against ids, then, when none ends in it,
// against the kind's fallback ids.
func (r *Registry) resolveRef(ctx context.Context, kind IDKind, arg, ref string, ids []string) (string, error) {
	full, err := ResolveID(kind, arg, ref, ids)
	if connect.CodeOf(err) != connect.CodeNotFound {
		return full, err
	}
	r.mu.RLock()
	fallback := r.idFallbacks[kind]
	r.mu.RUnlock()
	if fallback == nil {
		return full, err
	}
	more, ferr := fallback(ctx)
	if ferr != nil {
		return "", ferr
	}
	if full, ferr := ResolveID(kind, arg, ref, more); ferr == nil {
		return full, nil
	}
	return "", err
}

// resolveIDs replaces every id arg given as a suffix with its full id, in args and in
// eff for a context-bound one.
func (r *Registry) resolveIDs(ctx context.Context, specs []ArgSpec, args Args, eff Context) (Context, error) {
	for _, s := range specs {
		v := args.String(s.Name)
		if s.IDList && v != "" {
			full, err := r.resolveIDList(ctx, s, v)
			if err != nil {
				return eff, err
			}
			args.vals[s.Name] = full
			continue
		}
		if s.ID == NoID || !needsResolve(s.ID, v) {
			continue
		}
		list := r.idLister(s.ID)
		if list == nil {
			continue
		}
		ids, err := list(ctx)
		if err != nil {
			return eff, err
		}
		full, err := r.resolveRef(ctx, s.ID, s.Name, v, ids)
		if err != nil {
			return eff, err
		}
		args.vals[s.Name] = full
		if s.Context != NoContext {
			eff = eff.With(s.Context, full)
		}
	}
	return eff, nil
}

// resolveIDList resolves each entry of v, an IDList arg, listing the ids once (only
// when an entry is a suffix): the full ids joined by commas, blanks and repeats dropped.
// One entry that does not resolve fails them all, so a typo acts on none.
func (r *Registry) resolveIDList(ctx context.Context, s ArgSpec, v string) (string, error) {
	list := r.idLister(s.ID)
	var (
		ids    []string
		listed bool
		out    []string
	)
	for _, ref := range splitList(v) {
		full := ref
		if list != nil && needsResolve(s.ID, ref) {
			if !listed {
				var err error
				if ids, err = list(ctx); err != nil {
					return "", err
				}
				listed = true
			}
			var err error
			if full, err = r.resolveRef(ctx, s.ID, s.Name, ref, ids); err != nil {
				return "", err
			}
		}
		if !slices.Contains(out, full) {
			out = append(out, full)
		}
	}
	return strings.Join(out, ","), nil
}

// needsResolve: v may be a suffix (not a full id with the kind's prefix, and long
// enough). Shorter values and prefixed ones pass through for the daemon to judge.
func needsResolve(kind IDKind, v string) bool {
	k, ok := idKinds[kind]
	return ok && len(v) >= MinIDSuffix && !strings.HasPrefix(v, k.prefix)
}

// ResolveID resolves ref, an id or a suffix of one, against ids: the id itself when
// listed, else the one id ending in ref. Several are an *ArgError (InvalidArgument)
// naming them; none is NotFound. A ref with the kind's prefix, or shorter than
// MinIDSuffix, is returned as it is.
func ResolveID(kind IDKind, arg, ref string, ids []string) (string, error) {
	if !needsResolve(kind, ref) || slices.Contains(ids, ref) {
		return ref, nil
	}
	var matches []string
	for _, id := range ids {
		if strings.HasSuffix(id, ref) {
			matches = append(matches, id)
		}
	}
	noun := idKinds[kind].noun
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return "", connect.NewError(connect.CodeNotFound, fmt.Errorf("no %s id ends in %q", noun, ref))
	}
	slices.Sort(matches)
	return "", InvalidArg(arg, "%q is ambiguous: %d %s ids end in it (%s); give more characters",
		ref, len(matches), noun, strings.Join(matches, ", "))
}

// IDHelp is the description suffix of an id arg: "id or unique suffix".
const IDHelp = " (or a unique suffix of 4+ characters)"

// threadIDs lists every thread's id (archived ones too).
func threadIDs(b ThreadBackend) IDLister {
	return func(ctx context.Context) ([]string, error) {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true}}))
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(res.Msg.GetThreads()))
		for i, t := range res.Msg.GetThreads() {
			ids[i] = t.GetId()
		}
		return ids, nil
	}
}

// removedThreadIDs lists the ids of the threads removed within the last day (the
// daemon's tombstones), the fallback of a thread id suffix.
func removedThreadIDs(b ThreadBackend) IDLister {
	return func(ctx context.Context) ([]string, error) {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListThreadsRequest{Filter: &v1.ThreadFilter{All: true, IncludeRemoved: true}}))
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(res.Msg.GetRemoved()))
		for i, t := range res.Msg.GetRemoved() {
			ids[i] = t.GetId()
		}
		return ids, nil
	}
}

// subscriptionIDs lists every wake subscription's id.
func subscriptionIDs(b SubscriptionBackend) IDLister {
	return func(ctx context.Context) ([]string, error) {
		res, err := b.ListSubscriptions(ctx, connect.NewRequest(&v1.ListThreadSubscriptionsRequest{}))
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(res.Msg.GetSubscriptions()))
		for i, s := range res.Msg.GetSubscriptions() {
			ids[i] = s.GetId()
		}
		return ids, nil
	}
}

// terminalIDs lists every terminal's id.
func terminalIDs(b TerminalBackend) IDLister {
	return func(ctx context.Context) ([]string, error) {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListTerminalsRequest{}))
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(res.Msg.GetTerminals()))
		for i, t := range res.Msg.GetTerminals() {
			ids[i] = t.GetId()
		}
		return ids, nil
	}
}

// runIDs lists every action run the daemon remembers (every project's).
func runIDs(b ActionBackend) IDLister {
	return func(ctx context.Context) ([]string, error) {
		res, err := b.List(ctx, connect.NewRequest(&v1.ListActionsRequest{}))
		if err != nil {
			return nil, err
		}
		ids := make([]string, len(res.Msg.GetRuns()))
		for i, r := range res.Msg.GetRuns() {
			ids[i] = r.GetId()
		}
		return ids, nil
	}
}
