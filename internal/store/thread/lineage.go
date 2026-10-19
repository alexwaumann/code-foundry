package thread

import (
	"cmp"
	"slices"
	"time"
)

// A thread's subtree (ListOptions.DescendantsOf; docs/notes/orch-descendants.md): the
// thread, the threads it created, the threads those created, and so on, for an
// orchestrator that asks "give me the tree", "cost by team" or "archive team B" in one
// call instead of walking --created-by one level at a time.

// MaxLineageDepth is how far below its root a subtree goes: a thread deeper than this
// is left out. Orchestrations nest two or three levels; the cap only bounds a runaway.
const MaxLineageDepth = 8

// LineageNode is one thread of the lineage Subtree walks: its id, its creator's
// (CreatedBy, "" for the user's) and when it was created (siblings go in that order).
type LineageNode struct {
	ID, CreatedBy string
	CreatedAt     time.Time
}

// SubtreeEntry is one thread of a subtree and how far below the root it is (0: the
// root, 1: a thread the root created).
type SubtreeEntry struct {
	ID    string
	Depth int
}

// Subtree returns root and every thread below it in nodes, depth first: each thread
// before the threads it created, siblings oldest first (then by id), at most
// MaxLineageDepth levels below root. The root comes first at depth 0 even when nodes
// lacks it (a removed root's children are still its subtree). A creator cycle (a thread
// recorded as created by its own descendant) is cut where it closes: each thread is
// listed once.
func Subtree(nodes []LineageNode, root string) []SubtreeEntry {
	if root == "" {
		return nil
	}
	kids := map[string][]LineageNode{}
	for _, n := range nodes {
		if n.CreatedBy != "" && n.ID != n.CreatedBy {
			kids[n.CreatedBy] = append(kids[n.CreatedBy], n)
		}
	}
	for _, list := range kids {
		slices.SortFunc(list, func(a, b LineageNode) int {
			return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), cmp.Compare(a.ID, b.ID))
		})
	}
	seen := map[string]bool{root: true}
	out := []SubtreeEntry{{ID: root}}
	var walk func(id string, depth int)
	walk = func(id string, depth int) {
		if depth > MaxLineageDepth {
			return
		}
		for _, k := range kids[id] {
			if seen[k.ID] {
				continue
			}
			seen[k.ID] = true
			out = append(out, SubtreeEntry{ID: k.ID, Depth: depth})
			walk(k.ID, depth+1)
		}
	}
	walk(root, 1)
	return out
}

// lineageNodes are the lineage of threads and of the removed threads: a removed
// thread between the root and a live one keeps the line (its children's CreatedBy
// still names it), in its place among its siblings (its CreatedAt).
func lineageNodes(threads []Thread, removed []RemovedThread) []LineageNode {
	out := make([]LineageNode, 0, len(threads)+len(removed))
	for _, t := range threads {
		out = append(out, LineageNode{ID: t.ID, CreatedBy: t.CreatedBy, CreatedAt: t.CreatedAt})
	}
	for _, r := range removed {
		out = append(out, LineageNode{ID: r.ID, CreatedBy: r.CreatedBy, CreatedAt: r.CreatedAt})
	}
	return out
}
