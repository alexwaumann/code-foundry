package gh

import (
	"embed"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
)

//go:embed queries/*.graphql
var queryFS embed.FS

// Query names (file basenames under queries/).
const (
	queryViewer       = "viewer"
	queryPullRequests = "pull_requests"
	queryPullRequest  = "pull_request"
	queryChecks       = "checks"
)

var (
	fragmentHeadRE = regexp.MustCompile(`^fragment\s+(\w+)\s+on\s+\w+`)
	spreadRE       = regexp.MustCompile(`\.\.\.\s*([A-Za-z_]\w*)`)
)

// loadQueries reads queries/*.graphql once and returns each query document with the
// fragments it uses (transitively) appended.
var loadQueries = sync.OnceValues(func() (map[string]string, error) {
	return buildQueries(queryFS)
})

// query returns the assembled document for name.
func query(name string) (string, error) {
	qs, err := loadQueries()
	if err != nil {
		return "", err
	}
	q, ok := qs[name]
	if !ok {
		return "", fmt.Errorf("gh: unknown query %q", name)
	}
	return q, nil
}

func buildQueries(fsys embed.FS) (map[string]string, error) {
	entries, err := fsys.ReadDir("queries")
	if err != nil {
		return nil, fmt.Errorf("gh: read queries: %w", err)
	}
	raw := map[string]string{}
	for _, e := range entries {
		b, err := fsys.ReadFile("queries/" + e.Name())
		if err != nil {
			return nil, fmt.Errorf("gh: read %s: %w", e.Name(), err)
		}
		raw[strings.TrimSuffix(e.Name(), ".graphql")] = stripComments(string(b))
	}
	frags, err := parseFragments(raw["fragments"])
	if err != nil {
		return nil, err
	}
	delete(raw, "fragments")
	out := make(map[string]string, len(raw))
	for name, doc := range raw {
		q, err := withFragments(doc, frags)
		if err != nil {
			return nil, fmt.Errorf("gh: query %s: %w", name, err)
		}
		out[name] = q
	}
	return out, nil
}

func stripComments(doc string) string {
	var b strings.Builder
	for line := range strings.Lines(doc) {
		if strings.HasPrefix(strings.TrimSpace(line), "#") {
			continue
		}
		b.WriteString(line)
	}
	return strings.TrimSpace(b.String())
}

// parseFragments splits a document of top-level fragment definitions into name -> text.
func parseFragments(doc string) (map[string]string, error) {
	frags := map[string]string{}
	rest := strings.TrimSpace(doc)
	for rest != "" {
		m := fragmentHeadRE.FindStringSubmatch(rest)
		if m == nil {
			return nil, fmt.Errorf("gh: fragments: expected fragment definition at %.40q", rest)
		}
		end, err := matchBrace(rest)
		if err != nil {
			return nil, fmt.Errorf("gh: fragment %s: %w", m[1], err)
		}
		frags[m[1]] = rest[:end]
		rest = strings.TrimSpace(rest[end:])
	}
	return frags, nil
}

// matchBrace returns the index just past the '}' closing the first '{' in s.
func matchBrace(s string) (int, error) {
	depth := 0
	for i, r := range s {
		switch r {
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return i + 1, nil
			}
		}
	}
	return 0, fmt.Errorf("unbalanced braces")
}

// withFragments appends exactly the fragments doc references, transitively, in a
// stable order. GitHub rejects unused fragments, so including all of them is not an
// option.
func withFragments(doc string, frags map[string]string) (string, error) {
	need := map[string]bool{}
	var visit func(text string) error
	visit = func(text string) error {
		for _, m := range spreadRE.FindAllStringSubmatch(text, -1) {
			name := m[1]
			if name == "on" || need[name] {
				continue // "... on Type" is an inline fragment
			}
			f, ok := frags[name]
			if !ok {
				return fmt.Errorf("unknown fragment %s", name)
			}
			need[name] = true
			if err := visit(f); err != nil {
				return err
			}
		}
		return nil
	}
	if err := visit(doc); err != nil {
		return "", err
	}
	names := make([]string, 0, len(need))
	for n := range need {
		names = append(names, n)
	}
	sort.Strings(names)
	parts := []string{doc}
	for _, n := range names {
		parts = append(parts, frags[n])
	}
	return strings.Join(parts, "\n\n") + "\n", nil
}
