package ui

import "fmt"

// Menu is a list of text items the host opens from a ⋯ button or a right-click: a row's
// (Row.Menu), the header's (Header.Menu), or a button's own (Button.Menu, a "Rebuild ▾").
// Items are text only: no icons and no shortcuts (a plugin has no keybindings). Picking an
// item runs its Action as a button's would: an event reaches the plugin as a click act
// with the item's key and Data, a command goes through the host's confirm dialog, a URL
// opens and text is copied by the host. In JSON: {"items": [...]}.
//
// Use a menu for a row's or a view's less frequent actions (Open in…, Copy link, Move to ▸,
// Delete); keep the one or two things a user does most as Row.Actions buttons. On a row
// that is too narrow for its buttons, the host folds Row.Actions into the row's ⋯ menu
// (the buttons first, then a separator, then Menu's items): wide rows keep them visible.
type Menu struct {
	Items []MenuItem `json:"items"`
}

// MenuItem is one entry of a menu: exactly one of an action item (Action), a submenu
// (Submenu: one level, its items have no submenus of their own) or a separator
// (Separator, with nothing else set: not first, not last, never two in a row).
//
// An action item or a submenu has a key (in the view's namespace) and a Label (at most
// MaxMenuLabel characters). Disabled leaves it inert (shown dimmed). Danger draws an
// action item in the app's destructive red; pair it with a command that confirms.
//
// Group makes an action item one of a one-pick group (radio style: "Move to ▸ To do / In
// progress / Done"): the group's items sit next to each other in one list, and at most
// one of them is Checked (drawn with a check). Picking one runs its action like any
// item's; the plugin answers with a view whose Checked moved.
type MenuItem struct {
	Key       string     `json:"key,omitempty"`
	Label     string     `json:"label,omitempty"`
	Action    *Action    `json:"action,omitempty"`
	Submenu   []MenuItem `json:"submenu,omitempty"`
	Separator bool       `json:"separator,omitempty"`
	Disabled  bool       `json:"disabled,omitempty"`
	Danger    bool       `json:"danger,omitempty"`
	Group     string     `json:"group,omitempty"`
	Checked   bool       `json:"checked,omitempty"`
}

// Menus' numbers.
const (
	// MaxMenuItems is how many entries one menu or one submenu holds, separators included.
	MaxMenuItems = 24
	// MaxMenuLabel is an item's label, in characters (the menu is about 200 px wide).
	MaxMenuLabel = 60
)

// NewMenu returns a menu of items.
func NewMenu(items ...MenuItem) *Menu { return &Menu{Items: items} }

// EventItem returns a menu item sending event (with data, at most 1 KB) to the plugin.
func EventItem(key, label, event, data string) MenuItem {
	return MenuItem{Key: key, Label: label, Action: EventAction(event, data)}
}

// CommandItem returns a menu item running a command (through the host's confirm dialog
// when the command asks for one).
func CommandItem(key, label, name string, args map[string]string) MenuItem {
	return MenuItem{Key: key, Label: label, Action: CommandAction(name, args)}
}

// URLItem returns a menu item opening url.
func URLItem(key, label, url string) MenuItem {
	return MenuItem{Key: key, Label: label, Action: URLAction(url)}
}

// CopyItem returns a menu item copying text.
func CopyItem(key, label, text string) MenuItem {
	return MenuItem{Key: key, Label: label, Action: CopyAction(text)}
}

// Separator returns a line between two runs of items.
func Separator() MenuItem { return MenuItem{Separator: true} }

// Submenu returns an item opening items one level deeper (they have no submenus).
func Submenu(key, label string, items ...MenuItem) MenuItem {
	return MenuItem{Key: key, Label: label, Submenu: items}
}

// PickGroup returns items as one one-pick group named group, checked the one whose key is
// checked ("" for none).
func PickGroup(group, checked string, items ...MenuItem) []MenuItem {
	out := make([]MenuItem, len(items))
	for i, it := range items {
		it.Group, it.Checked = group, it.Key == checked && checked != ""
		out[i] = it
	}
	return out
}

// AsDanger returns it drawn in the destructive red.
func (it MenuItem) AsDanger() MenuItem { it.Danger = true; return it }

// AsDisabled returns it inert, dimmed.
func (it MenuItem) AsDisabled() MenuItem { it.Disabled = true; return it }

// WithMenu returns b opening m instead of acting (a "Rebuild ▾"); b's action is dropped.
// Not for a header's, row's or form's buttons: those have Header.Menu, Row.Menu, or act.
func (b Button) WithMenu(m *Menu) Button { b.Menu, b.Action = m, nil; return b }

// menu checks a menu: its item count, and each item.
func (c *checker) menu(path string, m *Menu) {
	if m == nil {
		return
	}
	c.menuItems(path+".items", m.Items, false)
}

// menuItems checks one list of menu items (a menu's or a submenu's): 1..MaxMenuItems
// entries, separators only between items, each item one kind, groups adjacent with at most
// one checked item.
func (c *checker) menuItems(path string, items []MenuItem, inSub bool) {
	if n := len(items); n < 1 || n > MaxMenuItems {
		c.bad(path, "%d items, want 1 to %d", n, MaxMenuItems)
	}
	ended := map[string]bool{} // groups whose run of items is over
	checked := map[string]string{}
	prev := ""
	for i, it := range items {
		p := fmt.Sprintf("%s[%d]", path, i)
		if prev != "" && it.Group != prev {
			ended[prev] = true
		}
		prev = it.Group
		c.menuItem(p, it, inSub)
		if it.Separator {
			switch {
			case i == 0:
				c.bad(p, "a separator does not start a menu")
			case i == len(items)-1:
				c.bad(p, "a separator does not end a menu")
			case items[i-1].Separator:
				c.bad(p, "two separators in a row")
			}
		}
		if it.Group == "" {
			continue
		}
		if ended[it.Group] {
			c.bad(p+".group", "%q: a group's items sit next to each other", it.Group)
		}
		if it.Checked {
			if first, two := checked[it.Group]; two {
				c.bad(p+".checked", "group %q already has a checked item (%s): at most one", it.Group, first)
			} else {
				checked[it.Group] = p
			}
		}
	}
}

// menuItem checks one item: exactly one kind, a key and label unless a separator, and
// what each kind may carry.
func (c *checker) menuItem(path string, it MenuItem, inSub bool) {
	kinds := 0
	for _, set := range []bool{it.Action != nil, it.Submenu != nil, it.Separator} {
		if set {
			kinds++
		}
	}
	if kinds != 1 {
		c.bad(path, "a menu item is exactly one of an action, a submenu or a separator")
	}
	if it.Separator {
		c.elements++
		if it.Key != "" || it.Label != "" || it.Disabled || it.Danger || it.Group != "" || it.Checked {
			c.bad(path, "a separator has nothing else set")
		}
		return
	}
	c.key(path, it.Key)
	c.required(path+".label", it.Label)
	c.str(path+".label", it.Label, MaxMenuLabel)
	if it.Group != "" && !KeyPattern.MatchString(it.Group) {
		c.bad(path+".group", "%q must match %s", it.Group, KeyPattern)
	}
	if it.Checked && it.Group == "" {
		c.bad(path+".checked", "only a group's item is checked (set group)")
	}
	c.action(path+".action", it.Action)
	if it.Submenu == nil {
		return
	}
	if inSub {
		c.bad(path+".submenu", "a submenu's items have no submenus (one level)")
		return
	}
	if it.Danger || it.Group != "" || it.Checked {
		c.bad(path, "a submenu is not danger, grouped or checked (its items are)")
	}
	c.menuItems(path+".submenu", it.Submenu, true)
}

// noMenus refuses a menu on buttons where one does not belong (a header's, a row's or a
// form's: see Button.Menu), saying what to use instead.
func (c *checker) noMenus(path string, bs []Button, instead string) {
	for i, b := range bs {
		if b.Menu != nil {
			c.bad(fmt.Sprintf("%s[%d].menu", path, i), "these buttons do not open menus: %s", instead)
		}
	}
}

// AllItems returns every item of m, a submenu's items after it, in order (separators
// left out): what a walk for acting elements looks at. Nil for a nil menu.
func (m *Menu) AllItems() []MenuItem {
	if m == nil {
		return nil
	}
	var out []MenuItem
	for _, it := range m.Items {
		if it.Separator {
			continue
		}
		out = append(out, it)
		for _, sub := range it.Submenu {
			if !sub.Separator {
				out = append(out, sub)
			}
		}
	}
	return out
}
