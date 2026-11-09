package main

import (
	"fmt"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/ui"
)

// The demo's Todo tab (key "todo"): a list's interactive rows. The open tasks are a
// checkable, reorderable list with an add input above it and titles renamed in place; the
// done ones a checkable list in a collapsible section. Ticking a task moves it to Done,
// unticking it back to the end of the open ones. The demo refuses a title another task
// already has (the GUI then shows the task as it was, or keeps the add input's text).

type todoItem struct {
	key, title, due string
	dueTone         ui.Tone
	from            string // line 2
	done            bool
}

type todoState struct {
	items []todoItem // open and done, in order
	next  int
}

func newTodo() todoState {
	return todoState{next: 8, items: []todoItem{
		{key: "todo-1", title: "Answer the plugin menus sketch", due: "Today", dueTone: ui.ToneAttention},
		{key: "todo-2", title: "Review #616 terminal find under a flood", due: "Fri", from: "from thread · Terminal find flood"},
		{key: "todo-3", title: "Write the release notes for v0.22", due: "Mon"},
		{key: "todo-4", title: "Rename CF-412 after the search lands"},
		{key: "todo-5", title: "Try the surface on a second Mac", due: "Nov 14"},
		{key: "todo-6", title: "Promote v0.21.6 to stable", done: true},
		{key: "todo-7", title: "Reply to the packaging ticket", done: true},
	}}
}

func todoNodes(s todoState) []ui.Node {
	var open, done []ui.Row
	for _, it := range s.items {
		r := ui.NewRow(it.key, it.title).AsChecked(it.done).AsEditable()
		if it.due != "" {
			r.Trailing = ui.Spans(ui.T(it.due).WithTone(it.dueTone))
		}
		if it.from != "" {
			r.Line2 = ui.Plain(it.from)
		}
		if it.done {
			done = append(done, r)
		} else {
			open = append(open, r)
		}
	}
	openList := ui.NewList("todo-open", open...).AsCheckable().AsReorderable().WithAddRow("Add a task", false)
	openList.List.EmptyText = "Nothing left to do"
	doneSec := ui.NewSection("todo-done-sec", "Done", ui.NewList("todo-done", done...).AsCheckable())
	doneSec.Section.Meta = ui.Plain(fmt.Sprint(len(done)))
	doneSec.Section.Collapsible = true
	return []ui.Node{
		ui.NewText("todo-intro", ui.Plain(fmt.Sprintf("%d of %d done. Drag a task by its grip (or alt+↑/↓) to reorder; double-click a title or press F2 to rename.", len(done), len(s.items)))),
		openList,
		doneSec,
	}
}

func (s *todoState) find(key string) int {
	return slices.IndexFunc(s.items, func(it todoItem) bool { return it.key == key })
}

// taken refuses a title another task has.
func (s *todoState) taken(title, except string) error {
	if slices.ContainsFunc(s.items, func(it todoItem) bool { return it.key != except && strings.EqualFold(it.title, title) }) {
		return fmt.Errorf("%q is already on the list", title)
	}
	return nil
}

// act applies a row act of the Todo tab's lists.
func (s *todoState) act(act pluginsdk.SurfaceAct) error {
	i := -1
	if act.Kind != pluginsdk.ActAdd {
		if i = s.find(act.Key); i < 0 {
			return fmt.Errorf("no task %q", act.Key)
		}
	}
	switch act.Kind {
	case pluginsdk.ActCheck:
		it := s.items[i]
		it.done = act.Checked()
		// Ticked: first of Done; unticked: last of the open tasks.
		s.items = slices.Delete(s.items, i, i+1)
		at := slices.IndexFunc(s.items, func(x todoItem) bool { return x.done })
		if at < 0 {
			at = len(s.items)
		}
		s.items = slices.Insert(s.items, at, it)
	case pluginsdk.ActMove:
		it := s.items[i]
		s.items = slices.Delete(s.items, i, i+1)
		at := 0
		if after := act.After(); after != "" {
			if at = s.find(after) + 1; at == 0 {
				return fmt.Errorf("no task %q", after)
			}
		}
		s.items = slices.Insert(s.items, at, it)
	case pluginsdk.ActAdd:
		if err := s.taken(act.Text(), ""); err != nil {
			return err
		}
		at := slices.IndexFunc(s.items, func(x todoItem) bool { return x.done })
		if at < 0 {
			at = len(s.items)
		}
		s.items = slices.Insert(s.items, at, todoItem{key: fmt.Sprintf("todo-%d", s.next), title: act.Text()})
		s.next++
	case pluginsdk.ActEdit:
		if err := s.taken(act.Text(), act.Key); err != nil {
			return err
		}
		s.items[i].title = act.Text()
	default:
		return fmt.Errorf("the todo list does not know %s", act.Kind)
	}
	return nil
}
