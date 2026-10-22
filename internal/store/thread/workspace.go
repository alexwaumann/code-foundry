package thread

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/workspace"
)

// Workspace threads (docs/notes/workspaces-2-launch.md).
//
// A thread's owner is one field: Thread.WorkspaceID when set, else the project
// ProjectID. The cwd (ProjectID, WorktreePath) is a separate fact: the member worktree the
// thread runs in. The thread store reads workspaces from the workspace store (never
// the other way round: the workspace store learns about live threads from a function
// the daemon hands it).

// AdditionalDirsClaudeMDEnv makes claude load CLAUDE.md and .claude/rules from
// --add-dir directories too (without it, added directories give file access and
// skills/commands/agents only). Set for every workspace thread.
const AdditionalDirsClaudeMDEnv = "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1"

// workspacePrompt is the one line a workspace thread's system prompt gets. It must stay
// small and static: claude records the system prompt on the first request and reuses
// it until compaction, so the member list itself is looked up with the CLI instead.
func workspacePrompt(name string) string {
	return "This thread belongs to workspace " + name + ". Run `code-foundry workspace members` for the current worktrees."
}

// ThreadPrompt is the paragraph every thread's system prompt gets. It points at the
// skills the daemon ships to every thread (Options.SkillsDir, internal/skills), the
// entry skill first, which says what the app can do and routes to the others: driving
// other threads, answering questions about the app, building plugins
// (docs/notes/agent-skills.md, control-4-capabilities.md). Then the routing a thread
// needs when no skill fires, as on ordinary task-shaped prompts: where preferences,
// cost, showing things, pull requests and slash commands go in this app
// (docs/notes/control-7-skill-routing.md), and where thread new puts a thread, stated
// without a recommendation: the model's call (docs/notes/thread-new-base-origin.md). Its last sentence holds the orchestration
// rule (docs/notes/orch-skill-v2.md). Static for the same reason as workspacePrompt: it
// never varies per spawn. Every request of every thread carries it: keep it short.
const ThreadPrompt = "This thread runs inside code-foundry. Its skill code-foundry says what the app can do and which of its other skills to read (code-foundry-help to answer questions about the app, code-foundry-orchestrate to delegate work to other threads, code-foundry-plugin to build plugins). " +
	"In this app: how you should act in every project (always, never, keep answers short) goes to code-foundry memory add <their words> at once, without asking; what you learn about the user, a project or its code goes in your memory files; asked what you remember, give both; " +
	"cost: code-foundry usage.show; " +
	"to show something: code-foundry view.panel.file, diff, pr, usage or worktree (your own thread's panel; --focus only if asked); " +
	"a path in your reply is a clickable chip; a page, chart or form to fill in is an .html file shown with view.inline <file>, not markdown; " +
	"PRs: code-foundry pr.create (project.github.publish if not on GitHub); " +
	"thread new: the project checkout or --new-worktree (--base, --base-from-origin yes|no), your call; " +
	"never tell the user to type /model or /cost; " +
	"page verbs (view.*) move every window: prefer panel verbs; " +
	"say what you will do, not command or skill names. " +
	"Work the user wants split up, run in parallel or landed on several branches goes through code-foundry-orchestrate (child threads in new worktrees), never the Agent tool, hand-made worktrees or hand-made cf/ branches; the Agent tool is for read-only research."

// systemPrompt is --append-system-prompt: ThreadPrompt, then the workspace's line
// (workspacePrompt) for a workspace thread, then the app memory's entries (memoryPrompt)
// when there are any, then the thread's own append.
func systemPrompt(workspaceLine string, memory []string, threadAppend string) string {
	p := ThreadPrompt
	if workspaceLine != "" {
		p += " " + workspaceLine
	}
	if mp := memoryPrompt(memory); mp != "" {
		p += "\n\n" + mp
	}
	if threadAppend != "" {
		// The thread's own (Thread.SystemPromptAppend: a reseed's or a resident's).
		p += "\n\n" + threadAppend
	}
	return p
}

// wsLaunch is what a workspace thread's spawn adds to claude's.
type wsLaunch struct {
	addDirs []string // the other members' worktrees, in member order
	missing []string // other members' worktrees that do not exist (claude refuses them)
	env     []string
	prompt  string
	// projects are every member's project, the cwd's included, in member order.
	projects []string
}

// workspaceLaunch reads workspace id's current members from snap for a thread running
// in cwd: --add-dir for every other member whose worktree exists, the CLAUDE.md env,
// and the prompt line. ok is false when the workspace is gone.
func workspaceLaunch(snap *workspace.Snapshot, id, cwd string, exists func(string) bool) (l wsLaunch, ok bool) {
	w, ok := snap.Workspace(id)
	if !ok {
		return l, false
	}
	for _, mem := range w.Members {
		l.projects = append(l.projects, mem.ProjectID)
		switch {
		case samePath(mem.WorktreePath, cwd):
		case exists(mem.WorktreePath):
			l.addDirs = append(l.addDirs, mem.WorktreePath)
		default:
			l.missing = append(l.missing, mem.WorktreePath)
		}
	}
	l.env = []string{AdditionalDirsClaudeMDEnv}
	l.prompt = workspacePrompt(w.Name)
	return l, true
}

// isDir reports whether path is an existing directory.
func isDir(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.IsDir()
}

// WorkspaceSource is the part of the workspace store threads need: the current
// members at every spawn, and making a workspace for a new workspace thread.
// *workspace.Manager implements it.
type WorkspaceSource interface {
	Snapshot() *workspace.Snapshot
	Create(ctx context.Context, opts workspace.CreateOptions) (workspace.Workspace, error)
}

// NewWorkspace configures the workspace Create makes for a new workspace thread.
type NewWorkspace struct {
	// Projects are project refs (id, name when unique, or an absolute path inside
	// one), in member order, each optionally followed by ":<base ref>" for that member
	// (as `workspace new --projects`). CreateOptions.ProjectID picks the member the thread
	// runs in (default: the first).
	Projects []string
	// BaseRef every member without its own base branches from. Empty: each
	// repository's default.
	BaseRef string
	// Name of the workspace. Empty: the branch's last component (feat/add-filter ->
	// add-filter).
	Name string
	// Branch steers the one branch of every member, as NewWorktree.Branch.
	Branch string
	// BaseFromOrigin overrides projects.base_from_origin for every member, as
	// NewWorktree.BaseFromOrigin.
	BaseFromOrigin *bool
}

// createdWorkspace is what newWorkspace made.
type createdWorkspace struct {
	workspaceID, projectID, path, baseRef, branch string
	// members of the new workspace, in member order.
	members []workspace.Member
	// name, namerCalled, late: as createdWorktree.
	name        string
	namerCalled bool
	late        <-chan namingResult
}

// workspaceMember resolves the member a thread of workspace ref (id or name) runs in;
// see pickMember. projectID may also be a project name.
func (m *Manager) workspaceMember(ref, projectID, path string) (workspace.Workspace, workspace.Member, error) {
	if m.opts.Workspaces == nil {
		return workspace.Workspace{}, workspace.Member{}, fmt.Errorf("%w: workspace threads need the workspace store", ErrFailedPrecondition)
	}
	if path != "" && !filepath.IsAbs(path) {
		return workspace.Workspace{}, workspace.Member{}, fmt.Errorf("%w: worktree path %q must be absolute", ErrInvalidArgument, path)
	}
	w, err := workspace.ResolveWorkspace(m.opts.Workspaces.Snapshot(), workspace.Ref{Workspace: ref})
	if err != nil {
		return workspace.Workspace{}, workspace.Member{}, workspaceError("workspace", err)
	}
	if _, ok := w.Member(projectID); projectID != "" && !ok && m.opts.Projects != nil {
		// A repository name (or path) instead of the id.
		if r, err := workspace.ResolveProject(m.opts.Projects.Snapshot(), projectID); err == nil {
			projectID = r.ID
		}
	}
	mem, err := pickMember(w, projectID, path)
	return w, mem, err
}

// pickMember chooses the member of w a thread runs in: the one whose worktree is path,
// else the one for projectID, else the first. When both are given they must name the same
// member. A path inside a member worktree but not the worktree itself is not a member.
func pickMember(w workspace.Workspace, projectID, path string) (workspace.Member, error) {
	if len(w.Members) == 0 {
		return workspace.Member{}, fmt.Errorf("%w: workspace %s has no members", ErrFailedPrecondition, w.Name)
	}
	if path != "" {
		i := slices.IndexFunc(w.Members, func(mem workspace.Member) bool { return samePath(mem.WorktreePath, path) })
		if i < 0 {
			return workspace.Member{}, fmt.Errorf("%w: %s is not a member worktree of workspace %s (members: %s)",
				ErrFailedPrecondition, path, w.Name, memberPaths(w))
		}
		if projectID != "" && w.Members[i].ProjectID != projectID {
			return workspace.Member{}, fmt.Errorf("%w: worktree %s belongs to project %s, not %s", ErrInvalidArgument, path, w.Members[i].ProjectID, projectID)
		}
		return w.Members[i], nil
	}
	if projectID != "" {
		mem, ok := w.Member(projectID)
		if !ok {
			return workspace.Member{}, fmt.Errorf("%w: project %s is not a member of workspace %s (members: %s)",
				ErrFailedPrecondition, projectID, w.Name, memberPaths(w))
		}
		return mem, nil
	}
	return w.Members[0], nil
}

// samePath compares two absolute paths cleaned and with symlinks resolved.
func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b) || realPath(a) == realPath(b)
}

func memberPaths(w workspace.Workspace) string {
	out := make([]string, len(w.Members))
	for i, mem := range w.Members {
		out[i] = mem.ProjectID + " " + mem.WorktreePath
	}
	return strings.Join(out, ", ")
}

// newWorkspace makes the workspace of a new workspace thread: after the single naming
// wait (as for a new worktree), a worktree on the one branch in every repository
// through the workspace store, which creates all or none.
func (m *Manager) newWorkspace(ctx context.Context, id, name string, o CreateOptions) (createdWorkspace, error) {
	var cw createdWorkspace
	nw := o.NewWorkspace
	switch {
	case m.opts.Workspaces == nil:
		return cw, fmt.Errorf("%w: creating a workspace needs the workspace store", ErrFailedPrecondition)
	case m.opts.Projects == nil:
		return cw, fmt.Errorf("%w: creating a workspace needs the project store", ErrFailedPrecondition)
	case len(nw.Projects) == 0:
		return cw, fmt.Errorf("%w: a new workspace needs at least one project", ErrInvalidArgument)
	}
	base := strings.TrimSpace(nw.BaseRef)
	if err := validateRef(base); err != nil {
		return cw, err
	}
	bc, err := m.newBranchChoice(nw.Branch)
	if err != nil {
		return cw, err
	}
	// Resolve every repository before waiting for a name, so a typo fails fast.
	snap := m.opts.Projects.Snapshot()
	var ids, paths, bases []string
	for _, item := range nw.Projects {
		ref, own, _ := strings.Cut(item, ":")
		ref, own = strings.TrimSpace(ref), strings.TrimSpace(own)
		if err := validateRef(own); err != nil {
			return cw, err
		}
		r, err := workspace.ResolveProject(snap, ref)
		if err != nil {
			return cw, workspaceError("project", err)
		}
		if err := workspace.RequireGit(r); err != nil {
			return cw, workspaceError("project", err)
		}
		if slices.Contains(ids, r.ID) {
			return cw, fmt.Errorf("%w: project %s is listed twice", ErrInvalidArgument, r.Name)
		}
		ids, paths, bases = append(ids, r.ID), append(paths, r.Path), append(bases, own)
	}
	cwdProject := ids[0]
	if o.ProjectID != "" {
		// An id, or a name or path like the repository refs.
		cwdProject = o.ProjectID
		if r, err := workspace.ResolveProject(snap, o.ProjectID); err == nil {
			cwdProject = r.ID
		}
	}
	if !slices.Contains(ids, cwdProject) {
		return cw, fmt.Errorf("%w: project %s is not among the new workspace's projects", ErrInvalidArgument, cwdProject)
	}
	wsName := strings.TrimSpace(nw.Name)

	sl, err := m.waitNaming(ctx, id, name, o.InitialPrompt, bc)
	if err != nil {
		return cw, err
	}
	cw.name, cw.namerCalled, cw.late = sl.name, sl.namerCalled, sl.late
	var nameTaken func(string) bool
	if wsName == "" {
		// The workspace is named after its branch, so a suffix that frees the branch
		// must also free the name.
		existing := m.opts.Workspaces.Snapshot()
		nameTaken = func(n string) bool {
			_, err := workspace.ResolveWorkspace(existing, workspace.Ref{Workspace: n})
			return err == nil
		}
	}
	branch, existing := m.pickBranch(ctx, paths, bc, sl.branch, id, nameTaken)
	if existing {
		// The workspace store checks it out in each member that has it.
		m.log.Info("branch exists; checking it out where it exists", "thread", id, "branch", branch)
	}
	if wsName == "" {
		wsName = slugPart(branch)
	}
	specs := make([]workspace.MemberSpec, len(ids))
	cwdBase := base
	for i, rid := range ids {
		specs[i] = workspace.MemberSpec{Project: rid, BaseRef: bases[i]}
		if rid == cwdProject && bases[i] != "" {
			cwdBase = bases[i]
		}
	}
	w, err := m.opts.Workspaces.Create(ctx, workspace.CreateOptions{
		Name: wsName, Branch: branch, Members: specs, BaseRef: base, Fetch: true, BaseFromOrigin: nw.BaseFromOrigin,
	})
	if err != nil {
		return cw, workspaceError("create workspace "+wsName, err)
	}
	mem, ok := w.Member(cwdProject)
	if !ok { // the store made every member or failed; this is a broken fake
		return cw, fmt.Errorf("%w: workspace %s has no member for project %s", ErrFailedPrecondition, w.ID, cwdProject)
	}
	cw.workspaceID, cw.projectID, cw.path, cw.members, cw.branch = w.ID, mem.ProjectID, mem.WorktreePath, w.Members, branch
	cw.baseRef = cmp.Or(mem.StartPoint, cwdBase)
	if cw.baseRef == "" {
		if r, ok := m.opts.Projects.Snapshot().Project(cwdProject); ok {
			cw.baseRef = r.DefaultBranch
			if wt, ok := m.opts.Projects.Snapshot().Worktree(cwdProject, mem.WorktreePath); ok {
				cw.baseRef = cmp.Or(wt.Status.BaseRef, cw.baseRef)
			}
		}
	}
	m.log.Info("workspace created for thread", "thread", id, "workspace", w.ID, "name", w.Name,
		"branch", branch, "members", len(w.Members), "cwd", mem.WorktreePath)
	return cw, nil
}

// workspaceError wraps a workspace store error in the thread error class with the
// same meaning, so API codes survive.
func workspaceError(what string, err error) error {
	var kind error
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return fmt.Errorf("%s: %w", what, err)
	case errors.Is(err, workspace.ErrNotFound):
		kind = ErrNotFound
	case errors.Is(err, workspace.ErrInvalidArgument):
		kind = ErrInvalidArgument
	default:
		kind = ErrFailedPrecondition
	}
	return classified{kind: kind, err: fmt.Errorf("%s: %w", what, err)}
}
