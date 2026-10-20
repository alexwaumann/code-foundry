package guide

import (
	"cmp"
	"fmt"
	"io"
	"slices"
	"strings"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Topics (docs/notes/hidden-children-1-daemon.md): the guide grew past what Claude's
// Bash tool hands an agent whole (29,000 bytes), so it is split. `code-foundry guide`
// is the intro, the conventions and the Thread commands in detail, then every other
// category as a topic line naming its commands; `code-foundry guide <topic>` prints one
// topic's commands with their whole descriptions and flags.

// Topic is one category of commands the guide leaves to `code-foundry guide <topic>`.
type Topic struct {
	// Name is what `code-foundry guide` takes: the category in lower case, spaces as
	// hyphens ("pull-request").
	Name     string
	Category string
	// Commands are the topic's command names, sorted.
	Commands []string
}

// TopicName is the topic name of a category: "Pull Request" → "pull-request".
func TopicName(category string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(category)), " ", "-")
}

// Topics are the categories of cmds (without LeftOut ones) the top-level guide does not
// list in detail, the agent's first (guideCategoryOrder), then by name.
func Topics(cmds []*v1.Command) []Topic {
	byCat := byCategory(slices.DeleteFunc(slices.Clone(cmds), LeftOut))
	var out []Topic
	for _, cat := range sortedCategories(byCat) {
		if slices.Contains(guideDetailed, cat) {
			continue
		}
		t := Topic{Name: TopicName(cat), Category: cat}
		for _, c := range byCat[cat] {
			t.Commands = append(t.Commands, c.GetName())
		}
		slices.Sort(t.Commands)
		out = append(out, t)
	}
	return out
}

// WriteTopic writes the topic name's commands of cmds, each with its whole description
// and one line per flag. An unknown name is an error naming the topics.
func WriteTopic(w io.Writer, cmds []*v1.Command, name string) error {
	topics := Topics(cmds)
	i := slices.IndexFunc(topics, func(t Topic) bool { return t.Name == TopicName(name) })
	if i < 0 {
		names := make([]string, len(topics))
		for j, t := range topics {
			names[j] = t.Name
		}
		return fmt.Errorf("no guide topic %q; topics: %s (thread commands are in the guide itself)", name, strings.Join(names, ", "))
	}
	t := topics[i]
	fmt.Fprintf(w, "# code-foundry guide: %s\n\n", t.Category)
	fmt.Fprintf(w, "Conventions, ids and exit codes: `code-foundry guide`. Every flag of one command: `code-foundry help <command>`.\n")
	var list []*v1.Command
	for _, c := range cmds {
		if !LeftOut(c) && c.GetCategory() == t.Category {
			list = append(list, c)
		}
	}
	writeCategory(w, "##", t.Category, list, true)
	return nil
}

// writeTopicList is the top-level guide's list of topics: one line each with its
// command names.
func writeTopicList(w io.Writer, topics []Topic) {
	fmt.Fprintf(w, "\n## More commands: `code-foundry guide <topic>`\n\n")
	fmt.Fprintf(w, "Each topic prints its commands with their descriptions and flags.\n\n")
	for _, t := range topics {
		names := make([]string, len(t.Commands))
		for i, n := range t.Commands {
			names[i] = "`" + n + "`"
		}
		fmt.Fprintf(w, "- `%s`: %s\n", t.Name, strings.Join(names, ", "))
	}
}

// sortedCategories are byCat's categories, guideCategoryOrder first, then by name.
func sortedCategories(byCat map[string][]*v1.Command) []string {
	cats := make([]string, 0, len(byCat))
	for c := range byCat {
		cats = append(cats, c)
	}
	slices.Sort(cats)
	rank := func(c string) int {
		if i := slices.Index(guideCategoryOrder, c); i >= 0 {
			return i
		}
		return len(guideCategoryOrder)
	}
	slices.SortStableFunc(cats, func(a, b string) int { return cmp.Compare(rank(a), rank(b)) })
	return cats
}
