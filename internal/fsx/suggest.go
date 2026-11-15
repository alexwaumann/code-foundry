package fsx

import (
	"context"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/fuzzy"
)

// Suggestions for the field that adds an include pattern
// (FilesystemService.SuggestIncludeIgnored).

// Bounds of SuggestIgnored.
const (
	// DefaultSuggestLimit and MaxSuggestLimit bound the suggestions returned.
	DefaultSuggestLimit = 20
	MaxSuggestLimit     = 100
	// suggestCountCap is how many files of one folder are counted.
	suggestCountCap = 1_000
	// suggestCountBudget bounds the entries read counting every suggested folder.
	suggestCountBudget = 50_000
)

// IgnoredSuggestion is one ignored entry offered as a pattern.
type IgnoredSuggestion struct {
	IgnoredEntry
	// Files is a folder's file count; FilesCapped: at least that many (or, at 0, not
	// counted).
	Files       int
	FilesCapped bool
	// Included: the effective patterns already include the whole entry.
	Included bool
	// MatchesText: the typed text, as a pattern, includes the whole entry.
	MatchesText bool
	// Positions are the rune indices of Path the text matched.
	Positions []int
}

// Suggestions is SuggestIgnored's answer.
type Suggestions struct {
	Entries []IgnoredSuggestion
	// Truncated: more entries matched than Entries holds.
	Truncated bool
	// TextFiles is how many files text includes as a pattern on its own; TextFilesCapped:
	// at least that many. TextError says why text is not a valid pattern.
	TextFiles       int
	TextFilesCapped bool
	TextError       string
}

// SuggestIgnored lists the ignored entries of the git checkout dir (IgnoredEntries)
// that text fuzzy-matches, best first, at most limit (zero: DefaultSuggestLimit, at most
// MaxSuggestLimit), each folder with its file count, and marks those the include
// patterns already cover. It also counts the files text would include as a pattern.
func SuggestIgnored(ctx context.Context, dir string, include []string, text string, limit int) (Suggestions, error) {
	if limit <= 0 {
		limit = DefaultSuggestLimit
	}
	limit = min(limit, MaxSuggestLimit)
	entries, _, err := IgnoredEntries(ctx, dir)
	if err != nil {
		return Suggestions{}, err
	}
	var out Suggestions
	var textPats []includePattern
	if t := strings.TrimSpace(text); t != "" {
		if err := checkIncludePattern(t); err != nil {
			out.TextError = strings.TrimPrefix(err.Error(), ErrInvalidArgument.Error()+": ")
		} else {
			textPats = compileIncludes([]string{t})
			files, capped, err := includedFrom(ctx, dir, entries, textPats, MaxIncludedFiles)
			if err != nil {
				return Suggestions{}, err
			}
			out.TextFiles, out.TextFilesCapped = len(files), capped
		}
	}

	picked := suggestPicks(entries, textPats, suggestQuery(text), limit, &out.Truncated)
	effective := compileIncludes(include)
	budget := suggestCountBudget
	for _, pk := range picked {
		if err := ctx.Err(); err != nil {
			return Suggestions{}, err
		}
		e := entries[pk.index]
		s := IgnoredSuggestion{
			IgnoredEntry: e,
			Included:     matchUp(effective, e.Path, e.Dir),
			MatchesText:  matchUp(textPats, e.Path, e.Dir),
			Positions:    pk.positions,
		}
		if e.Dir {
			w := &includeWalker{ctx: ctx, root: dir, max: suggestCountCap, budget: budget}
			w.walk(e.Path, nil)
			budget = max(w.budget, 0)
			s.Files, s.FilesCapped = len(w.files), w.full
		}
		out.Entries = append(out.Entries, s)
	}
	if err := ctx.Err(); err != nil {
		return Suggestions{}, err
	}
	return out, nil
}

type suggestPick struct {
	index     int
	positions []int
}

// suggestPicks chooses at most limit entries: first those the text as a pattern
// includes or reaches into (in path order), then the fuzzy matches of query, best first.
// truncated is set when more qualified.
func suggestPicks(entries []IgnoredEntry, textPats []includePattern, query string, limit int, truncated *bool) []suggestPick {
	words := fuzzy.Words(query)
	var out []suggestPick
	taken := map[int]bool{}
	for i, e := range entries {
		if len(textPats) == 0 {
			break
		}
		reaches := e.Dir && slices.ContainsFunc(textPats, func(p includePattern) bool { return p.names(e.Path) })
		if !reaches && !matchUp(textPats, e.Path, e.Dir) {
			continue
		}
		if len(out) == limit {
			*truncated = true
			return out
		}
		out = append(out, suggestPick{index: i, positions: fuzzy.PositionsWords(e.Path, words)})
		taken[i] = true
	}
	paths := make([]string, len(entries))
	for i, e := range entries {
		paths[i] = e.Path
	}
	hits, more := fuzzy.RankSources([]fuzzy.Source{{Paths: paths}}, query, limit)
	for _, h := range hits {
		if taken[h.Index] {
			continue
		}
		if len(out) == limit {
			*truncated = true
			return out
		}
		out = append(out, suggestPick{index: h.Index, positions: h.PathPositions})
	}
	*truncated = *truncated || more
	return out
}

// suggestQuery is text as a fuzzy query: glob characters and the slashes at its ends
// dropped (".env*" looks for ".env", "dist/" for "dist"), at most fuzzy.MaxWords words.
func suggestQuery(text string) string {
	q := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`*?[]\!`, r) {
			return -1
		}
		return r
	}, text)
	words := fuzzy.Words(strings.Trim(q, "/"))
	return strings.Join(words[:min(len(words), fuzzy.MaxWords)], " ")
}

// MergeIncludes joins pattern lists in order, without repeats: the setting's, then the
// project's.
func MergeIncludes(lists ...[]string) []string {
	var out []string
	for _, l := range lists {
		for _, p := range l {
			if !slices.Contains(out, p) {
				out = append(out, p)
			}
		}
	}
	return out
}
