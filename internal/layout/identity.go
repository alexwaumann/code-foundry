package layout

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
)

// Link says how a kind's tabs relate to a thread.
type Link string

// Links.
const (
	// LinkSelf is the thread tab: Thread is the thread it shows.
	LinkSelf Link = "self"
	// LinkRequired kinds always belong to a thread.
	LinkRequired Link = "required"
	// LinkOptional kinds are linked to a thread or not.
	LinkOptional Link = "optional"
	// LinkNone kinds never belong to a thread.
	LinkNone Link = "none"
)

// Scope is where a kind's identity key must be unique.
type Scope string

// Scopes.
const (
	// ScopeSpace keys are unique within a space: the same surface may be open in two spaces.
	ScopeSpace Scope = "space"
	// ScopeGlobal keys are unique in the whole layout (a thread, a terminal).
	ScopeGlobal Scope = "global"
)

// Kind is one surface kind: how its tabs link to threads, what makes two of them the same,
// whether a tab of it takes a manual name, and its default size beside a thread (placement).
type Kind struct {
	Name  string `json:"kind"`
	Link  Link   `json:"link"`
	Scope Scope  `json:"scope"`
	// KeyParams names the params the key reads; Identify refuses a tab missing one the key
	// needs (a diff's checkout, a file's path, ...). The other params never change identity.
	KeyParams  []string `json:"key_params,omitempty"`
	Renameable bool     `json:"renameable,omitempty"`
	// DefaultFrac is the share of the thread pane's room a new pane of this kind takes beside it.
	DefaultFrac float64 `json:"default_frac"`
	// FloorPx is the least width that new pane takes beside a thread when there is room.
	FloorPx float64 `json:"floor_px,omitempty"`
	// Prefix marks a family of kinds named "<Name><plugin>.<surface>".
	Prefix bool `json:"prefix,omitempty"`

	key func(t *Tab) (string, error)
}

// DiffAskerParam is the diff param naming the thread that framed the tab (view.open.diff),
// which makes it a tab of that thread's own rather than the checkout's.
const DiffAskerParam = "thread"

// kinds is the identity table (docs/notes/shell-gaps-c-identity.md). A new surface kind adds
// an entry here, one in the GUI's registry and its size in gui/frontend/src/shell/drag/outerFrac.ts;
// testdata/kinds.json pins that they agree.
var kinds = map[string]*Kind{
	"thread": {
		Link: LinkSelf, Scope: ScopeGlobal, DefaultFrac: 0.5,
		key: func(t *Tab) (string, error) { return "thread:" + t.Thread, nil },
	},
	// A diff is one per thread and checkout: the user's. What a thread frames for the user (a
	// side, a narrowed list, a note, a title: view.open.diff's "thread" param, the thread that
	// asked) is a tab of that thread's own, so a thread's call never takes over the user's tab
	// (its filter, folds and sides); the same title updates the same tab.
	"diff": {
		Link: LinkOptional, Scope: ScopeSpace, KeyParams: []string{"project", "worktree", "thread", "title"},
		DefaultFrac: 0.45, FloorPx: 480,
		key: func(t *Tab) (string, error) {
			project, worktree, err := need2(t, "project", "worktree")
			if err != nil {
				return "", err
			}
			k := "diff:" + t.Thread + ":" + project + ":" + worktree
			if asker := t.Params[DiffAskerParam]; asker != "" {
				k += ":by:" + asker
			}
			if title := t.Params["title"]; title != "" {
				k += ":" + title
			}
			return k, nil
		},
	},
	"file": {
		Link: LinkOptional, Scope: ScopeSpace, KeyParams: []string{"path"}, DefaultFrac: 0.35,
		key: func(t *Tab) (string, error) {
			path, err := need(t, "path")
			return "file:" + path, err
		},
	},
	"pullrequest": {
		Link: LinkOptional, Scope: ScopeSpace, KeyParams: []string{"slug", "number"},
		DefaultFrac: 0.45, FloorPx: 480,
		key: func(t *Tab) (string, error) {
			slug, number, err := need2(t, "slug", "number")
			if err != nil {
				return "", err
			}
			if n, err := strconv.Atoi(number); err != nil || n <= 0 || strconv.Itoa(n) != number {
				return "", fmt.Errorf("param number %q is not a pull request number: %w", number, ErrInvalidArgument)
			}
			return "pr:" + strings.ToLower(slug) + "#" + number, nil
		},
	},
	"terminal": {
		Link: LinkOptional, Scope: ScopeGlobal, KeyParams: []string{"terminal"}, Renameable: true,
		DefaultFrac: 0.3,
		key: func(t *Tab) (string, error) {
			id, err := need(t, "terminal")
			return "term:" + id, err
		},
	},
	"prs":         {Link: LinkNone, Scope: ScopeSpace, DefaultFrac: 0.5, key: kindKey("prs")},
	"projects":    {Link: LinkNone, Scope: ScopeSpace, DefaultFrac: 0.5, key: kindKey("projects")},
	"ember.board": {Link: LinkRequired, Scope: ScopeSpace, DefaultFrac: 0.5, key: kindKey("ember.board")},
	// A space has at most one empty composer (docs/notes/shell-model.md), keyed "compose"; a
	// draft (param "draft", drafts.go) is keyed by its id, so a space holds several. The other
	// params (project, workspace, like) say what the next thread starts from, never which
	// composer it is.
	"compose": {
		Link: LinkNone, Scope: ScopeSpace, KeyParams: []string{"draft"}, DefaultFrac: 0.5,
		key: func(t *Tab) (string, error) {
			if d := t.Params[DraftParam]; d != "" {
				return "compose:draft:" + d, nil
			}
			return "compose", nil
		},
	},
	"mcp": {
		Link: LinkRequired, Scope: ScopeSpace, DefaultFrac: 0.35,
		key: func(t *Tab) (string, error) { return "mcp:" + t.Thread, nil },
	},
	"gallery": {
		Link: LinkRequired, Scope: ScopeSpace, KeyParams: []string{"title"}, DefaultFrac: 0.45,
		key: func(t *Tab) (string, error) {
			title, err := need(t, "title")
			return "gallery:" + t.Thread + ":" + title, err
		},
	},
	// A plugin surface is one per scope its tab names ("scope", the plugin store's instance
	// scope: a project, a worktree, global); a linked tab that names none is one per thread,
	// which is what a thread-scoped surface's instance is.
	"plugin.": {
		Prefix: true, Link: LinkOptional, Scope: ScopeSpace, KeyParams: []string{"scope"}, DefaultFrac: 0.35,
		key: func(t *Tab) (string, error) {
			p, s, _ := strings.Cut(strings.TrimPrefix(t.Kind, "plugin."), ".")
			scope := t.Params["scope"]
			if scope == "" && t.Thread != "" {
				scope = "thread:" + t.Thread
			}
			return "plugin:" + p + "/" + s + "/" + scope, nil
		},
	},
}

func init() {
	for name, k := range kinds {
		k.Name = name
	}
}

func kindKey(name string) func(*Tab) (string, error) {
	return func(*Tab) (string, error) { return name, nil }
}

func need(t *Tab, p string) (string, error) {
	v := t.Params[p]
	if v == "" {
		return "", fmt.Errorf("%s tab without param %q: %w", t.Kind, p, ErrInvalidArgument)
	}
	return v, nil
}

func need2(t *Tab, a, b string) (string, string, error) {
	va, err := need(t, a)
	if err != nil {
		return "", "", err
	}
	vb, err := need(t, b)
	return va, vb, err
}

// KindOf is the table entry for a tab kind: an exact name, or "plugin.<plugin>.<surface>".
func KindOf(name string) (*Kind, bool) {
	if k, ok := kinds[name]; ok && !k.Prefix {
		return k, true
	}
	for _, k := range kinds {
		if !k.Prefix || !strings.HasPrefix(name, k.Name) {
			continue
		}
		p, s, ok := strings.Cut(strings.TrimPrefix(name, k.Name), ".")
		if ok && p != "" && s != "" {
			return k, true
		}
	}
	return nil, false
}

// Kinds lists the identity table, sorted by name (testdata/kinds.json).
func Kinds() []*Kind {
	out := make([]*Kind, 0, len(kinds))
	for _, k := range kinds {
		out = append(out, k)
	}
	slices.SortFunc(out, func(a, b *Kind) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// Identify checks a tab against its kind (known kind, a thread exactly when the kind links
// one, the params the key needs) and returns its kind and identity key.
func Identify(t *Tab) (*Kind, string, error) {
	k, ok := KindOf(t.Kind)
	if !ok {
		return nil, "", fmt.Errorf("unknown tab kind %q: %w", t.Kind, ErrInvalidArgument)
	}
	switch {
	case (k.Link == LinkSelf || k.Link == LinkRequired) && t.Thread == "":
		return nil, "", fmt.Errorf("%s tab without a thread: %w", t.Kind, ErrInvalidArgument)
	case k.Link == LinkNone && t.Thread != "":
		return nil, "", fmt.Errorf("%s tab cannot belong to a thread: %w", t.Kind, ErrInvalidArgument)
	}
	key, err := k.key(t)
	if err != nil {
		return nil, "", err
	}
	return k, key, nil
}

// IsLinked reports whether t is a linked surface: a tab of a thread that is not the thread's
// own tab.
func (t *Tab) IsLinked() bool { return t.Thread != "" && t.Kind != "thread" }
