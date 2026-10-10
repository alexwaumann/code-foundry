package gh

import (
	"fmt"
	"strings"
)

func (g *fakeGitHub) addCards(rs ...Repository) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.cards = append(g.cards, rs...)
}

func cardJSON(r Repository) map[string]any {
	var desc any
	if r.Description != "" {
		desc = r.Description
	}
	return map[string]any{
		"name": r.Name, "owner": map[string]any{"login": r.Owner}, "description": desc,
		"visibility": cmpString(r.Visibility, "PUBLIC"), "isArchived": r.Archived, "isFork": r.Fork,
		"url": cmpString(r.URL, "https://github.com/"+r.Slug()),
	}
}

// searchOp answers SearchRepositories (every card whose slug or description contains
// the query, case-insensitively, at most first: 20, in insertion order) and
// LookupRepository (case-insensitive owner and name; NOT_FOUND next to a null
// repository otherwise). Called with g.mu held.
func (g *fakeGitHub) searchOp(op string, vars map[string]any, data map[string]any, errs *[]map[string]any) {
	switch op {
	case "SearchRepositories":
		q := strings.ToLower(vars["q"].(string))
		nodes := []any{}
		count := 0
		for _, r := range g.cards {
			if !strings.Contains(strings.ToLower(r.Slug()+" "+r.Description), q) {
				continue
			}
			count++
			if len(nodes) < 20 {
				nodes = append(nodes, cardJSON(r))
			}
		}
		data["search"] = map[string]any{"repositoryCount": count, "nodes": nodes}
	case "LookupRepository":
		owner, name := vars["owner"].(string), vars["name"].(string)
		for _, r := range g.cards {
			if strings.EqualFold(r.Owner, owner) && strings.EqualFold(r.Name, name) {
				data["repository"] = cardJSON(r)
				return
			}
		}
		data["repository"] = nil
		*errs = append(*errs, map[string]any{"type": "NOT_FOUND", "path": []any{"repository"},
			"message": fmt.Sprintf("Could not resolve to a Repository with the name '%s/%s'.", owner, name)})
	}
}
