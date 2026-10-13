// Package pricing prices Claude API token usage (docs/notes/session-usage.md).
//
// Rates are USD per million tokens, Claude API first-party, from
// platform.claude.com/docs/en/about-claude/pricing (fetched 2026-10-10). Partner clouds
// differ and are out of scope. The table is explicit rather than derived: cache reads
// are 0.1x input for most models but 0.025x (Fable 5.1) and 0.05x (Opus 5.5, Sonnet
// 5.5) for others. Adding a model is one line in rates and a test row.
//
// The package imports no store: the API layer and the command registry convert their
// counters to a Bucket. Cost is computed at read time and never stored.
package pricing

import (
	"strings"
	"time"
)

// Rate is USD per million tokens.
type Rate struct {
	Input, Output, CacheWrite5m, CacheWrite1h, CacheRead float64
}

// TierLong is the Haiku 5.5 long-prompt tier (a request whose prompt, input plus
// cache read plus cache write, is over LongPromptTokens).
const TierLong = "long"

// SpeedFast is fast mode (usage.speed "fast").
const SpeedFast = "fast"

// LongPromptTokens is the prompt size above which a Haiku 5.5 request is billed at the
// long tier.
const LongPromptTokens = 100_000

// HasLongTier reports whether model has a long-prompt tier (only Haiku 5.5).
func HasLongTier(model string) bool {
	id, ok := canonical(model)
	return ok && id == "claude-haiku-5-5"
}

var rates = map[string]Rate{
	"claude-fable-5-1":  {Input: 10, Output: 50, CacheWrite5m: 12.5, CacheWrite1h: 20, CacheRead: 0.25},
	"claude-fable-5":    {Input: 10, Output: 50, CacheWrite5m: 12.5, CacheWrite1h: 20, CacheRead: 1},
	"claude-mythos-5-1": {Input: 10, Output: 50, CacheWrite5m: 12.5, CacheWrite1h: 20, CacheRead: 0.25}, // Fable's row
	"claude-mythos-5":   {Input: 10, Output: 50, CacheWrite5m: 12.5, CacheWrite1h: 20, CacheRead: 1},    // Fable's row
	"claude-opus-5-5":   {Input: 4, Output: 20, CacheWrite5m: 5, CacheWrite1h: 8, CacheRead: 0.2},
	"claude-opus-5":     {Input: 5, Output: 25, CacheWrite5m: 6.25, CacheWrite1h: 10, CacheRead: 0.5},
	"claude-opus-4-8":   {Input: 5, Output: 25, CacheWrite5m: 6.25, CacheWrite1h: 10, CacheRead: 0.5},
	"claude-opus-4-7":   {Input: 5, Output: 25, CacheWrite5m: 6.25, CacheWrite1h: 10, CacheRead: 0.5},
	"claude-opus-4-6":   {Input: 5, Output: 25, CacheWrite5m: 6.25, CacheWrite1h: 10, CacheRead: 0.5},
	"claude-sonnet-5-5": {Input: 2, Output: 10, CacheWrite5m: 2.5, CacheWrite1h: 4, CacheRead: 0.1},
	"claude-sonnet-5":   {Input: 2, Output: 10, CacheWrite5m: 2.5, CacheWrite1h: 4, CacheRead: 0.2},
	"claude-sonnet-4-6": {Input: 3, Output: 15, CacheWrite5m: 3.75, CacheWrite1h: 6, CacheRead: 0.3},
	"claude-haiku-5-5":  {Input: 0.1, Output: 0.5, CacheWrite5m: 0.125, CacheWrite1h: 0.2, CacheRead: 0.01},
	"claude-haiku-4-5":  {Input: 1, Output: 5, CacheWrite5m: 1.25, CacheWrite1h: 2, CacheRead: 0.1},
}

// longRates are the long-prompt tier's rates, by canonical id.
var longRates = map[string]Rate{
	"claude-haiku-5-5": {Input: 0.5, Output: 2.5, CacheWrite5m: 0.625, CacheWrite1h: 1, CacheRead: 0.05},
}

// fastMultiplier is the fast-mode price multiplier, by canonical id. Models without an
// entry have no fast mode: a "fast" bucket for them is unpriced rather than guessed.
var fastMultiplier = map[string]float64{
	"claude-opus-5-5": 2,
	"claude-opus-5":   2,
	"claude-opus-4-8": 2,
}

// canonical maps a model id to its row in rates: the id itself, else the longest table
// id that prefixes it followed by a date stamp ("-20251001") or a bracketed or "@"
// suffix ("[1m]", "@2026…"). A longer version ("claude-opus-5-6") does not match a
// shorter row ("claude-opus-5"): an unknown model is unpriced, never mispriced.
func canonical(model string) (string, bool) {
	if _, ok := rates[model]; ok {
		return model, true
	}
	best := ""
	for id := range rates {
		if len(id) > len(best) && strings.HasPrefix(model, id) && versionSuffix(model[len(id):]) {
			best = id
		}
	}
	return best, best != ""
}

// versionSuffix reports whether rest (what follows a known id) names a snapshot of that
// model rather than another model.
func versionSuffix(rest string) bool {
	switch {
	case strings.HasPrefix(rest, "["), strings.HasPrefix(rest, "@"):
		return true
	case len(rest) >= 9 && rest[0] == '-':
		for _, c := range rest[1:9] {
			if c < '0' || c > '9' {
				return false
			}
		}
		return len(rest) == 9 || !isDigit(rest[9])
	}
	return false
}

func isDigit(c byte) bool { return c >= '0' && c <= '9' }

// Lookup returns the rate for a bucket's (model, tier, speed). ok is false for an
// unknown model, a tier the model does not have, or fast mode on a model without it:
// the caller shows "unpriced", never $0.
func Lookup(model, tier, speed string) (Rate, bool) {
	id, ok := canonical(model)
	if !ok {
		return Rate{}, false
	}
	r := rates[id]
	switch tier {
	case "":
	case TierLong:
		if r, ok = longRates[id]; !ok {
			return Rate{}, false
		}
	default:
		return Rate{}, false
	}
	switch speed {
	case "":
	case SpeedFast:
		m, ok := fastMultiplier[id]
		if !ok {
			return Rate{}, false
		}
		r = Rate{Input: r.Input * m, Output: r.Output * m, CacheWrite5m: r.CacheWrite5m * m,
			CacheWrite1h: r.CacheWrite1h * m, CacheRead: r.CacheRead * m}
	default:
		return Rate{}, false
	}
	return r, true
}

// Bucket is the part of a usage bucket pricing reads: the rate key and the token
// counters.
type Bucket struct {
	Model, Tier, Speed                                   string
	Input, Output, CacheRead, CacheWrite5m, CacheWrite1h int64
}

// Costs is a bucket's price split by token kind, in USD.
type Costs struct {
	Input, Output, CacheRead, CacheWrite5m, CacheWrite1h float64
}

// Total is the sum of the kinds.
func (c Costs) Total() float64 {
	return c.Input + c.Output + c.CacheRead + c.CacheWrite5m + c.CacheWrite1h
}

// CostByKind prices one bucket with Lookup, per token kind (the side panel's token table
// shows a cost per kind). ok is false when the bucket is unpriced.
func CostByKind(b Bucket) (Costs, bool) {
	r, ok := Lookup(b.Model, b.Tier, b.Speed)
	if !ok {
		return Costs{}, false
	}
	return Costs{
		Input:        float64(b.Input) * r.Input / 1e6,
		Output:       float64(b.Output) * r.Output / 1e6,
		CacheRead:    float64(b.CacheRead) * r.CacheRead / 1e6,
		CacheWrite5m: float64(b.CacheWrite5m) * r.CacheWrite5m / 1e6,
		CacheWrite1h: float64(b.CacheWrite1h) * r.CacheWrite1h / 1e6,
	}, true
}

// Cost prices one bucket with Lookup: CostByKind's total. ok is false when the bucket is
// unpriced.
func Cost(b Bucket) (usd float64, ok bool) {
	c, ok := CostByKind(b)
	return c.Total(), ok
}

// CacheSavings is what the bucket's cache reads saved against paying the input rate for
// the same tokens: CacheRead x (input rate - cache read rate), at the bucket's (model,
// tier, speed). 0 for an unpriced bucket.
func CacheSavings(b Bucket) float64 {
	r, ok := Lookup(b.Model, b.Tier, b.Speed)
	if !ok {
		return 0
	}
	return float64(b.CacheRead) * (r.Input - r.CacheRead) / 1e6
}

// shortCacheTTL is the short prompt-cache lifetime; a longer TTL is billed at the 1 h
// write rate.
const shortCacheTTL = 5 * time.Minute

// RereadCost is what sending tokens of context again costs once its prompt cache
// expired: every token is written to the cache again, at model's 1 h cache-write rate
// when ttl is over 5 minutes (what Claude Code writes on the main thread), else the
// 5 min rate. ok is false for a model without a known rate.
func RereadCost(model string, tokens int64, ttl time.Duration) (usd float64, ok bool) {
	r, ok := Lookup(model, "", "")
	if !ok {
		return 0, false
	}
	rate := r.CacheWrite1h
	if ttl <= shortCacheTTL {
		rate = r.CacheWrite5m
	}
	return float64(tokens) * rate / 1e6, true
}
