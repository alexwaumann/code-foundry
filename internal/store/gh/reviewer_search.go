package gh

import (
	"cmp"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"
)

// The reviewer picker's search of several words. GitHub's assignableUsers(query:)
// matches the whole string against the login and the stored profile name, so "jane doe"
// finds nobody whose name is stored as "Doe, Jane". ReviewerCandidates asks for each
// word as well (aliased fields of the same document) and keeps the users matching every
// word, best matches first.
//
// For repositories with <=100 assignable users (!hasNextPage), the store caches the full
// list per repository slug for assignableCacheTTL (bounded LRU) along with each pull
// request's author and pending review requests, so subsequent search keystrokes filter
// locally with zero GitHub requests. Huge repositories (hasNextPage == true) fall back
// cleanly to the GraphQL query.

// reviewerSearchMaxTokens caps the words a search asks for on their own: one aliased
// assignableUsers field each (t0..t3 in reviewer_candidates.graphql).
const (
	reviewerSearchMaxTokens = 4
	reviewerSearchLimit     = 20

	assignableCacheTTL  = 10 * time.Minute
	assignableCacheMax  = 64
	prReviewersCacheTTL = 2 * time.Minute
	prReviewersCacheMax = 64
)

type repoAssignableEntry struct {
	users     []ReviewerCandidate
	truncated bool
	fetchedAt time.Time
	seq       uint64
}

type prReviewersEntry struct {
	author    string // lower-cased login
	requested []ReviewerCandidate
	fetchedAt time.Time
	seq       uint64
}

// reviewerCache caches assignable users per repository slug and pending review requests
// per pull request, both bounded by LRU and TTL. The zero value is ready to use.
type reviewerCache struct {
	mu    sync.Mutex
	repos map[string]*repoAssignableEntry
	prs   map[fullKey]*prReviewersEntry
	prGen map[fullKey]uint64
	seq   uint64
}

func (c *reviewerCache) repo(slug string, now time.Time) (users []ReviewerCandidate, truncated, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.repos[slug]
	if !found || now.Sub(e.fetchedAt) >= assignableCacheTTL {
		return nil, false, false
	}
	c.seq++
	e.seq = c.seq
	return e.users, e.truncated, true
}

func (c *reviewerCache) putRepo(slug string, users []ReviewerCandidate, truncated bool, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.repos == nil {
		c.repos = map[string]*repoAssignableEntry{}
	}
	c.seq++
	var cp []ReviewerCandidate
	if !truncated {
		cp = slices.Clone(users)
	}
	c.repos[slug] = &repoAssignableEntry{
		users:     cp,
		truncated: truncated,
		fetchedAt: now,
		seq:       c.seq,
	}
	for len(c.repos) > assignableCacheMax {
		var oldest string
		var minSeq uint64
		first := true
		for k, e := range c.repos {
			if k != slug && (first || e.seq < minSeq) {
				oldest, minSeq, first = k, e.seq, false
			}
		}
		if first {
			return
		}
		delete(c.repos, oldest)
	}
}

func (c *reviewerCache) pr(k fullKey, now time.Time) (author string, requested []ReviewerCandidate, ok bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, found := c.prs[k]
	if !found || now.Sub(e.fetchedAt) >= prReviewersCacheTTL {
		return "", nil, false
	}
	c.seq++
	e.seq = c.seq
	return e.author, slices.Clone(e.requested), true
}

func (c *reviewerCache) prGeneration(k fullKey) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.prGen[k]
}

func (c *reviewerCache) putPR(k fullKey, gen uint64, author string, requested []ReviewerCandidate, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prGen[k] != gen {
		return // invalidated while the fetch was in flight
	}
	if c.prs == nil {
		c.prs = map[fullKey]*prReviewersEntry{}
	}
	c.seq++
	c.prs[k] = &prReviewersEntry{
		author:    author,
		requested: slices.Clone(requested),
		fetchedAt: now,
		seq:       c.seq,
	}
	for len(c.prs) > prReviewersCacheMax {
		var oldest fullKey
		var minSeq uint64
		first := true
		for key, e := range c.prs {
			if key != k && (first || e.seq < minSeq) {
				oldest, minSeq, first = key, e.seq, false
			}
		}
		if first {
			return
		}
		delete(c.prs, oldest)
	}
}

func (c *reviewerCache) invalidatePR(k fullKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.prGen == nil {
		c.prGen = map[fullKey]uint64{}
	}
	c.prGen[k]++
	delete(c.prs, k)
}

// localReviewerCandidates answers a non-empty reviewer search against the cached
// repository assignable users without hitting GitHub.
func localReviewerCandidates(author string, requested, assignable []ReviewerCandidate, query string) ReviewerCandidates {
	seen := make(map[string]bool, len(requested)+1)
	if author != "" {
		seen[author] = true
	}
	for _, r := range requested {
		seen[strings.ToLower(r.Login)] = true
	}
	pool := make([]ReviewerCandidate, 0, len(assignable))
	for _, u := range assignable {
		key := strings.ToLower(u.Login)
		if u.Login == "" || seen[key] {
			continue
		}
		seen[key] = true
		pool = append(pool, u)
	}
	tokens := reviewerSearchTokens(query)
	var others []ReviewerCandidate
	if len(foldTokens(tokens)) > 0 {
		others = filterReviewerSearch(pool, tokens)
	} else if q := strings.ToLower(query); q != "" {
		for _, u := range pool {
			if strings.Contains(strings.ToLower(u.Login), q) || strings.Contains(strings.ToLower(u.Name), q) {
				others = append(others, u)
			}
		}
		slices.SortStableFunc(others, func(a, b ReviewerCandidate) int {
			return strings.Compare(strings.ToLower(a.Login), strings.ToLower(b.Login))
		})
	}
	if len(others) > reviewerSearchLimit {
		others = others[:reviewerSearchLimit]
	}
	out := make([]ReviewerCandidate, 0, len(requested)+len(others))
	out = append(out, requested...)
	out = append(out, others...)
	return ReviewerCandidates{Candidates: out}
}

// reviewerSearchTokens splits a search into its words: on whitespace and commas, empty
// pieces dropped, at most reviewerSearchMaxTokens.
func reviewerSearchTokens(query string) []string {
	f := strings.FieldsFunc(query, func(r rune) bool { return r == ',' || unicode.IsSpace(r) })
	if len(f) > reviewerSearchMaxTokens {
		f = f[:reviewerSearchMaxTokens]
	}
	return f
}

// foldSearch lowercases s and drops everything but letters and digits, so "Doe, Jane",
// "jane-doe" and "O'Brien" compare by their letters.
func foldSearch(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// foldTokens folds each token, dropping those with no letter or digit (they would
// match anyone).
func foldTokens(tokens []string) []string {
	out := make([]string, 0, len(tokens))
	for _, t := range tokens {
		if f := foldSearch(t); f != "" {
			out = append(out, f)
		}
	}
	return out
}

// Match quality, best first.
const (
	rankLoginPrefix = iota // the login starts with one of the words
	rankNamePrefix         // every word starts a word of the name
	rankContains           // every word is somewhere in the login or the name
)

// reviewerSearchRank reports whether the login or the name contains every folded token
// (each in either one), and how well: one of the rank constants.
func reviewerSearchRank(login, name string, tokens []string) (int, bool) {
	l, n := foldSearch(login), foldSearch(name)
	for _, t := range tokens {
		if !strings.Contains(l, t) && !strings.Contains(n, t) {
			return 0, false
		}
	}
	for _, t := range tokens {
		if strings.HasPrefix(l, t) {
			return rankLoginPrefix, true
		}
	}
	// Name words split on whitespace and punctuation, apostrophes kept ("O'Brien").
	words := strings.FieldsFunc(name, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '\'' })
	for i, w := range words {
		words[i] = foldSearch(w)
	}
	for _, t := range tokens {
		if !slices.ContainsFunc(words, func(w string) bool { return strings.HasPrefix(w, t) }) {
			return rankContains, true
		}
	}
	return rankNamePrefix, true
}

// filterReviewerSearch keeps the candidates matching every token, ordered by match
// quality, then by login (case-insensitive).
func filterReviewerSearch(cands []ReviewerCandidate, tokens []string) []ReviewerCandidate {
	folded := foldTokens(tokens)
	type ranked struct {
		c    ReviewerCandidate
		rank int
	}
	var keep []ranked
	for _, c := range cands {
		if r, ok := reviewerSearchRank(c.Login, c.Name, folded); ok {
			keep = append(keep, ranked{c, r})
		}
	}
	slices.SortStableFunc(keep, func(a, b ranked) int {
		return cmp.Or(cmp.Compare(a.rank, b.rank), strings.Compare(strings.ToLower(a.c.Login), strings.ToLower(b.c.Login)))
	})
	out := make([]ReviewerCandidate, 0, len(keep))
	for _, k := range keep {
		out = append(out, k.c)
	}
	return out
}

// reviewerCandidatesVars are the ReviewerCandidates document's variables: search is set
// only for a non-empty query, and s0..s3 (with q0..q3) only for a query of several
// words, one per word.
func reviewerCandidatesVars(owner, name string, number int, query string) map[string]any {
	return reviewerCandidatesVarsWith(owner, name, number, query, false, query != "")
}

func reviewerCandidatesVarsWith(owner, name string, number int, query string, fetchAll, doSearch bool) map[string]any {
	v := map[string]any{
		"owner":  owner,
		"name":   name,
		"number": number,
		"query":  query,
		"search": doSearch,
		"all":    fetchAll,
	}
	var tokens []string
	if doSearch {
		tokens = reviewerSearchTokens(query)
		if len(tokens) < 2 {
			tokens = nil
		}
	}
	for i := range reviewerSearchMaxTokens {
		q := ""
		if i < len(tokens) {
			q = tokens[i]
		}
		v[fmt.Sprintf("q%d", i)] = q
		v[fmt.Sprintf("s%d", i)] = q != ""
	}
	return v
}
