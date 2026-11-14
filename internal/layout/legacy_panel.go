package layout

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
)

// A port of the classic window's side panel store (gui/frontend/src/stores/panel.ts):
// reading its persisted value (localStorage "code-foundry.panel", a zustand persist
// envelope {"state": {"byKey": ...}, "version": n}) through its migrations (versions 1 to 6)
// and its repair (sanitizePanelState), as the store's rehydrate does. The first-load import
// (legacy.go) reads the result. testdata/legacy/panel.json pins the port to the TypeScript:
// each case is a stored value and what the store held after rehydrating it.
//
// Where the TypeScript throws on a malformed store older than version 3 (a tab without
// params, an entry without a tab list) and so keeps nothing at all, the port keeps the
// entries and tabs that are sound.

// panelVersion is the store's current version.
const panelVersion = 6

// panelTab is a stored side panel tab.
type panelTab struct {
	ID     string            `json:"id"`
	Kind   string            `json:"kind"`
	Title  string            `json:"title"`
	Params map[string]string `json:"params"`
}

// panelGroup is one tab group: its tabs, its active tab (nil: none, the group is picking or
// empty) and the tab picking began from.
type panelGroup struct {
	Tabs     []panelTab `json:"tabs"`
	Active   *string    `json:"activeTabId"`
	PickFrom *string    `json:"pickFrom,omitempty"`
}

// panelEntry is one key's panel (version 6).
type panelEntry struct {
	Open     bool         `json:"open"`
	Groups   []panelGroup `json:"groups"`
	Width    *float64     `json:"width,omitempty"`
	Expanded bool         `json:"expanded,omitempty"`
	Ratio    *float64     `json:"ratio,omitempty"`
	Focused  int          `json:"focused,omitempty"`
}

// readPanel reads a stored side panel value of any version into version 6 entries by key,
// repaired. An empty value, or one that is not JSON, is no entry.
func readPanel(raw []byte) map[string]*panelEntry {
	var stored any
	if len(raw) == 0 || json.Unmarshal(raw, &stored) != nil {
		return map[string]*panelEntry{}
	}
	env, _ := stored.(map[string]any)
	state, _ := env["state"].(map[string]any)
	byKey := state["byKey"]
	// zustand migrates only a numeric version other than the current one.
	version, numeric := env["version"].(float64)
	if !numeric || version >= panelVersion {
		return sanitizePanel(byKey)
	}
	if version < 3 {
		byKey = panelV2(byKey, version < 2)
	}
	// Each later step runs on the repaired output of the one before, as the store's migrate does.
	for _, step := range []struct {
		to      float64
		migrate func(map[string]*panelEntry) map[string]*panelEntry
	}{{4, panelV3}, {5, panelV4}, {6, panelV5}} {
		if version < step.to {
			byKey = panelAny(step.migrate(sanitizePanel(byKey)))
		}
	}
	return sanitizePanel(byKey)
}

// panelAny is entries as JSON values, for sanitizePanel.
func panelAny(entries map[string]*panelEntry) any {
	b, err := json.Marshal(entries)
	if err != nil {
		return nil // cannot happen: the entries are plain values
	}
	var out any
	_ = json.Unmarshal(b, &out)
	return out
}

// panelV2 brings entries of versions 1 and 2 (one flat tab list per entry) to the version 3
// shape (one group), as JSON values. From version 1 (rename) it first renames a tab param
// "repo" to "project" and moves the ids that pointed at the tab (migratePanelV1).
func panelV2(byKey any, rename bool) any {
	in, _ := byKey.(map[string]any)
	out := map[string]any{}
	for key, v := range in {
		rec, ok := v.(map[string]any)
		if !ok {
			continue
		}
		var tabs []any
		ids := map[string]string{}
		list, _ := rec["tabs"].([]any)
		for _, x := range list {
			t, ok := sanitizePanelTab(x)
			if !ok {
				continue
			}
			if repo, has := t.Params["repo"]; rename && has {
				params := map[string]string{}
				for k, p := range t.Params {
					if k != "repo" {
						params[k] = p
					}
				}
				params["project"] = repo
				next := panelTab{ID: panelTabID(t.Kind, params), Kind: t.Kind, Title: t.Title, Params: params}
				ids[t.ID] = next.ID
				t = next
			}
			tabs = append(tabs, map[string]any{"id": t.ID, "kind": t.Kind, "title": t.Title, "params": stringsAny(t.Params)})
		}
		moved := func(v any) any {
			if s, ok := v.(string); ok && ids[s] != "" {
				return ids[s]
			}
			return v
		}
		group := map[string]any{"tabs": tabs, "activeTabId": moved(rec["activeTabId"])}
		if p, ok := rec["pickFrom"]; ok {
			group["pickFrom"] = moved(p)
		}
		e := map[string]any{}
		for k, x := range rec {
			if k != "tabs" && k != "activeTabId" && k != "pickFrom" {
				e[k] = x
			}
		}
		e["groups"] = []any{group}
		out[key] = e
	}
	return out
}

func stringsAny(m map[string]string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// sanitizePanel is sanitizePanelState: entries of any shape repaired into ones with one or
// two groups, each with a tab list and an active tab that is one of its tabs, and numbers
// where numbers go. What cannot be used is dropped.
func sanitizePanel(byKey any) map[string]*panelEntry {
	out := map[string]*panelEntry{}
	in, _ := byKey.(map[string]any)
	for key, v := range in {
		rec, ok := v.(map[string]any)
		if !ok {
			continue
		}
		raw, _ := rec["groups"].([]any)
		if len(raw) == 0 {
			raw = []any{map[string]any{"tabs": rec["tabs"], "activeTabId": rec["activeTabId"], "pickFrom": rec["pickFrom"]}}
		}
		if len(raw) > 2 {
			raw = raw[:2]
		}
		var groups []panelGroup
		for _, g := range raw {
			groups = append(groups, sanitizePanelGroup(g))
		}
		if len(groups) == 2 && len(groups[0].Tabs) == 0 && len(groups[1].Tabs) == 0 {
			groups = groups[:1]
		}
		e := &panelEntry{Open: rec["open"] == true, Groups: groups}
		if w, ok := rec["width"].(float64); ok && !math.IsInf(w, 0) && !math.IsNaN(w) {
			e.Width = &w
		}
		e.Expanded = rec["expanded"] == true
		if r, ok := rec["ratio"].(float64); ok && r >= 0.2 && r <= 0.8 {
			e.Ratio = &r
		}
		if f, ok := rec["focused"].(float64); ok && f == 1 && len(groups) > 1 {
			e.Focused = 1
		}
		out[key] = e
	}
	return out
}

func sanitizePanelGroup(v any) panelGroup {
	g := panelGroup{Tabs: []panelTab{}}
	rec, ok := v.(map[string]any)
	if !ok {
		return g
	}
	list, _ := rec["tabs"].([]any)
	for _, x := range list {
		if t, ok := sanitizePanelTab(x); ok {
			g.Tabs = append(g.Tabs, t)
		}
	}
	has := func(v any) (string, bool) {
		s, ok := v.(string)
		return s, ok && slices.ContainsFunc(g.Tabs, func(t panelTab) bool { return t.ID == s })
	}
	if id, ok := has(rec["activeTabId"]); ok {
		g.Active = &id
	} else if id, ok := has(rec["pickFrom"]); ok {
		g.PickFrom = &id
	}
	return g
}

// sanitizePanelTab is a stored tab with every field a tab needs, its params keeping only
// string values; ok is false for anything else.
func sanitizePanelTab(v any) (panelTab, bool) {
	rec, ok := v.(map[string]any)
	if !ok {
		return panelTab{}, false
	}
	id, ok1 := rec["id"].(string)
	kind, ok2 := rec["kind"].(string)
	title, ok3 := rec["title"].(string)
	params, ok4 := rec["params"].(map[string]any)
	if !ok1 || !ok2 || !ok3 || !ok4 {
		return panelTab{}, false
	}
	t := panelTab{ID: id, Kind: kind, Title: title, Params: map[string]string{}}
	for k, x := range params {
		if s, ok := x.(string); ok {
			t.Params[k] = s
		}
	}
	return t, true
}

// panelTabID is tabId: the kind, then the params sorted by name as a query string.
func panelTabID(kind string, params map[string]string) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = encodeURIComponent(k) + "=" + encodeURIComponent(params[k])
	}
	if len(parts) == 0 {
		return kind
	}
	return kind + "?" + strings.Join(parts, "&")
}

// encodeURIComponent is JavaScript's: every byte of the UTF-8 form escaped as %XX except
// A-Z a-z 0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}

// rewritePanelTabs is rewriteTabs: every tab through rewrite (false drops it). A group's
// active tab and pickFrom follow their tab's new id; a group whose active tab went shows its
// first tab left; a split whose group emptied is one group again. Tabs that end up with one
// id are one tab, the first of them, whichever groups they were in.
func rewritePanelTabs(byKey map[string]*panelEntry, rewrite func(panelTab) (panelTab, bool)) map[string]*panelEntry {
	out := map[string]*panelEntry{}
	for key, e := range byKey {
		seen := map[string]bool{}
		groups := make([]panelGroup, len(e.Groups))
		for gi, g := range e.Groups {
			ids := map[string]string{}
			tabs := []panelTab{}
			for _, t := range g.Tabs {
				next, ok := rewrite(t)
				if !ok {
					continue
				}
				if !seen[next.ID] {
					seen[next.ID] = true
					tabs = append(tabs, next)
				}
				if slices.ContainsFunc(tabs, func(x panelTab) bool { return x.ID == next.ID }) {
					ids[t.ID] = next.ID
				}
			}
			moved := func(p *string) *string {
				if p == nil {
					return nil
				}
				if id, ok := ids[*p]; ok {
					return &id
				}
				return nil
			}
			pickFrom, active := moved(g.PickFrom), moved(g.Active)
			if g.Active == nil && pickFrom != nil {
				groups[gi] = panelGroup{Tabs: tabs, PickFrom: pickFrom}
				continue
			}
			if active == nil && len(tabs) > 0 {
				active = &tabs[0].ID
			}
			groups[gi] = panelGroup{Tabs: tabs, Active: active}
		}
		emptied := false
		for gi, g := range groups {
			if len(g.Tabs) == 0 && len(e.Groups[gi].Tabs) > 0 {
				emptied = true
			}
		}
		next := *e
		if len(groups) > 1 && emptied {
			kept := panelGroup{Tabs: []panelTab{}}
			if i := slices.IndexFunc(groups, func(g panelGroup) bool { return len(g.Tabs) > 0 }); i >= 0 {
				kept = groups[i]
			}
			next.Groups, next.Focused, next.Ratio = []panelGroup{kept}, 0, nil
		} else {
			next.Groups = groups
		}
		out[key] = &next
	}
	return out
}

// panelRemovedKinds are the surfaces the thread info card replaced (version 4).
var panelRemovedKinds = []string{"usage", "linkedprs", "threads", "agents"}

// panelV3 is migratePanelV3: a Worktree tab of a worktree is that worktree's Changes tab; a
// Worktree tab of a workspace's folder, and a tab of a removed surface, goes.
func panelV3(byKey map[string]*panelEntry) map[string]*panelEntry {
	return rewritePanelTabs(byKey, func(t panelTab) (panelTab, bool) {
		if slices.Contains(panelRemovedKinds, t.Kind) {
			return t, false
		}
		if t.Kind != "worktree" {
			return t, true
		}
		project, path := t.Params["project"], t.Params["path"]
		if project == "" || path == "" {
			return t, false
		}
		params := map[string]string{"project": project, "path": path}
		return panelTab{ID: panelTabID("changes", params), Kind: "changes", Title: "Changes · " + t.Title, Params: params}, true
	})
}

// panelV4 is migratePanelV4: pull request tabs take their lower-case id, keeping the slug
// they show, so two tabs of one pull request are one.
func panelV4(byKey map[string]*panelEntry) map[string]*panelEntry {
	return rewritePanelTabs(byKey, func(t panelTab) (panelTab, bool) {
		if t.Kind == "pullrequest" {
			t.ID = panelTabID("pullrequest", map[string]string{"number": t.Params["number"], "slug": strings.ToLower(t.Params["slug"])})
		}
		return t, true
	})
}

// diffV6 is where a checkout's version 5 tabs land: one Diff tab.
type diffV6 struct {
	own    bool
	title  string
	from   *panelTab
	active bool
}

// checkoutOfV5 is a version 5 tab's checkout for the two surfaces that became one, or "".
func checkoutOfV5(t panelTab) string {
	p := t.Params
	switch {
	case t.Kind == "changes" && p["project"] != "" && p["path"] != "":
		return p["project"] + "\x00" + p["path"]
	case t.Kind == "diff" && hasKey(p, "scope") && p["project"] != "" && p["worktree"] != "" && p["path"] != "":
		return p["project"] + "\x00" + p["worktree"]
	}
	return ""
}

func hasKey(m map[string]string, k string) bool {
	_, ok := m[k]
	return ok
}

// panelV5 is migratePanelV5: a checkout's Changes tab and one-file Diff tabs are one Diff tab
// per checkout, where the first of them stood, showing the file the panel showed, on the same
// sources. A Changes tab whose params name no worktree goes.
func panelV5(byKey map[string]*panelEntry) map[string]*panelEntry {
	out := map[string]*panelEntry{}
	for key, e := range byKey {
		diffs := map[string]*diffV6{}
		for _, g := range e.Groups {
			for _, t := range g.Tabs {
				k := checkoutOfV5(t)
				if k == "" {
					continue
				}
				d := diffs[k]
				if d == nil {
					d = &diffV6{own: true, title: "Diff"}
					diffs[k] = d
				}
				if t.Kind == "changes" {
					d.own = t.Title == "Changes"
					if rest, ok := strings.CutPrefix(t.Title, "Changes"); ok {
						d.title = "Diff" + rest
					} else {
						d.title = t.Title
					}
				} else if !d.active {
					d.from = &t
					d.active = g.Active != nil && *g.Active == t.ID
				}
			}
		}
		for k, v := range rewritePanelTabs(map[string]*panelEntry{key: e}, func(t panelTab) (panelTab, bool) { return tabV6(t, diffs) }) {
			out[k] = v
		}
	}
	return out
}

func tabV6(t panelTab, diffs map[string]*diffV6) (panelTab, bool) {
	k := checkoutOfV5(t)
	if k == "" {
		return t, t.Kind != "changes" && (t.Kind != "diff" || !hasKey(t.Params, "scope"))
	}
	d := diffs[k]
	project := t.Params["project"]
	worktree := t.Params["worktree"]
	if t.Kind == "changes" {
		worktree = t.Params["path"]
	}
	params := map[string]string{"project": project, "worktree": worktree}
	title := "Diff"
	if d != nil {
		title = d.title
		if f := d.from; f != nil {
			if f.Params["scope"] == "branch" {
				params["head"] = "ref:HEAD"
			}
			if f.Params["path"] != "" {
				params["path"] = f.Params["path"]
			}
			if f.Params["oldPath"] != "" {
				params["oldPath"] = f.Params["oldPath"]
			}
		}
		if d.own {
			params["own"] = "1"
		}
	}
	return panelTab{ID: panelTabID("diff", map[string]string{"project": project, "worktree": worktree}), Kind: "diff", Title: title, Params: params}, true
}
