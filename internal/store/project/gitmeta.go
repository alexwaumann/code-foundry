package project

import (
	"bytes"
	"cmp"
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
)

// Direct git metadata reader: parses <commonDir>/config and git ref files in Go to avoid
// spawning `git remote`, `git remote get-url origin`, `git symbolic-ref`, and
// `git rev-parse --verify` on every reconcile.
//
// Safety invariant: any ambiguity or unsupported git feature (config includes, URL
// rewrites via insteadOf/pushInsteadOf, global/system/env overrides, worktreeConfig,
// multi-URL or empty-URL origin, legacy remotes/branches dirs, reftable ref storage,
// symlinked refs, or parse errors) returns ok=false so the caller falls back cleanly to
// g.runner.Run.

type directGitMeta struct {
	runner ExecRunner
	// env mirrors ExecRunner.env: when non-nil, env vars are read from it instead of
	// os.LookupEnv so direct reads observe the exact environment ExecRunner passes to git.
	env []string

	// Lazily discovered config file origins from `git config --list --show-origin -z`
	// run once from a non-repo directory (catches Xcode, CommandLineTools, Nix, MacPorts
	// and other compiled-in system gitconfig paths).
	originsOnce   sync.Once
	originPaths   []string
	originsFailed bool
}

func (d *directGitMeta) lookupEnv(key string) (string, bool) {
	if d != nil && d.env != nil {
		prefix := key + "="
		for _, kv := range d.env {
			if strings.HasPrefix(kv, prefix) {
				return kv[len(prefix):], true
			}
		}
		return "", false
	}
	return os.LookupEnv(key)
}

type repoMetaResult struct {
	remotes       []string
	originURL     string
	remotesOK     bool
	defaultBranch string
	branchOK      bool
}

// readRepoMeta reads a repository's remotes, origin URL, and default branch directly from
// disk. remotesOK and branchOK report independently whether each part was resolved safely
// without falling back to git.
func (d *directGitMeta) readRepoMeta(dir, mainBranch string) repoMetaResult {
	gitDir, commonDir, ok := resolveGitDirs(dir)
	if !ok {
		return repoMetaResult{}
	}
	cfgData, err := os.ReadFile(filepath.Join(commonDir, "config"))
	if err != nil {
		return repoMetaResult{}
	}
	cfg, cfgOK := parseGitConfig(cfgData)
	if !cfgOK {
		return repoMetaResult{}
	}

	var res repoMetaResult
	if !d.hasExternalConfigOverrides() &&
		!cfg.hasInclude && !cfg.hasURLRewrite && !cfg.hasWorktreeCfg &&
		!pathExists(filepath.Join(commonDir, "remotes")) &&
		!pathExists(filepath.Join(commonDir, "branches")) {
		if remotes, originURL, ok := extractRemotesAndOrigin(cfg); ok {
			res.remotes = remotes
			res.originURL = originURL
			res.remotesOK = true
		}
	}

	if res.remotesOK {
		hasOrigin := slices.Contains(res.remotes, "origin")
		if b, ok := readDefaultBranchFromDirs(gitDir, commonDir, cfg.refStorage, mainBranch, hasOrigin); ok {
			res.defaultBranch = b
			res.branchOK = true
		}
	}
	return res
}

// readDefaultBranch resolves defaultBranch directly from disk for dir, returning ok=false
// when git must be consulted instead.
func (d *directGitMeta) readDefaultBranch(dir, mainBranch string, hasOrigin bool) (string, bool) {
	gitDir, commonDir, ok := resolveGitDirs(dir)
	if !ok {
		return "", false
	}
	cfgData, err := os.ReadFile(filepath.Join(commonDir, "config"))
	if err != nil {
		return "", false
	}
	cfg, cfgOK := parseGitConfig(cfgData)
	if !cfgOK || cfg.hasInclude || cfg.hasWorktreeCfg {
		return "", false
	}
	return readDefaultBranchFromDirs(gitDir, commonDir, cfg.refStorage, mainBranch, hasOrigin)
}

// resolveGitDirs maps a working tree dir (with a .git directory or a .git gitdir file)
// to its per-worktree gitDir and shared commonDir.
func resolveGitDirs(dir string) (gitDir, commonDir string, ok bool) {
	dotGit := filepath.Join(dir, ".git")
	fi, err := os.Lstat(dotGit)
	if err != nil {
		return "", "", false
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		fi, err = os.Stat(dotGit)
		if err != nil {
			return "", "", false
		}
	}
	if fi.IsDir() {
		return dotGit, dotGit, true
	}
	if !fi.Mode().IsRegular() {
		return "", "", false
	}
	gd, err := readGitFile(dir)
	if err != nil {
		return "", "", false
	}
	cb, err := os.ReadFile(filepath.Join(gd, "commondir"))
	if err == nil {
		rel := strings.TrimSpace(string(cb))
		if rel == "" {
			return "", "", false
		}
		if !filepath.IsAbs(rel) {
			rel = filepath.Join(gd, rel)
		}
		return gd, filepath.Clean(rel), true
	}
	if errors.Is(err, os.ErrNotExist) {
		return gd, gd, true
	}
	return "", "", false
}

// discoverConfigOrigins queries git once from a non-repo directory to learn the exact
// system/prefix config files compiled into this git binary (for example Apple Xcode's
// /Applications/Xcode.app/.../git-core/gitconfig or Nix/MacPorts prefixes).
func (d *directGitMeta) discoverConfigOrigins() ([]string, bool) {
	d.originsOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := d.runner.Run(ctx, os.TempDir(), "config", "--list", "--show-origin", "-z")
		if err != nil {
			// `git config --list` exits 0 even when empty; any error means bad config or
			// an unusable git binary, so fall back conservatively.
			d.originsFailed = true
			return
		}
		seen := map[string]struct{}{}
		parts := bytes.Split(out, []byte{0})
		for i := 0; i+1 < len(parts); i += 2 {
			origin := string(parts[i])
			p, ok := strings.CutPrefix(origin, "file:")
			if !ok || p == "" {
				continue
			}
			if _, dup := seen[p]; dup {
				continue
			}
			seen[p] = struct{}{}
			d.originPaths = append(d.originPaths, p)
		}
	})
	return d.originPaths, !d.originsFailed
}

// hasExternalConfigOverrides reports whether environment variables, system gitconfig, or
// global gitconfig might define remotes, includes, or URL rewrites (insteadOf /
// pushInsteadOf) that alter `git remote` or `git remote get-url origin`.
func (d *directGitMeta) hasExternalConfigOverrides() bool {
	if v, _ := d.lookupEnv("GIT_CONFIG_PARAMETERS"); v != "" {
		return true
	}
	if v, _ := d.lookupEnv("GIT_CONFIG_COUNT"); v != "" && v != "0" {
		return true
	}
	if v, _ := d.lookupEnv("GIT_CONFIG"); v != "" {
		return true
	}

	var paths []string
	seen := map[string]struct{}{}
	addPath := func(p string) {
		if p == "" {
			return
		}
		if _, dup := seen[p]; dup {
			return
		}
		seen[p] = struct{}{}
		paths = append(paths, p)
	}
	noSys, _ := d.lookupEnv("GIT_CONFIG_NOSYSTEM")
	if !isGitTruthy(noSys) {
		if sys, set := d.lookupEnv("GIT_CONFIG_SYSTEM"); set {
			addPath(sys)
		} else {
			discovered, ok := d.discoverConfigOrigins()
			if !ok {
				return true
			}
			for _, p := range discovered {
				addPath(p)
			}
			addPath("/etc/gitconfig")
			addPath("/opt/homebrew/etc/gitconfig")
			addPath("/usr/local/etc/gitconfig")
		}
	}
	if global, set := d.lookupEnv("GIT_CONFIG_GLOBAL"); set {
		addPath(global)
	} else {
		home, _ := d.lookupEnv("HOME")
		if xdg, _ := d.lookupEnv("XDG_CONFIG_HOME"); xdg != "" {
			addPath(filepath.Join(xdg, "git", "config"))
		} else if home != "" {
			addPath(filepath.Join(home, ".config", "git", "config"))
		}
		if home != "" {
			addPath(filepath.Join(home, ".gitconfig"))
		}
	}

	for _, p := range paths {
		b, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return true
		}
		cfg, ok := parseGitConfig(b)
		if !ok || cfg.hasInclude || cfg.hasURLRewrite || len(cfg.remotes) > 0 {
			return true
		}
	}
	return false
}

func isGitTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

type parsedGitConfig struct {
	remotes        map[string]*parsedRemote
	hasInclude     bool
	hasURLRewrite  bool
	hasWorktreeCfg bool
	refStorage     string
}

type parsedRemote struct {
	hasKey bool
	urls   []string
	badURL bool
}

// parseGitConfig parses a git INI config file. It returns ok=false on syntax errors or
// deprecated/ambiguous forms so callers fall back to git.
func parseGitConfig(data []byte) (parsedGitConfig, bool) {
	if bytes.IndexByte(data, 0) >= 0 {
		return parsedGitConfig{}, false
	}
	cfg := parsedGitConfig{remotes: map[string]*parsedRemote{}}
	i := 0
	if len(data) >= 3 && data[0] == 0xef && data[1] == 0xbb && data[2] == 0xbf {
		i = 3 // UTF-8 BOM
	}

	var (
		curSec    string
		curSub    string
		curHasSub bool
	)

	skipComment := func() {
		for i < len(data) && data[i] != '\n' {
			i++
		}
		if i < len(data) && data[i] == '\n' {
			i++
		}
	}

	for i < len(data) {
		for i < len(data) && (data[i] == ' ' || data[i] == '\t' || data[i] == '\r' || data[i] == '\n') {
			i++
		}
		if i >= len(data) {
			break
		}
		c := data[i]
		if c == '#' || c == ';' {
			skipComment()
			continue
		}
		if c == '[' {
			i++
			secStart := i
			for i < len(data) && isSectionNameByte(data[i]) {
				i++
			}
			if i == secStart {
				return parsedGitConfig{}, false
			}
			sec := strings.ToLower(string(data[secStart:i]))
			for i < len(data) && (data[i] == ' ' || data[i] == '\t') {
				i++
			}
			var sub string
			var hasSub bool
			if i < len(data) && data[i] == '"' {
				i++
				hasSub = true
				var sb strings.Builder
				closed := false
				for i < len(data) {
					ch := data[i]
					if ch == '\n' || ch == '\r' {
						return parsedGitConfig{}, false
					}
					if ch == '"' {
						i++
						closed = true
						break
					}
					if ch == '\\' {
						i++
						if i >= len(data) || data[i] == '\n' || data[i] == '\r' {
							return parsedGitConfig{}, false
						}
						sb.WriteByte(data[i])
						i++
						continue
					}
					sb.WriteByte(ch)
					i++
				}
				if !closed {
					return parsedGitConfig{}, false
				}
				sub = sb.String()
				for i < len(data) && (data[i] == ' ' || data[i] == '\t') {
					i++
				}
			}
			if i >= len(data) || data[i] != ']' {
				// Rejects malformed headers and deprecated [section.subsection] dot syntax.
				return parsedGitConfig{}, false
			}
			i++
			curSec, curSub, curHasSub = sec, sub, hasSub
			switch curSec {
			case "include", "includeif":
				cfg.hasInclude = true
			case "url":
				cfg.hasURLRewrite = true
			}
			continue
		}

		// Variable line: must be inside a section.
		if curSec == "" {
			return parsedGitConfig{}, false
		}
		if !isAlpha(c) {
			return parsedGitConfig{}, false
		}
		keyStart := i
		i++
		for i < len(data) && isKeyByte(data[i]) {
			i++
		}
		key := strings.ToLower(string(data[keyStart:i]))
		for i < len(data) && (data[i] == ' ' || data[i] == '\t') {
			i++
		}

		var val string
		var hasVal bool
		switch {
		case i >= len(data) || data[i] == '\n' || data[i] == '\r':
			if i < len(data) && data[i] == '\r' {
				i++
			}
			if i < len(data) && data[i] == '\n' {
				i++
			}
		case data[i] == '#' || data[i] == ';':
			// Git rejects `key ; comment` without '=' as a bad config line.
			return parsedGitConfig{}, false
		case data[i] == '=':
			i++
			hasVal = true
			v, ok := parseGitConfigValue(data, &i)
			if !ok {
				return parsedGitConfig{}, false
			}
			val = v
		default:
			return parsedGitConfig{}, false
		}

		if key == "insteadof" || key == "pushinsteadof" {
			cfg.hasURLRewrite = true
		}
		switch curSec {
		case "remote":
			if curHasSub {
				if curSub == "" {
					return parsedGitConfig{}, false
				}
				rem := cfg.remotes[curSub]
				if rem == nil {
					rem = &parsedRemote{}
					cfg.remotes[curSub] = rem
				}
				rem.hasKey = true
				if key == "url" {
					if !hasVal {
						rem.badURL = true
					} else {
						rem.urls = append(rem.urls, val)
					}
				}
			}
		case "extensions":
			if !curHasSub {
				switch key {
				case "worktreeconfig":
					cfg.hasWorktreeCfg = true
				case "refstorage":
					cfg.refStorage = val
				}
			}
		}
	}
	return cfg, true
}

// parseGitConfigValue parses the value after '=' up to the end of the logical line
// (supporting quotes, escape sequences, comments, and backslash-newline continuations).
func parseGitConfigValue(data []byte, idx *int) (string, bool) {
	i := *idx
	for i < len(data) && (data[i] == ' ' || data[i] == '\t') {
		i++
	}
	var buf []byte
	end := 0
	inQuote := false
	for i < len(data) {
		c := data[i]
		if c == '\n' {
			if inQuote {
				return "", false
			}
			i++
			break
		}
		if c == '\r' {
			if i+1 < len(data) && data[i+1] == '\n' {
				if inQuote {
					return "", false
				}
				i += 2
				break
			}
			buf = append(buf, c)
			if inQuote {
				end = len(buf)
			}
			i++
			continue
		}
		if c == '"' {
			inQuote = !inQuote
			i++
			end = len(buf)
			continue
		}
		if !inQuote && (c == '#' || c == ';') {
			for i < len(data) && data[i] != '\n' {
				i++
			}
			if i < len(data) && data[i] == '\n' {
				i++
			}
			break
		}
		if c == '\\' {
			i++
			if i >= len(data) {
				return "", false
			}
			switch data[i] {
			case '\n':
				i++
				continue
			case '\r':
				if i+1 < len(data) && data[i+1] == '\n' {
					i += 2
					continue
				}
				return "", false
			case '\\':
				buf = append(buf, '\\')
			case '"':
				buf = append(buf, '"')
			case 'n':
				buf = append(buf, '\n')
			case 't':
				buf = append(buf, '\t')
			case 'b':
				buf = append(buf, '\b')
			default:
				return "", false
			}
			end = len(buf)
			i++
			continue
		}
		buf = append(buf, c)
		if inQuote || (c != ' ' && c != '\t') {
			end = len(buf)
		}
		i++
	}
	if inQuote {
		return "", false
	}
	*idx = i
	return string(buf[:end]), true
}

func isAlpha(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func isSectionNameByte(b byte) bool {
	return isAlpha(b) || (b >= '0' && b <= '9') || b == '-'
}

func isKeyByte(b byte) bool {
	return isAlpha(b) || (b >= '0' && b <= '9') || b == '-'
}

func hasASCIIWhitespace(s string) bool {
	for i := range len(s) {
		switch s[i] {
		case ' ', '\t', '\n', '\r', '\v', '\f':
			return true
		}
	}
	return false
}

func extractRemotesAndOrigin(cfg parsedGitConfig) (remotes []string, originURL string, ok bool) {
	if len(cfg.remotes) > 0 {
		remotes = make([]string, 0, len(cfg.remotes))
		for name, r := range cfg.remotes {
			if !r.hasKey {
				continue
			}
			if name == "" || hasASCIIWhitespace(name) || strings.HasPrefix(name, "/") {
				return nil, "", false
			}
			remotes = append(remotes, name)
		}
		if len(remotes) == 0 {
			remotes = nil
		} else {
			slices.Sort(remotes)
		}
	}
	if orig, exists := cfg.remotes["origin"]; exists && orig.hasKey {
		// Fall back when origin has 0 URLs, multiple URLs, an empty URL, or a bare
		// boolean `url` key so behavior matches `git remote get-url origin` identically.
		if orig.badURL || len(orig.urls) != 1 || orig.urls[0] == "" {
			return nil, "", false
		}
		originURL = orig.urls[0]
	}
	return remotes, originURL, true
}

type looseRefKind uint8

const (
	refMissing looseRefKind = iota
	refSymref
	refOID
	refFallback
)

func readLooseRef(path string) (looseRefKind, string) {
	fi, err := os.Lstat(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return refMissing, ""
		}
		return refFallback, ""
	}
	if !fi.Mode().IsRegular() {
		// Symlinked symrefs or directories fall back to git.
		return refFallback, ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return refFallback, ""
	}
	s := strings.TrimSpace(string(b))
	if rest, ok := strings.CutPrefix(s, "ref:"); ok {
		target := strings.TrimSpace(rest)
		if target == "" {
			return refFallback, ""
		}
		return refSymref, target
	}
	if isHexOID(s) {
		return refOID, s
	}
	return refFallback, ""
}

func isHexOID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for i := range len(s) {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return false
		}
	}
	return true
}

type packedRefsCache struct {
	loaded bool
	ok     bool
	refs   map[string]bool
}

func (p *packedRefsCache) load(commonDir string) bool {
	if p.loaded {
		return p.ok
	}
	p.loaded = true
	b, err := os.ReadFile(filepath.Join(commonDir, "packed-refs"))
	if errors.Is(err, os.ErrNotExist) {
		p.ok = true
		return true
	}
	if err != nil {
		return false
	}
	refs := map[string]bool{}
	for line := range strings.Lines(string(b)) {
		line = strings.TrimRight(line, "\r\n")
		if line == "" || line[0] == '#' || line[0] == '^' {
			continue
		}
		oid, ref, ok := strings.Cut(line, " ")
		if !ok || !isHexOID(oid) || ref == "" {
			return false
		}
		refs[ref] = true
	}
	p.refs = refs
	p.ok = true
	return true
}

func refExistsDirect(commonDir, ref string, packed *packedRefsCache) (exists, ok bool) {
	kind, _ := readLooseRef(filepath.Join(commonDir, filepath.FromSlash(ref)))
	switch kind {
	case refOID:
		return true, true
	case refMissing:
		if !packed.load(commonDir) {
			return false, false
		}
		return packed.refs[ref], true
	default:
		// Loose symref or unreadable/corrupt file: fall back to git.
		return false, false
	}
}

func readDefaultBranchFromDirs(gitDir, commonDir, refStorage, mainBranch string, hasOrigin bool) (string, bool) {
	if refStorage != "" && !strings.EqualFold(refStorage, "files") {
		return "", false
	}
	if pathExists(filepath.Join(commonDir, "reftable")) ||
		(gitDir != commonDir && pathExists(filepath.Join(gitDir, "reftable"))) {
		return "", false
	}

	var packed packedRefsCache
	if hasOrigin {
		kind, target := readLooseRef(filepath.Join(commonDir, "refs", "remotes", "origin", "HEAD"))
		switch kind {
		case refSymref:
			if target == "refs/heads/.invalid" {
				return "", false
			}
			if b := parseOriginHead([]byte(target)); b != "" {
				return b, true
			}
		case refOID:
			// Detached origin/HEAD is not a symbolic ref; fall through to main/master check.
		case refMissing:
			if !packed.load(commonDir) || packed.refs["refs/remotes/origin/HEAD"] {
				return "", false
			}
		default:
			return "", false
		}
	} else {
		kind, target := readLooseRef(filepath.Join(gitDir, "HEAD"))
		switch kind {
		case refSymref:
			if target == "refs/heads/.invalid" {
				return "", false
			}
			if b, ok := strings.CutPrefix(target, "refs/heads/"); ok && b != "" {
				return b, true
			}
			return "", false
		case refOID:
			// Detached HEAD: fall through to main/master check.
		default:
			return "", false
		}
	}

	for _, b := range []string{"main", "master"} {
		for _, ref := range []string{"refs/heads/" + b, "refs/remotes/origin/" + b} {
			exists, ok := refExistsDirect(commonDir, ref, &packed)
			if !ok {
				return "", false
			}
			if exists {
				return b, true
			}
		}
	}
	return cmp.Or(mainBranch, "main"), true
}

func pathExists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}
