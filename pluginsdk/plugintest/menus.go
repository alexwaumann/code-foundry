package plugintest

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// PickItem sends the act the host sends when the user picks the menu item key in instance's
// latest view (a row's, the header's or a menu button's menu, a submenu's item too): a
// click whose action is the item's event, with its key and data. It refuses what the GUI
// would not send: a key that is no menu item, a submenu, a disabled item (or one in a
// disabled submenu), and an item whose action the host runs itself (a command, a URL, a
// copy).
func (h *Host) PickItem(ctx context.Context, instance, key string) error {
	raw, ok := h.View(instance)
	if !ok {
		return fmt.Errorf("plugintest: instance %q has no view", instance)
	}
	var v ui.View
	if err := json.Unmarshal(raw, &v); err != nil {
		return fmt.Errorf("plugintest: the view of %q: %w", instance, err)
	}
	it, disabled, found := findMenuItem(v, key)
	switch {
	case !found:
		return fmt.Errorf("plugintest: no menu item %q in the view", key)
	case it.Submenu != nil:
		return fmt.Errorf("plugintest: menu item %q is a submenu: pick one of its items", key)
	case disabled:
		return fmt.Errorf("plugintest: menu item %q is disabled", key)
	case it.Action == nil || it.Action.Event == "":
		return fmt.Errorf("plugintest: menu item %q's action is the host's (a command, URL or copy): it never reaches the plugin", key)
	}
	return h.Act(ctx, pluginsdk.SurfaceAct{Instance: instance, Kind: pluginsdk.ActClick, Action: it.Action.Event, Key: key, Data: it.Action.Data})
}

// findMenuItem finds the menu item key anywhere in v, and whether it is inert (disabled,
// or in a disabled submenu).
func findMenuItem(v ui.View, key string) (it ui.MenuItem, disabled, found bool) {
	var menus []*ui.Menu
	buttons := func(bs []ui.Button) {
		for _, b := range bs {
			menus = append(menus, b.Menu)
		}
	}
	rows := func(rs []ui.Row) {
		for _, r := range rs {
			menus = append(menus, r.Menu)
		}
	}
	if v.Header != nil {
		menus = append(menus, v.Header.Menu)
		buttons(v.Header.Actions)
	}
	var walk func(ns []ui.Node)
	walk = func(ns []ui.Node) {
		for _, n := range ns {
			switch {
			case n.List != nil:
				rows(n.List.Rows)
			case n.MasterDetail != nil:
				rows(n.MasterDetail.List.Rows)
			case n.Actions != nil:
				buttons(n.Actions.Buttons)
			case n.Section != nil:
				buttons(n.Section.Actions)
			case n.Notice != nil:
				buttons(n.Notice.Actions)
			case n.Empty != nil:
				buttons(n.Empty.Actions)
			case n.Terminal != nil:
				buttons(n.Terminal.Actions)
			}
			if n.MasterDetail != nil && n.MasterDetail.EmptyDetail != nil {
				buttons(n.MasterDetail.EmptyDetail.Actions)
			}
			for _, l := range n.Children() {
				walk(l)
			}
		}
	}
	for _, l := range v.NodeLists() {
		walk(l)
	}
	for _, m := range menus {
		if m == nil {
			continue
		}
		for _, top := range m.Items {
			if top.Key == key && !top.Separator {
				return top, top.Disabled, true
			}
			for _, sub := range top.Submenu {
				if sub.Key == key && !sub.Separator {
					return sub, top.Disabled || sub.Disabled, true
				}
			}
		}
	}
	return ui.MenuItem{}, false, false
}
