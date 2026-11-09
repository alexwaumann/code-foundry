package plugintest

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The user's acts on a list's interactive rows (ui.List's Checkable, Reorderable and Add,
// ui.Row's Editable), shaped from the instance's latest view as the host shapes them:
// Kind and Action the act's kind, Node the list's key, Value typed. Each is refused, as
// the host refuses it, when the view's list does not have it or the value is one the host
// does not send.

// The real host announces them (internal/store/plugin's list_rows.go).
func init() { HostCapabilities = append(HostCapabilities, "view.list.rows") }

// Check ticks (on) or unticks the checkbox of row key (pluginsdk.ActCheck).
func (h *Host) Check(ctx context.Context, instance, key string, on bool) error {
	list, _, err := h.rowList(instance, key, pluginsdk.ActCheck)
	if err != nil {
		return err
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActCheck, Action: pluginsdk.ActCheck, Node: list, Key: key, Value: on})
}

// Move drags row key to just under row after ("" for the top) (pluginsdk.ActMove).
func (h *Host) Move(ctx context.Context, instance, key, after string) error {
	list, l, err := h.rowList(instance, key, pluginsdk.ActMove)
	if err != nil {
		return err
	}
	if after == key || (after != "" && !slices.ContainsFunc(l.Rows, func(r ui.Row) bool { return r.Key == after })) {
		return fmt.Errorf("plugintest: a move's after is \"\" or another row of list %q, not %q", list, after)
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActMove, Action: pluginsdk.ActMove, Node: list, Key: key, Value: after})
}

// AddRow enters text in list's add input and presses Enter (pluginsdk.ActAdd).
func (h *Host) AddRow(ctx context.Context, instance, list, text string) error {
	v, err := h.latestView(instance)
	if err != nil {
		return err
	}
	l := findList(v, list)
	if l == nil || l.Add == nil {
		return fmt.Errorf("plugintest: %q is not a list with an add input in the view", list)
	}
	if text, err = rowText(text); err != nil {
		return err
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActAdd, Action: pluginsdk.ActAdd, Node: list, Key: list, Value: text})
}

// EditRow renames editable row key to text (pluginsdk.ActEdit).
func (h *Host) EditRow(ctx context.Context, instance, key, text string) error {
	list, _, err := h.rowList(instance, key, pluginsdk.ActEdit)
	if err != nil {
		return err
	}
	if text, err = rowText(text); err != nil {
		return err
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActEdit, Action: pluginsdk.ActEdit, Node: list, Key: key, Value: text})
}

// rowText is an add's or edit's text as the host sends it: trimmed, one line, not empty.
func rowText(s string) (string, error) {
	s = strings.TrimSpace(s)
	switch {
	case s == "":
		return "", fmt.Errorf("plugintest: the text is empty (the host sends nothing)")
	case strings.ContainsAny(s, "\r\n"):
		return "", fmt.Errorf("plugintest: the text is one line")
	case utf8.RuneCountInString(s) > ui.MaxRowText:
		return "", fmt.Errorf("plugintest: the text is over %d characters", ui.MaxRowText)
	}
	return s, nil
}

func (h *Host) latestView(instance string) (ui.View, error) {
	raw, ok := h.View(instance)
	if !ok {
		return ui.View{}, fmt.Errorf("plugintest: no view of %s yet", instance)
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		return ui.View{}, fmt.Errorf("plugintest: the view of %s: %w", instance, err)
	}
	return v, nil
}

// rowList finds the list node holding row key in the latest view, refusing when the row
// does not have the act kind (its list is not checkable or reorderable, it is not
// editable).
func (h *Host) rowList(instance, key, kind string) (string, *ui.List, error) {
	v, err := h.latestView(instance)
	if err != nil {
		return "", nil, err
	}
	var node string
	var list *ui.List
	var row ui.Row
	walkLists(v, func(n ui.Node) bool {
		for _, r := range n.List.Rows {
			if r.Key == key {
				node, list, row = n.Key, n.List, r
				return true
			}
		}
		return false
	})
	if list == nil {
		return "", nil, fmt.Errorf("plugintest: no row %q in a list of the view", key)
	}
	has := map[string]bool{pluginsdk.ActCheck: list.Checkable, pluginsdk.ActMove: list.Reorderable, pluginsdk.ActEdit: row.Editable}[kind]
	if !has {
		return "", nil, fmt.Errorf("plugintest: row %q has no %s act (the host refuses it)", key, kind)
	}
	return node, list, nil
}

func findList(v ui.View, key string) *ui.List {
	var out *ui.List
	walkLists(v, func(n ui.Node) bool {
		if n.Key == key {
			out = n.List
			return true
		}
		return false
	})
	return out
}

// walkLists calls f for each list node of v (a master-detail's list is not one) until it
// returns true.
func walkLists(v ui.View, f func(n ui.Node) bool) {
	var walk func(ns []ui.Node) bool
	walk = func(ns []ui.Node) bool {
		for _, n := range ns {
			if n.List != nil && f(n) {
				return true
			}
			for _, l := range n.Children() {
				if walk(l) {
					return true
				}
			}
		}
		return false
	}
	for _, l := range v.NodeLists() {
		if walk(l) {
			return
		}
	}
}
