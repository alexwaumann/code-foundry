package plugintest

import (
	"encoding/json"
	"fmt"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// HostCapabilities are what Code Foundry's host announces in initialize, and what Start
// announces when Options.Capabilities is nil (a test of a plugin's fallback for an older
// host passes its own list; an empty one announces none). A test in the host keeps the
// two lists equal.
var HostCapabilities = []string{
	"invoke", "secrets", "log", "sessionEnv", "events", "flags",
	"surfaces", "view.v1", "view.append", "context", "invoke.ask",
	"view.node.text", "view.node.markdown", "view.node.pairs", "view.node.list", "view.node.chips",
	"view.node.log", "view.node.actions", "view.node.progress", "view.node.notice", "view.node.empty",
	"view.node.section", "view.node.form", "view.node.columns", "view.node.pane", "view.node.container",
	"view.node.grid", "view.node.divider", "view.node.spacer", "view.node.group", "view.node.masterDetail", "view.node.tabs",
	"view.tabs", "view.toolbar", "view.footer", "view.fieldset", "view.optionsSource", "view.duration",
	"terminals", "view.node.terminal", "terminal.read", "terminal.exited", "terminal.scrollback",
	"threads", "view.node.thread", "act.context", "wakes",
}

// hostAct shapes a tab or select act as the host does, from the instance's latest view:
// the host takes the kind, action and node from its own copy of the view, sets Value to
// the key, and drops any values (a tab or select carries none). An act naming a tab or a
// master-detail row as the other kind is refused, as the host refuses it. Any other act
// (and one on an instance without a view) goes as given, so a test can still send the
// plugin acts it must refuse itself (a stale key, an unknown action).
func (h *Host) hostAct(act pluginsdk.SurfaceAct) (pluginsdk.SurfaceAct, error) {
	raw, ok := h.View(act.Instance)
	if !ok || act.Key == "" {
		return act, nil
	}
	var v ui.View
	if json.Unmarshal(raw, &v) != nil {
		return act, nil
	}
	kind, node, found := choiceOf(v, act.Key)
	if !found {
		return act, nil
	}
	if (act.Kind != "" && act.Kind != kind) || (act.Action != "" && act.Action != kind) {
		return act, fmt.Errorf("plugintest: element %q is a %s, not a %s %s act (the host refuses it)", act.Key, kind, act.Kind, act.Action)
	}
	act.Kind, act.Action, act.Node, act.Value, act.Values = kind, kind, node, act.Key, nil
	return act, nil
}

// choiceOf finds key among v's tabs (the view's, node "", and tabs nodes') and
// master-detail rows without an action of their own: the elements whose acts the host
// shapes (kind pluginsdk.ActTab or pluginsdk.ActSelect, and the node they belong to).
func choiceOf(v ui.View, key string) (kind, node string, found bool) {
	if v.Tabs != nil {
		for _, t := range v.Tabs.Items {
			if t.Key == key {
				return pluginsdk.ActTab, "", true
			}
		}
	}
	var walk func(ns []ui.Node) bool
	walk = func(ns []ui.Node) bool {
		for _, n := range ns {
			switch {
			case n.Tabs != nil:
				for _, t := range n.Tabs.Items {
					if t.Key == key {
						kind, node = pluginsdk.ActTab, n.Key
						return true
					}
				}
			case n.MasterDetail != nil:
				for _, r := range n.MasterDetail.List.Rows {
					if r.Key == key && r.Action == nil {
						kind, node = pluginsdk.ActSelect, n.Key
						return true
					}
				}
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
			return kind, node, true
		}
	}
	return "", "", false
}
