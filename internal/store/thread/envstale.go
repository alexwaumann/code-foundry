package thread

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"slices"
	"strings"
)

// Staleness of a running thread's spawn extras (docs/notes/plugins-env-restart.md). A
// process keeps the environment it was started with, so when a plugin pushes a new
// session environment (or is enabled, disabled or removed) the running threads it
// applies to are stale: Thread.PluginEnvStale with a short summary, until a restart
// (Store.Restart, the effort restart) or the next spawn gives them the new one. Each
// spawn records a fingerprint of what it got, by source: variable names with hashed
// values, the PATH entries and the add-dirs, never a value in the clear. The daemon
// calls CheckSpawnExtras whenever a contribution may have changed; it asks the extras
// again for every running thread (SpawnInfo.Probe) and compares, so a change that is
// undone, or the same values pushed again, is no change.

// maxEnvChange bounds PluginEnvChange.
const maxEnvChange = 200

// extrasPrint is the fingerprint of one spawn's extras, by source id.
type extrasPrint map[string]sourcePrint

// sourcePrint is one source's part: its name for the summary, each variable's hashed
// value by name, and hashes of its PATH entries and add-dirs.
type sourcePrint struct {
	name       string
	env        map[string]string
	path, dirs string
}

// shortHash is a value's fingerprint (never the value).
func shortHash(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:8])
}

// listHash fingerprints a list in order; "" for an empty one.
func listHash(l []string) string {
	if len(l) == 0 {
		return ""
	}
	return shortHash(strings.Join(l, "\x00"))
}

// printOf fingerprints x. Without Sources its entries count as one unnamed source.
func printOf(x SpawnExtras) extrasPrint {
	sources := x.Sources
	if len(sources) == 0 && (len(x.Env) > 0 || len(x.PathPrepend) > 0 || len(x.AddDirs) > 0) {
		sources = []ExtrasSource{{Env: x.Env, PathPrepend: x.PathPrepend, AddDirs: x.AddDirs}}
	}
	p := extrasPrint{}
	for _, src := range sources {
		sp := sourcePrint{name: src.Name, env: map[string]string{}, path: listHash(src.PathPrepend), dirs: listHash(src.AddDirs)}
		for _, kv := range src.Env {
			k, v, _ := strings.Cut(kv, "=")
			sp.env[k] = shortHash(v)
		}
		if len(sp.env) == 0 && sp.path == "" && sp.dirs == "" {
			continue
		}
		p[src.ID] = sp
	}
	return p
}

// changeSummary says how now differs from was, one clause per source in id order
// ("Hello removed CF_HELLO; GitHub Actions added 2 variables"); "" when nothing did.
func changeSummary(was, now extrasPrint) string {
	ids := slices.Sorted(maps.Keys(was))
	for id := range now {
		if _, ok := was[id]; !ok {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	var clauses []string
	for _, id := range ids {
		a, b := was[id], now[id]
		var added, changed, removed []string
		for k, h := range b.env {
			if old, ok := a.env[k]; !ok {
				added = append(added, k)
			} else if old != h {
				changed = append(changed, k)
			}
		}
		for k := range a.env {
			if _, ok := b.env[k]; !ok {
				removed = append(removed, k)
			}
		}
		var parts []string
		for _, p := range []struct {
			verb string
			keys []string
		}{{"added", added}, {"changed", changed}, {"removed", removed}} {
			if len(p.keys) > 0 {
				parts = append(parts, p.verb+" "+variables(p.keys))
			}
		}
		if a.path != b.path {
			parts = append(parts, "changed its PATH entries")
		}
		if a.dirs != b.dirs {
			parts = append(parts, "changed its folders")
		}
		if len(parts) == 0 {
			continue
		}
		clauses = append(clauses, sourceName(id, a.name, b.name)+" "+strings.Join(parts, ", "))
	}
	out := strings.Join(clauses, "; ")
	if len(out) > maxEnvChange {
		out = strings.TrimRight(out[:maxEnvChange-1], " ,;") + "…"
	}
	return out
}

// variables names one variable, or counts several ("2 variables").
func variables(keys []string) string {
	if len(keys) == 1 {
		return keys[0]
	}
	return fmt.Sprintf("%d variables", len(keys))
}

// sourceName is the newest name a source had, else its id, else "A plugin".
func sourceName(id, was, now string) string {
	for _, n := range []string{now, was, id} {
		if n != "" {
			return n
		}
	}
	return "A plugin"
}

// staleCheck is one running thread to compare (CheckSpawnExtras).
type staleCheck struct {
	id    string
	s     Thread
	print *extrasPrint
}

// CheckSpawnExtras compares every running thread's spawn extras with what a spawn
// would get now and sets or clears Thread.PluginEnvStale and PluginEnvChange. Cheap
// (the extras are a lookup) and idempotent: the daemon calls it on every plugin change.
func (m *Manager) CheckSpawnExtras(ctx context.Context) {
	if m.spawnExtras.Load() == nil {
		return
	}
	m.mu.Lock()
	var checks []staleCheck
	for id, rec := range m.recs {
		if rec.run != nil && rec.envPrint != nil {
			checks = append(checks, staleCheck{id: id, s: rec.s, print: rec.envPrint})
		}
	}
	m.mu.Unlock()
	for _, c := range checks {
		in := spawnInfoOf(c.s, m.memberProjects(c.s), false)
		in.Probe = true
		change := changeSummary(*c.print, printOf(m.extras(ctx, in)))
		m.mu.Lock()
		rec, ok := m.recs[c.id]
		if ok && rec.envPrint == c.print && (rec.s.PluginEnvStale != (change != "") || rec.s.PluginEnvChange != change) {
			rec.s.PluginEnvStale, rec.s.PluginEnvChange = change != "", change
			m.commitLocked(rec, false)
			if change != "" {
				m.log.Info("thread's plugin environment changed since its process started", "thread", c.id, "change", change)
			}
		}
		m.mu.Unlock()
	}
}

// spawnedWith records what a process of rec just got (spawn, respawn) and clears the
// staleness. m.mu held.
func (rec *record) spawnedWith(x SpawnExtras) {
	p := printOf(x)
	rec.envPrint = &p
	rec.s.PluginEnvStale, rec.s.PluginEnvChange = false, ""
}
