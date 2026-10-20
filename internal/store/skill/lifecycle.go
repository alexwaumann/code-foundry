package skill

import (
	"cmp"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/alexwaumann/code-foundry/internal/store/skill/marketplace"
)

// The lifecycle (docs/notes/skills-2-lifecycle.md): install, enable, disable, update,
// uninstall and remove. A marketplace plugin is Claude Code's (`claude plugin <op>`); a
// skill is a directory the store copies into Claude Code's skills dir, moves to and from
// the disabled dir, and records in skill_installs. Every operation re-reads (Load) and
// so publishes a new snapshot. Operations are serialized (opMu).

// Op names a lifecycle operation.
type Op string

// Ops.
const (
	OpInstall   Op = "install"
	OpEnable    Op = "enable"
	OpDisable   Op = "disable"
	OpUpdate    Op = "update"
	OpUninstall Op = "uninstall"
	OpRemove    Op = "remove"
)

// Change is what one operation did.
type Change struct {
	Op       Op               `json:"op"`
	Kind     marketplace.Kind `json:"kind"`
	Name     string           `json:"name"`
	Registry string           `json:"registry,omitempty"`
	// Message is Claude Code's message for a plugin operation.
	Message string `json:"message,omitempty"`
	// Version is the version afterwards (a skill's YYYYMMDD); PreviousVersion the one
	// an update replaced.
	Version         string `json:"version,omitempty"`
	PreviousVersion string `json:"previousVersion,omitempty"`
	// Unchanged: it already was in that state (installed, enabled, up to date).
	Unchanged bool `json:"unchanged,omitempty"`
	// Dir is where it is on disk afterwards ("" once uninstalled or removed).
	Dir string `json:"dir,omitempty"`
	// NeedsSetup: a skill whose setup script has not run (or changed since it did);
	// SetupScript is that script, relative to Dir.
	NeedsSetup  bool   `json:"needsSetup,omitempty"`
	SetupScript string `json:"setupScript,omitempty"`
	// Error is this one's failure when Update updates every offer.
	Error string `json:"error,omitempty"`
}

// CollisionError is a directory in the way of a skill: one Code Foundry did not install
// from that registry entry, or a leftover in the place a move goes to.
type CollisionError struct {
	Name, Dir string
	// Registry and Path are the entry the operation wanted ("" for a move).
	Registry, Path string
	// Recorded is where the record says the name came from ("" when no record has it).
	Recorded string
}

func (e *CollisionError) Error() string {
	switch {
	case e.Registry == "":
		return fmt.Sprintf("%s is in the way of skill %s: remove or rename it first", e.Dir, e.Name)
	case e.Recorded != "":
		return fmt.Sprintf("%s was installed from %s, not %s (%s): uninstall it first", e.Dir, e.Recorded, e.Registry, e.Path)
	}
	return fmt.Sprintf("%s already exists and Code Foundry did not install it: remove or rename it first", e.Dir)
}

// Is reports ErrCollision.
func (e *CollisionError) Is(target error) bool { return target == ErrCollision }

// SetupPlan is what running a skill's setup script takes: Argv in Dir. The caller starts
// it in a terminal and calls SetupExited with its exit code.
type SetupPlan struct {
	Name string `json:"name"`
	// Dir is the skill's directory, the working directory.
	Dir string `json:"dir"`
	// Script is relative to Dir.
	Script string   `json:"script"`
	Argv   []string `json:"argv"`
}

// Install installs the marketplace entry named name: a plugin with `claude plugin
// install <name>@<marketplace> -y`, a skill by copying its directory into the skills
// dir and recording it. kind "" takes either (a name both have is ErrAmbiguous); name may
// be <name>@<marketplace> for a plugin. Installing what is installed already is
// Unchanged. A skill whose name is a directory Code Foundry did not install from that
// entry, in either the skills or the disabled dir, is refused (*CollisionError).
func (s *Store) Install(ctx context.Context, name string, kind marketplace.Kind) (Change, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.ensureLoaded(ctx)
	e, err := s.entryRef(name, kind)
	if err != nil {
		return Change{}, err
	}
	if e.Kind == marketplace.KindPlugin {
		return s.installPlugin(ctx, e)
	}
	return s.installSkill(ctx, e)
}

// Enable enables an installed plugin (`claude plugin enable`) or moves a disabled skill
// back into the skills dir. Already enabled is Unchanged.
func (s *Store) Enable(ctx context.Context, name string, kind marketplace.Kind) (Change, error) {
	return s.toggle(ctx, name, kind, true)
}

// Disable disables an installed plugin (`claude plugin disable`) or moves a skill into
// the disabled dir. Already disabled is Unchanged.
func (s *Store) Disable(ctx context.Context, name string, kind marketplace.Kind) (Change, error) {
	return s.toggle(ctx, name, kind, false)
}

func (s *Store) toggle(ctx context.Context, name string, kind marketplace.Kind, enable bool) (Change, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.ensureLoaded(ctx)
	op := OpDisable
	if enable {
		op = OpEnable
	}
	t, err := s.resolve(ctx, name, kind)
	if err != nil {
		return Change{}, err
	}
	if t.kind == marketplace.KindPlugin {
		res, err := runPluginOp(ctx, s.opts.Claude, string(op), t.plugin.ID())
		if err != nil {
			return Change{}, fmt.Errorf("%s plugin %s: %w", op, t.plugin.ID(), err)
		}
		s.reload(ctx, op)
		return s.pluginChange(op, t.plugin, res, res.AlreadyInGoalState), nil
	}
	sk := t.skill
	if err := sk.managed(op); err != nil {
		return Change{}, err
	}
	from, to := sk.enabledDir, sk.disabledDir
	have, other := sk.enabled, sk.disabled
	if enable {
		from, to = to, from
		have, other = other, have
	}
	ch := Change{Op: op, Kind: marketplace.KindSkill, Name: sk.name, Registry: sk.rec.Registry}
	switch {
	case !have && !other:
		return Change{}, refuse(ErrNotFound, "skill %s is not in %s or %s any more; install it again", sk.name, s.opts.SkillsDir, s.opts.DisabledDir)
	case other && !have:
		ch.Unchanged = true
	case other && have:
		return Change{}, &CollisionError{Name: sk.name, Dir: to}
	default:
		if err := moveDir(from, to); err != nil {
			return Change{}, fmt.Errorf("%s skill %s: %w", op, sk.name, err)
		}
		s.log.Info("skill "+string(op)+"d", "skill", sk.name, "dir", to)
	}
	s.reload(ctx, op)
	return s.skillChange(ch, to), nil
}

// Update updates name, or with name "" every plugin and skill with an update offer
// (Installed.Update). A plugin runs `claude plugin update <id> -y` (Claude Code decides;
// already at the latest is Unchanged). A skill is copied again from its registry entry
// (found by path) when the registry's commit is newer than the recorded one, in place
// in the skills or the disabled dir; its setup stays done only when the setup script is
// the same file with the same sha256. With name "" one failure does not stop the others:
// it is that Change's Error.
func (s *Store) Update(ctx context.Context, name string, kind marketplace.Kind) ([]Change, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.ensureLoaded(ctx)
	if name != "" {
		t, err := s.resolve(ctx, name, kind)
		if err != nil {
			return nil, err
		}
		ch, err := s.updateOne(ctx, t)
		s.reload(ctx, OpUpdate)
		if err != nil {
			return nil, err
		}
		return []Change{s.refill(ch)}, nil
	}
	var out []Change
	for _, in := range s.Snapshot().Installed {
		if in.Update == nil || (kind != "" && in.Kind != kind) {
			continue
		}
		ref := in.Name
		if in.Kind == marketplace.KindPlugin {
			ref = in.ID()
		}
		t, err := s.resolve(ctx, ref, in.Kind)
		var ch Change
		if err == nil {
			ch, err = s.updateOne(ctx, t)
		}
		if err != nil {
			ch = Change{Op: OpUpdate, Kind: in.Kind, Name: in.Name, Registry: in.Registry, Version: in.Update.Version, PreviousVersion: in.Version, Error: err.Error()}
		}
		out = append(out, ch)
	}
	s.reload(ctx, OpUpdate)
	for i := range out {
		if out[i].Error == "" {
			out[i] = s.refill(out[i])
		}
	}
	return out, nil
}

// Updates are the installed plugins and skills (of kind, "" for both) with an update
// offer, as last read.
func (s *Store) Updates(kind marketplace.Kind) []Installed {
	var out []Installed
	for _, in := range s.Snapshot().Installed {
		if in.Update != nil && (kind == "" || in.Kind == kind) {
			out = append(out, in)
		}
	}
	return out
}

func (s *Store) updateOne(ctx context.Context, t target) (Change, error) {
	if t.kind == marketplace.KindPlugin {
		res, err := runPluginOp(ctx, s.opts.Claude, string(OpUpdate), t.plugin.ID(), "-y")
		if err != nil {
			return Change{}, fmt.Errorf("update plugin %s: %w", t.plugin.ID(), err)
		}
		ch := s.pluginChange(OpUpdate, t.plugin, res, res.UpdateOutcome == "up_to_date")
		ch.PreviousVersion = cmp.Or(res.OldVersion, t.plugin.Version)
		ch.Version = cmp.Or(res.NewVersion, ch.Version)
		return ch, nil
	}
	sk := t.skill
	if err := sk.managed(OpUpdate); err != nil {
		return Change{}, err
	}
	rec := sk.rec
	e, ok := catalogEntry(s.Snapshot().catalogs[rec.Registry], marketplace.KindSkill, func(e marketplace.Entry) bool { return e.Path == rec.Path })
	if !ok {
		return Change{}, refuse(ErrNotFound, "skill %s: %s has no skill at %s any more", sk.name, rec.Registry, rec.Path)
	}
	ch := Change{Op: OpUpdate, Kind: marketplace.KindSkill, Name: sk.name, Registry: rec.Registry, PreviousVersion: skillVersion(rec)}
	target := sk.dir()
	if target == "" {
		target = sk.enabledDir // gone from both: copy it again
	} else if !e.LastUpdated.After(rec.CommitAt) {
		ch.Unchanged, ch.Version = true, ch.PreviousVersion
		return ch, nil
	}
	if err := s.copySkill(ctx, e, sk.name, target, &rec); err != nil {
		return Change{}, err
	}
	ch.Version = skillVersion(rec)
	s.log.Info("skill updated", "skill", sk.name, "dir", target, "from", ch.PreviousVersion, "to", ch.Version)
	return ch, nil
}

// Uninstall uninstalls a plugin (`claude plugin uninstall <id> -y`, in its scope) or
// deletes a skill's directory (from either place) and its record. A local skill is
// ErrLocal: Remove deletes it.
func (s *Store) Uninstall(ctx context.Context, name string, kind marketplace.Kind) (Change, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.ensureLoaded(ctx)
	t, err := s.resolve(ctx, name, kind)
	if err != nil {
		return Change{}, err
	}
	if t.kind == marketplace.KindPlugin {
		extra := []string{"-y"}
		if t.plugin.Scope != "" {
			extra = append(extra, "--scope", t.plugin.Scope)
		}
		res, err := runPluginOp(ctx, s.opts.Claude, string(OpUninstall), t.plugin.ID(), extra...)
		if err != nil {
			return Change{}, fmt.Errorf("uninstall plugin %s: %w", t.plugin.ID(), err)
		}
		s.reload(ctx, OpUninstall)
		ch := s.pluginChange(OpUninstall, t.plugin, res, false)
		ch.Dir, ch.Version = "", t.plugin.Version
		return ch, nil
	}
	sk := t.skill
	if err := sk.managed(OpUninstall); err != nil {
		return Change{}, err
	}
	for _, d := range []string{sk.enabledDir, sk.disabledDir} {
		if err := os.RemoveAll(d); err != nil {
			return Change{}, fmt.Errorf("uninstall skill %s: %w", sk.name, err)
		}
	}
	if err := deleteRecord(ctx, s.opts.DB, sk.name); err != nil {
		return Change{}, err
	}
	delete(s.setupSHA, sk.name)
	s.log.Info("skill uninstalled", "skill", sk.name, "registry", sk.rec.Registry)
	s.reload(ctx, OpUninstall)
	return Change{Op: OpUninstall, Kind: marketplace.KindSkill, Name: sk.name, Registry: sk.rec.Registry, Version: skillVersion(sk.rec)}, nil
}

// Remove deletes a local skill's directory (one Code Foundry did not install; a symlink
// is removed, not what it points at). A recorded skill is ErrLocal: Uninstall it.
func (s *Store) Remove(ctx context.Context, name string) (Change, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	t, err := s.resolve(ctx, name, marketplace.KindSkill)
	if err != nil {
		return Change{}, err
	}
	sk := t.skill
	if sk.recorded {
		return Change{}, refuse(ErrLocal, "skill %s was installed from %s: uninstall it instead", sk.name, sk.rec.Registry)
	}
	dir := sk.dir()
	for _, d := range []string{sk.enabledDir, sk.disabledDir} {
		if err := os.RemoveAll(d); err != nil {
			return Change{}, fmt.Errorf("remove skill %s: %w", sk.name, err)
		}
	}
	s.log.Info("local skill removed", "skill", sk.name, "dir", dir)
	s.reload(ctx, OpRemove)
	return Change{Op: OpRemove, Kind: marketplace.KindSkill, Name: sk.name, Dir: ""}, nil
}

// installPlugin runs `claude plugin install <id> -y`.
func (s *Store) installPlugin(ctx context.Context, e marketplace.Entry) (Change, error) {
	id := PluginID(e.Name, e.Registry)
	prev, was := s.installedPlugin(id)
	res, err := runPluginOp(ctx, s.opts.Claude, string(OpInstall), id, "-y")
	if err != nil {
		return Change{}, fmt.Errorf("install plugin %s: %w", id, err)
	}
	s.reload(ctx, OpInstall)
	if !was {
		prev = Installed{Kind: marketplace.KindPlugin, Name: e.Name, Registry: e.Registry}
	}
	return s.pluginChange(OpInstall, prev, res, was), nil
}

// installSkill copies e into the skills dir and records it.
func (s *Store) installSkill(ctx context.Context, e marketplace.Entry) (Change, error) {
	name := e.Name
	if err := validSkillName(name); err != nil {
		return Change{}, err
	}
	sk, err := s.skillState(ctx, name)
	if err != nil {
		return Change{}, err
	}
	ours := sk.recorded && sk.rec.Registry == e.Registry && sk.rec.Path == e.Path
	ch := Change{Op: OpInstall, Kind: marketplace.KindSkill, Name: name, Registry: e.Registry}
	if sk.enabled || sk.disabled {
		if !ours {
			ce := &CollisionError{Name: name, Dir: sk.dir(), Registry: e.Registry, Path: e.Path}
			if sk.recorded {
				ce.Recorded = sk.rec.Registry + " (" + sk.rec.Path + ")"
			}
			return Change{}, ce
		}
		ch.Unchanged = true
		return s.skillChange(ch, sk.dir()), nil
	}
	rec := Record{Name: name, InstalledAt: s.opts.Now()}
	if err := s.copySkill(ctx, e, name, sk.enabledDir, &rec); err != nil {
		return Change{}, err
	}
	s.log.Info("skill installed", "skill", name, "registry", e.Registry, "path", e.Path, "dir", sk.enabledDir)
	s.reload(ctx, OpInstall)
	return s.skillChange(ch, sk.enabledDir), nil
}

// copySkill copies entry e's directory from its checkout to target and saves rec (which
// it fills from e). The setup stays done only when the script is the same file with the
// sha256 it had when it last ran.
func (s *Store) copySkill(ctx context.Context, e marketplace.Entry, name, target string, rec *Record) error {
	checkout := s.registryDir(e.Registry)
	if checkout == "" {
		return refuse(ErrNotFound, "skill %s: marketplace %s is not read", name, e.Registry)
	}
	src := filepath.Join(checkout, filepath.FromSlash(e.Path))
	if fi, err := os.Stat(filepath.Join(src, marketplace.SkillFile)); err != nil || !fi.Mode().IsRegular() {
		return refuse(ErrNotFound, "skill %s: %s has no %s", name, src, marketplace.SkillFile)
	}
	if err := installDir(src, target); err != nil {
		return fmt.Errorf("skill %s: %w", name, err)
	}
	script := e.SetupScriptInSkill()
	sum := ""
	if script != "" {
		sum = fileSHA256(filepath.Join(target, filepath.FromSlash(script)))
	}
	keepDone := !rec.SetupDoneAt.IsZero() && script != "" && script == rec.SetupScript && sum == rec.SetupSHA256
	rec.Registry, rec.Path, rec.Tier = e.Registry, e.Path, e.Tier
	rec.CommitSHA, rec.CommitAt = e.CommitSHA, e.LastUpdated
	rec.SetupScript, rec.SetupSHA256 = script, sum
	if !keepDone {
		rec.SetupDoneAt = time.Time{}
	}
	if rec.InstalledAt.IsZero() {
		rec.InstalledAt = s.opts.Now()
	}
	return saveRecord(ctx, s.opts.DB, *rec)
}

// ensureLoaded reads once when nothing has been read yet (an operation before the
// start-up read finished).
func (s *Store) ensureLoaded(ctx context.Context) {
	if s.Snapshot().Epoch == 0 {
		s.reload(ctx, "first read")
	}
}

// reload re-reads after op; a read's failures are logged, not the operation's.
func (s *Store) reload(ctx context.Context, op Op) {
	if err := s.Load(ctx); err != nil {
		s.log.Warn("re-read after "+string(op)+" had errors", "err", err)
	}
}

// entryRef is Entry, also taking <name>@<marketplace> for a plugin.
func (s *Store) entryRef(name string, kind marketplace.Kind) (marketplace.Entry, error) {
	if n, m, ok := cutPluginRef(name); ok && kind != marketplace.KindSkill {
		if e, ok := catalogEntry(s.Snapshot().catalogs[m], marketplace.KindPlugin, func(e marketplace.Entry) bool { return e.Name == n }); ok {
			return e, nil
		}
		return marketplace.Entry{}, refuse(ErrNotFound, "no plugin named %q in marketplace %q", n, m)
	}
	return s.Entry(name, kind)
}

// cutPluginRef splits name@marketplace.
func cutPluginRef(ref string) (name, market string, ok bool) {
	i := strings.LastIndex(ref, "@")
	if i <= 0 || i == len(ref)-1 {
		return "", "", false
	}
	return ref[:i], ref[i+1:], true
}

// target is what an operation on an installed name acts on: a plugin as last read, or a
// skill's state on disk.
type target struct {
	kind   marketplace.Kind
	plugin Installed
	skill  skillState
}

// skillState is a skill name's record and directories, read now.
type skillState struct {
	name                    string
	rec                     Record
	recorded                bool
	enabledDir, disabledDir string
	// enabled and disabled: something is at enabledDir / disabledDir.
	enabled, disabled bool
	// local: no record, and a SKILL.md in one of them.
	local bool
}

// dir is where the skill is: the skills dir, else the disabled dir, else "".
func (k skillState) dir() string {
	switch {
	case k.enabled:
		return k.enabledDir
	case k.disabled:
		return k.disabledDir
	}
	return ""
}

// managed refuses op on a local skill.
func (k skillState) managed(op Op) error {
	if k.recorded {
		return nil
	}
	return refuse(ErrLocal, "skill %s is local (Code Foundry did not install it), so it cannot be %s; remove deletes it", k.name, pastTense(op))
}

func pastTense(op Op) string {
	if op == OpUpdate {
		return "updated"
	}
	return strings.TrimSuffix(string(op), "e") + "ed"
}

// installed reports whether k is anything at all: recorded, or a local skill.
func (k skillState) installed() bool { return k.recorded || k.local }

func (s *Store) skillState(ctx context.Context, name string) (skillState, error) {
	recs, err := loadRecords(ctx, s.opts.DB)
	if err != nil {
		return skillState{}, err
	}
	k := skillState{name: name, enabledDir: filepath.Join(s.opts.SkillsDir, name), disabledDir: filepath.Join(s.opts.DisabledDir, name)}
	k.rec, k.recorded = recs[name]
	k.enabled, k.disabled = exists(k.enabledDir), exists(k.disabledDir)
	if !k.recorded {
		k.local = isSkillDir(k.enabledDir) || isSkillDir(k.disabledDir)
	}
	return k, nil
}

func isSkillDir(dir string) bool {
	fi, err := os.Stat(filepath.Join(dir, marketplace.SkillFile))
	return err == nil && fi.Mode().IsRegular()
}

// resolve finds the installed plugin or skill name refers to (kind "" for either):
// <name>@<marketplace> is a plugin; a bare name both an installed plugin and a skill have
// is an *AmbiguousError; a plugin name installed from two marketplaces must be given
// with its marketplace.
func (s *Store) resolve(ctx context.Context, name string, kind marketplace.Kind) (target, error) {
	if name == "" {
		return target{}, refuse(ErrNotFound, "no name given")
	}
	if _, _, ok := cutPluginRef(name); ok && kind != marketplace.KindSkill {
		if p, ok := s.installedPlugin(name); ok {
			return target{kind: marketplace.KindPlugin, plugin: p}, nil
		}
		return target{}, refuse(ErrNotFound, "plugin %s is not installed", name)
	}
	var plugins []Installed
	if kind != marketplace.KindSkill {
		for _, in := range s.Snapshot().Installed {
			if in.Kind == marketplace.KindPlugin && in.Name == name {
				plugins = append(plugins, in)
			}
		}
	}
	var sk skillState
	if kind != marketplace.KindPlugin && validSkillName(name) == nil {
		var err error
		if sk, err = s.skillState(ctx, name); err != nil {
			return target{}, err
		}
	}
	switch {
	case len(plugins) > 0 && sk.installed():
		return target{}, &AmbiguousError{Name: name, Choices: []marketplace.Entry{{Kind: marketplace.KindPlugin, Name: name}, {Kind: marketplace.KindSkill, Name: name}}}
	case len(plugins) > 1:
		ids := make([]string, len(plugins))
		for i, p := range plugins {
			ids[i] = p.ID()
		}
		return target{}, refuse(ErrAmbiguous, "plugin %s is installed from more than one marketplace; name one: %s", name, strings.Join(ids, " or "))
	case len(plugins) == 1:
		return target{kind: marketplace.KindPlugin, plugin: plugins[0]}, nil
	case sk.installed():
		return target{kind: marketplace.KindSkill, skill: sk}, nil
	}
	what := cmp.Or(string(kind), "plugin or skill")
	return target{}, refuse(ErrNotFound, "no installed %s named %q", what, name)
}

// installedPlugin is the installed plugin with id name@marketplace, as last read.
func (s *Store) installedPlugin(id string) (Installed, bool) {
	l := s.Snapshot().Installed
	i := slices.IndexFunc(l, func(in Installed) bool { return in.Kind == marketplace.KindPlugin && in.ID() == id })
	if i < 0 {
		return Installed{}, false
	}
	return l[i], true
}

// registryDir is marketplace name's checkout, as last read.
func (s *Store) registryDir(name string) string {
	for _, r := range s.Snapshot().Registries {
		if r.Name == name {
			return r.Dir
		}
	}
	return ""
}

// pluginChange is a plugin operation's Change, with the version and dir as read after it.
func (s *Store) pluginChange(op Op, p Installed, res pluginResult, unchanged bool) Change {
	ch := Change{Op: op, Kind: marketplace.KindPlugin, Name: p.Name, Registry: p.Registry, Message: res.Message, Unchanged: unchanged}
	if after, ok := s.installedPlugin(p.ID()); ok {
		ch.Version, ch.Dir = after.Version, after.Dir
	}
	return ch
}

// skillChange fills a skill Change from the snapshot read after it.
func (s *Store) skillChange(ch Change, dir string) Change {
	ch.Dir = dir
	return s.refill(ch)
}

// refill sets a Change's version, dir and setup state from the snapshot (after the
// operation's re-read).
func (s *Store) refill(ch Change) Change {
	for _, in := range s.Snapshot().Installed {
		if in.Kind != ch.Kind || in.Name != ch.Name || (ch.Kind == marketplace.KindPlugin && in.Registry != ch.Registry) {
			continue
		}
		ch.Version = cmp.Or(in.Version, ch.Version)
		ch.Dir = cmp.Or(in.Dir, ch.Dir)
		ch.NeedsSetup, ch.SetupScript = in.NeedsSetup, ""
		if in.NeedsSetup {
			ch.SetupScript = in.SetupScript
		}
		break
	}
	return ch
}

func skillVersion(r Record) string {
	if r.CommitAt.IsZero() {
		return ""
	}
	return r.CommitAt.UTC().Format("20060102")
}

// validSkillName refuses a name that is not one plain directory name in the skills dir.
func validSkillName(name string) error {
	switch {
	case name == "", name == ".", name == "..", strings.HasPrefix(name, "."), name == syncedDir,
		strings.ContainsAny(name, "/\\\x00"), filepath.Base(name) != name:
		return refuse(ErrInvalidName, "%q cannot be a skill directory name", name)
	}
	return nil
}

// Setup is how to run skill name's setup script: /bin/sh <script> in the skill's
// directory (enabled or disabled). It records nothing; the caller starts it (in a
// terminal the user sees: never silently) and reports the exit with SetupExited. A skill
// without a script, or a local one, is ErrNoSetup.
func (s *Store) Setup(ctx context.Context, name string) (SetupPlan, error) {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	t, err := s.resolve(ctx, name, marketplace.KindSkill)
	if err != nil {
		return SetupPlan{}, err
	}
	sk := t.skill
	if !sk.recorded || sk.rec.SetupScript == "" {
		return SetupPlan{}, refuse(ErrNoSetup, "skill %s has no setup script", sk.name)
	}
	dir := sk.dir()
	if dir == "" {
		return SetupPlan{}, refuse(ErrNotFound, "skill %s is not in %s or %s any more; install it again", sk.name, s.opts.SkillsDir, s.opts.DisabledDir)
	}
	script := filepath.Join(dir, filepath.FromSlash(sk.rec.SetupScript))
	if fi, err := os.Stat(script); err != nil || !fi.Mode().IsRegular() {
		return SetupPlan{}, refuse(ErrNoSetup, "skill %s: its setup script %s is missing", sk.name, script)
	}
	s.setupSHA[sk.name] = fileSHA256(script)
	return SetupPlan{Name: sk.name, Dir: dir, Script: sk.rec.SetupScript, Argv: []string{"/bin/sh", sk.rec.SetupScript}}, nil
}

// SetupExited records that skill name's setup script exited with code. Exit 0 sets
// setup_done_at and the script's sha256 (as Setup hashed it when it handed it out); any
// other code records nothing, so the skill still needs setup.
func (s *Store) SetupExited(ctx context.Context, name string, code int) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	sum, handed := s.setupSHA[name]
	delete(s.setupSHA, name)
	if code != 0 {
		s.log.Info("skill setup failed", "skill", name, "exit", code)
		return nil
	}
	recs, err := loadRecords(ctx, s.opts.DB)
	if err != nil {
		return err
	}
	rec, ok := recs[name]
	if !ok || rec.SetupScript == "" {
		s.log.Info("skill setup exited for a skill with no setup script on record", "skill", name)
		return nil
	}
	if !handed {
		k, err := s.skillState(ctx, name)
		if err != nil {
			return err
		}
		if d := k.dir(); d != "" {
			sum = fileSHA256(filepath.Join(d, filepath.FromSlash(rec.SetupScript)))
		}
	}
	rec.SetupDoneAt, rec.SetupSHA256 = s.opts.Now(), sum
	if err := saveRecord(ctx, s.opts.DB, rec); err != nil {
		return err
	}
	s.log.Info("skill setup done", "skill", name)
	s.reload(ctx, "setup")
	return nil
}
