package thread

import (
	"time"

	"github.com/alexwaumann/code-foundry/internal/claudestream"
)

// Context totals of rendered threads (docs/notes/rendered-threads-cold-cache.md).
//
// After every result the thread records its context size (Session.ContextTokens), the
// model that answered and when (LastResultAt). The prompt cache refreshes on every hit,
// so the conversation's cache expires one TTL after its last request:
// CacheExpiresAt = LastResultAt + the store's cache TTL (the sessions.cache_ttl_seconds
// setting, applied live with SetCacheTTL). Claude Code exposes its TTL only to hooks,
// which managed settings forbid, so the daemon keeps it as a setting.

// DefaultCacheTTL is the prompt cache lifetime of the Claude API's main thread on
// Bedrock and the Anthropic API (Claude Code writes 1 h cache entries).
const DefaultCacheTTL = time.Hour

// usageTokens is one API response's context size, Claude Code's own definition (what
// get_context_usage reports as totalTokens): input + cache read + cache write + output.
func usageTokens(u *claudestream.APIUsage) int64 {
	if u == nil {
		return 0
	}
	return u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens + u.OutputTokens
}

// turnContext is a turn's context size: the last top-level response's (last, from the
// stream; 0 when none was seen), else the result's own usage. A result's usage sums
// every API call of the turn (a tool call makes two), so it is only a fallback: it is
// the context exactly when the turn made one call.
func turnContext(last int64, result *claudestream.APIUsage) int64 {
	if last > 0 {
		return last
	}
	return usageTokens(result)
}

// cacheExpiry is when a cache last refreshed at last expires; zero when last is.
func cacheExpiry(last time.Time, ttl time.Duration) time.Time {
	if last.IsZero() {
		return time.Time{}
	}
	return last.Add(ttl)
}

// cacheTTL is the TTL in effect. Callers hold m.mu.
func (m *Manager) cacheTTLLocked() time.Duration {
	if m.cacheTTL > 0 {
		return m.cacheTTL
	}
	return DefaultCacheTTL
}

// SetCacheTTL changes the prompt cache lifetime (the sessions.cache_ttl_seconds
// setting) and recomputes every thread's CacheExpiresAt, publishing the threads whose
// expiry moved. A ttl <= 0 restores DefaultCacheTTL.
func (m *Manager) SetCacheTTL(ttl time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	if ttl == m.cacheTTLLocked() {
		return
	}
	m.cacheTTL = ttl
	for _, rec := range m.recs {
		exp := cacheExpiry(rec.s.LastResultAt, ttl)
		if exp.Equal(rec.s.CacheExpiresAt) {
			continue
		}
		rec.s.CacheExpiresAt = exp
		m.commitLocked(rec, false)
	}
}

// recordContext records a turn's context size and the model that answered it ("" keeps
// the previous one), as of now. tokens 0 clears the totals (/clear: a new conversation
// with nothing cached).
func (m *Manager) recordContext(id string, tokens int64, model string) {
	now := m.opts.Now()
	m.update(id, true, func(rec *record) {
		if tokens <= 0 {
			rec.s.ContextTokens, rec.s.ContextModel = 0, ""
			rec.s.LastResultAt, rec.s.CacheExpiresAt = time.Time{}, time.Time{}
			return
		}
		rec.s.ContextTokens = tokens
		if model != "" {
			rec.s.ContextModel = model
		}
		rec.s.LastResultAt = now
		rec.s.CacheExpiresAt = cacheExpiry(now, m.cacheTTLLocked())
	})
}
