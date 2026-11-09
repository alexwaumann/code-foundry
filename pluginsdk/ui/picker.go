package ui

import (
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"
)

// A picker is a dropdown select the plugin searches (Select.Search): people, issues,
// labels, anything the plugin looks up as the user types.
//
// Before the user types it lists the select's Options, under their Group headings ("Recent",
// "Selected"). From SearchMinChars characters on, once typing pauses, the host sends the
// query to the plugin as a search act (pluginsdk.ActSearch: Key the search's key, Action its
// event, Field the field's name, Value the query, trimmed). One search is in flight at a time
// and the newest query goes last. The plugin answers with a view whose Search echoes the act's
// query in Query and lists what matches in Results; until a view echoes the query in the box,
// the host shows "Searching…" and never an older query's results.
//
// Picking sends the field's change like any select's: a single picker closes on a pick (picking
// the chosen option again clears it unless the field is required); a Multiple picker stays open,
// shows the picked values as removable tokens in its search box, and holds at most MaxPicked.
// The trigger names the picked options by their labels: keep every picked value among Options
// (a "Selected" group, say) so a later view still names it.
//
// In a toolbar or footer the picker is a compact trigger, its label then its picked labels
// ("Assignee  Me, Kim"), that opens the picker as a popover.

// Picker limits.
const (
	// MaxOptionGroups is how many groups a picker's Options (and, apart, its Results) list.
	MaxOptionGroups = 8
	MaxOptionDetail = 40 // an option's Detail
	MaxAvatar       = 2  // an option's Avatar: one or two initials
	// MaxPicked is how many values a multiple picker holds.
	MaxPicked = 20
	// MaxSearchQuery bounds a search's query (the act's Value, Search.Query).
	MaxSearchQuery = MaxLabel
	// SearchMinChars is how many characters (trimmed) a query has before the host sends it.
	SearchMinChars = 2
)

// Search is a picker's search: the act the host sends a query with, and the plugin's
// answer to the latest one.
type Search struct {
	// Key is the search act's key: unique in the view like every key. PickerField makes it
	// the field's key + "-search".
	Key string `json:"key"`
	// Event is the search act's action (pluginsdk.ActSearch).
	Event string `json:"event"`
	// Placeholder is the search box's empty text ("Search people"); the default is "Search".
	Placeholder string `json:"placeholder,omitempty"`
	// Query is the query Results answer: the search act's Value, as it came. The host shows
	// Results only while its box holds this query.
	Query string `json:"query,omitempty"`
	// Results are the options matching Query, in the plugin's order (at most MaxOptions,
	// MaxOptionGroups groups). Their keys are not the Options' keys: an option in both lists
	// takes two keys ("recent-ada", "match-ada").
	Results []Option `json:"results,omitempty"`
}

// PickerField returns a select the plugin searches: before the user types it lists
// options; a query typed into it reaches the plugin as a search act with event (Key
// key + "-search"), which the plugin answers with WithResults.
//
//	ui.PickerField("f-assignee", "assignee", "Assignee", "search-people",
//		ui.Opt("r-me", "me", "Me").WithAvatar("AW").InGroup("Recent")).AsMultiple().
//		WithChange("assignee")
func PickerField(key, name, label, event string, options ...Option) Field {
	return Field{Key: key, Name: name, Label: label, Select: &Select{Options: options, Search: &Search{Key: key + "-search", Event: event}}}
}

// AsMultiple returns a select (a picker too) that picks any number of options.
func (f Field) AsMultiple() Field {
	if f.Select != nil {
		s := *f.Select
		s.Multiple = true
		f.Select = &s
	}
	return f
}

// WithValues returns a select with these values picked (a multiple select's; WithValue is
// a single select's).
func (f Field) WithValues(values ...string) Field {
	if f.Select != nil {
		s := *f.Select
		s.Value = slices.Clone(values)
		f.Select = &s
	}
	return f
}

// WithResults returns a picker answering query (the search act's Value, as it came) with
// results. A view whose Query is not the query in the picker's box shows "Searching…".
func (f Field) WithResults(query string, results ...Option) Field {
	if f.Select != nil && f.Select.Search != nil {
		s, search := *f.Select, *f.Select.Search
		search.Query, search.Results = query, results
		s.Search = &search
		f.Select = &s
	}
	return f
}

// WithSearchPlaceholder returns a picker whose search box reads p while empty.
func (f Field) WithSearchPlaceholder(p string) Field {
	if f.Select != nil && f.Select.Search != nil {
		s, search := *f.Select, *f.Select.Search
		search.Placeholder = p
		s.Search = &search
		f.Select = &s
	}
	return f
}

// InGroup returns o listed under the heading group (a picker's option).
func (o Option) InGroup(group string) Option { o.Group = group; return o }

// WithDetail returns o with muted text at its row's end ("platform", "3 open").
func (o Option) WithDetail(detail string) Option { o.Detail = detail; return o }

// WithAvatar returns o led by initials (one or two characters) on a colour the host picks
// from o's value, so one person keeps one colour.
func (o Option) WithAvatar(initials string) Option { o.Avatar = initials; return o }

// WithIcon returns o led by a lucide icon (a picker's option).
func (o Option) WithIcon(name string) Option { o.Icon = name; return o }

// AsDisabled returns o shown but not pickable.
func (o Option) AsDisabled() Option { o.Disabled = true; return o }

// options checks a select's options (or a picker's results) at path: keys, labels, values,
// and a picker's groups, details, avatars and icons.
func (c *checker) options(path string, opts []Option, picker bool) {
	if len(opts) > MaxOptions {
		c.bad(path, "%d options, at most %d", len(opts), MaxOptions)
	}
	groups := map[string]bool{}
	for i, o := range opts {
		op := fmt.Sprintf("%s[%d]", path, i)
		c.key(op, o.Key)
		c.required(op+".label", o.Label)
		c.str(op+".label", o.Label, MaxLabel)
		c.str(op+".value", o.Value, MaxLabel)
		c.inline(op+".description", o.Description, MaxLabel)
		if !picker {
			if o.Group != "" || o.Detail != "" || o.Avatar != "" || o.Icon != "" {
				c.bad(op, "group, detail, avatar and icon are a picker's (a select with search)")
			}
			continue
		}
		if o.Group != "" {
			groups[o.Group] = true
			c.str(op+".group", o.Group, MaxSectionTitle)
		}
		c.str(op+".detail", o.Detail, MaxOptionDetail)
		if o.Avatar != "" {
			if strings.TrimSpace(o.Avatar) == "" || utf8.RuneCountInString(o.Avatar) > MaxAvatar {
				c.bad(op+".avatar", "%q: one or two initials", o.Avatar)
			}
			if o.Icon != "" {
				c.bad(op, "an avatar or an icon, not both")
			}
		}
		c.icon(op+".icon", o.Icon)
		if o.Description != nil {
			c.bad(op+".description", "a picker's option has a detail, not a description")
		}
	}
	if len(groups) > MaxOptionGroups {
		c.bad(path, "%d groups, at most %d", len(groups), MaxOptionGroups)
	}
}

// search checks a picker's search at path (the select's own rules are field's).
func (c *checker) search(path string, f Field) {
	s := f.Select
	q := s.Search
	c.key(path, q.Key)
	if q.Event == "" {
		c.bad(path+".event", "required: the event the host sends a query with")
	}
	c.str(path+".event", q.Event, 64)
	if f.Change != nil && f.Change.Event != "" && f.Change.Event == q.Event {
		// Acts name their key, but a CLI act may name only the event.
		c.bad(path+".event", "%q is also the field's change event", q.Event)
	}
	c.str(path+".placeholder", q.Placeholder, MaxLabel)
	c.str(path+".query", q.Query, MaxSearchQuery)
	if len(q.Results) > 0 && strings.TrimSpace(q.Query) == "" {
		c.bad(path+".results", "results answer a query: echo the search act's value in query")
	}
	c.options(path+".results", q.Results, true)
	if s.Style == SelectList {
		c.bad(path, "a picker is a dropdown, not a list")
	}
	if s.OptionsSource != "" {
		c.bad(path, "a picker's options are the plugin's, not a source's")
	}
	if len(s.Value) > MaxPicked {
		c.bad(strings.TrimSuffix(path, ".search")+".value", "%d values, at most %d", len(s.Value), MaxPicked)
	}
}
