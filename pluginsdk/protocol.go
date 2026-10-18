package pluginsdk

import (
	"bytes"
	"encoding/json"
	"time"
)

// Host → plugin methods.
const (
	// MethodInitialize (request, 5 s): InitializeParams → InitializeResult.
	MethodInitialize = "initialize"
	// MethodInitialized (notification): the plugin is running; Plugin.Init runs now.
	MethodInitialized = "initialized"
	// MethodCommandInvoke (request, the command's timeout): CommandRequest → CommandResult.
	MethodCommandInvoke = "command/invoke"
	// MethodPing (request, every 30 s, 5 s): {} → {}. Two misses and the host restarts it.
	MethodPing = "ping"
	// MethodShutdown (request, 2 s): {} → {}. The plugin then exits; the host closes
	// stdin and signals the process group if it does not.
	MethodShutdown = "shutdown"
	// MethodSurfaceOpen (request, 5 s): SurfaceOpen → {}. The first viewer of an
	// instance opens it; the plugin then sends its view with view/update (within 10 s,
	// or the host shows "not responding"). A view/update sent before the answer counts.
	MethodSurfaceOpen = "surface/open"
	// MethodSurfaceVisibility (notification): SurfaceVisibility, when the instance's
	// viewers go from none to some (true, also right after open) and back (false). A
	// hidden instance may stop polling.
	MethodSurfaceVisibility = "surface/visibility"
	// MethodSurfaceClose (notification): SurfaceClose, after the instance had no viewer
	// for the host's grace (10 minutes), at once when its thread or project went away or
	// its when clause stopped holding (SurfaceClose.Reason says which).
	MethodSurfaceClose = "surface/close"
	// MethodSurfaceAct (request, 10 s): SurfaceAct → {}. An error's message is shown to
	// the user.
	MethodSurfaceAct = "surface/act"
	// MethodEventsEvent (notification): Event, one subscribed event (Plugin.OnEvent).
	MethodEventsEvent = "events/event"
)

// Plugin → host methods.
const (
	// MethodHostInvoke (request): InvokeParams → CommandResult. Needs the command in
	// Permissions.Commands.
	MethodHostInvoke = "host/invoke"
	// MethodLog (notification): LogParams, into the plugin's log.
	MethodLog = "log"
	// MethodSecretGet, MethodSecretSet, MethodSecretDelete, MethodSecretList (requests)
	// reach the plugin's own Keychain namespace. Need Permissions.Secrets.
	MethodSecretGet    = "secret/get"
	MethodSecretSet    = "secret/set"
	MethodSecretDelete = "secret/delete"
	MethodSecretList   = "secret/list"
	// A method a host does not support (yet) answers CodeMethodNotFound; the host's
	// initialize capabilities say what it supports.
	//
	// MethodViewUpdate (request): ViewUpdateParams → ViewUpdateResult. The whole view
	// of an open instance; the host validates it (an invalid view is refused with
	// CodeInvalidParams naming each problem, and the previous view stays), numbers it,
	// and coalesces bursts. Sent as a notification it works too, but a refusal then
	// only reaches the plugin's log.
	MethodViewUpdate = "view/update"
	// MethodViewAppend (request or notification): ViewAppendParams → ViewUpdateResult.
	// Extends one log node of the instance's current view without re-sending it.
	MethodViewAppend = "view/append"
	// MethodViewToast (notification): ToastParams, at most one a second.
	MethodViewToast = "view/toast"
	// MethodContextSet (notification): ContextParams, a predicate fact
	// <plugin>.<key> (global, or for one thread or project) the host's when clauses
	// read. A null value removes it. Facts last until the plugin process ends.
	MethodContextSet = "context/set"
	// MethodThreadSetFlag (request): Flag → FlagResult (Host.SetFlag).
	MethodThreadSetFlag = "thread/setFlag"
	// MethodEventsSubscribe (request): SubscribeParams → SubscribeResult; the events
	// arrive as events/event. MethodEventsUnsubscribe ends one.
	MethodEventsSubscribe   = "events/subscribe"
	MethodEventsUnsubscribe = "events/unsubscribe"
	// MethodSetEnvironment (request): Environment → EnvironmentResult
	// (Host.SetEnvironment).
	MethodSetEnvironment = "session/setEnvironment"
	// Plugin threads (permission threads; capability "threads"): Claude threads the
	// plugin owns, hidden from the user's thread list.
	//
	// MethodThreadCreate (request): ThreadCreateParams → ThreadCreateResult.
	MethodThreadCreate = "thread/create"
	// MethodThreadSend (request): ThreadSendParams → {}. Starts the thread's Claude when
	// it is stopped, like any message.
	MethodThreadSend = "thread/send"
	// MethodThreadArchive (request): ThreadRef → {}.
	MethodThreadArchive = "thread/archive"
	// MethodThreadList (request): {} → ThreadListResult, the plugin's own threads.
	MethodThreadList = "thread/list"
	// Plugin terminals (permission terminals; capability "terminals").
	//
	// MethodTerminalCreate (request): TerminalCreateParams → TerminalCreateResult.
	MethodTerminalCreate = "terminal/create"
	// MethodTerminalClose (request): TerminalRef → {}. Kills it (SIGHUP, then SIGKILL)
	// and forgets it.
	MethodTerminalClose = "terminal/close"
	// MethodTerminalList (request): {} → TerminalListResult, the plugin's own terminals.
	MethodTerminalList = "terminal/list"
)

// Environment variables the host sets in a plugin's process.
const (
	// EnvPlugin is the plugin's name.
	EnvPlugin = "CODE_FOUNDRY_PLUGIN"
	// EnvPluginDir is the package directory (also the process's working directory).
	EnvPluginDir = "CODE_FOUNDRY_PLUGIN_DIR"
	// EnvPluginData is the plugin's own state directory (0700), kept across updates.
	EnvPluginData = "CODE_FOUNDRY_PLUGIN_DATA"
)

// UiContext is what the user was looking at when a command ran or a surface opened. A
// command invoked from the CLI carries its --context-* flags.
type UiContext struct {
	ThreadID     string `json:"threadId,omitempty"`
	ProjectID    string `json:"projectId,omitempty"`
	WorktreePath string `json:"worktreePath,omitempty"`
	TerminalID   string `json:"terminalId,omitempty"`
	WorkspaceID  string `json:"workspaceId,omitempty"`
	View         string `json:"view,omitempty"`
}

// HostInfo is the host half of InitializeParams.
type HostInfo struct {
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities,omitempty"`
}

// PluginInfo is what the host tells the plugin about itself.
type PluginInfo struct {
	Name    string      `json:"name"`
	Dir     string      `json:"dir"`
	DataDir string      `json:"dataDir"`
	Granted Permissions `json:"granted"`
	Dev     bool        `json:"dev,omitempty"`
}

// InitializeParams opens the session.
type InitializeParams struct {
	Protocol int        `json:"protocol"`
	Host     HostInfo   `json:"host"`
	Plugin   PluginInfo `json:"plugin"`
	// Flags are the plugin's live flags on threads (kept across its restarts and the
	// daemon's), so it can reconcile them: clear what no longer holds.
	Flags []Flag `json:"flags,omitempty"`
}

// Narrowing drops manifest contributions the plugin cannot serve right now.
type Narrowing struct {
	Surfaces []string `json:"surfaces,omitempty"`
}

// InitializeResult is the plugin's answer.
type InitializeResult struct {
	Protocol     int        `json:"protocol"`
	Capabilities []string   `json:"capabilities,omitempty"`
	Narrow       *Narrowing `json:"narrow,omitempty"`
}

// CommandRequest is command/invoke's params: one of the manifest's commands with its
// validated args (as strings, defaults applied) and the caller's context.
type CommandRequest struct {
	// Command is the manifest name ("greet"), without the plugin.<name>. prefix.
	Command string            `json:"command"`
	Args    map[string]string `json:"args,omitempty"`
	Context UiContext         `json:"context"`
}

// Arg returns an argument's value, "" when absent.
func (r CommandRequest) Arg(name string) string { return r.Args[name] }

// CommandResult is what a command returns: Message is printed by the CLI and toasted by
// the palette; JSON is printed by the CLI with --json; a non-zero ExitCode is the CLI's
// exit status.
type CommandResult struct {
	Message  string          `json:"message,omitempty"`
	JSON     json.RawMessage `json:"json,omitempty"`
	ExitCode int             `json:"exitCode,omitempty"`
}

// InvokeParams is host/invoke's params.
type InvokeParams struct {
	Command string            `json:"command"`
	Args    map[string]string `json:"args,omitempty"`
	Context UiContext         `json:"context"`
	// Confirm is ConfirmNever (default: a command that asks the user first fails with
	// CodeConfirmationRequired) or ConfirmAsk: the host hands it to the GUI, which runs
	// it through its own confirm dialog, and answers at once with AskedResult as JSON
	// (still CodeConfirmationRequired when no GUI is connected). The plugin learns the
	// outcome from events.
	Confirm string `json:"confirm,omitempty"`
}

// InvokeParams.Confirm values.
const (
	ConfirmNever = "never"
	ConfirmAsk   = "ask"
)

// AskedResult is the JSON of host/invoke's result when a command was handed to the
// user (Confirm "ask").
type AskedResult struct {
	// Asked: the GUI shows the command's confirm dialog; Delivered counts the windows.
	Asked     bool `json:"asked"`
	Delivered int  `json:"delivered"`
}

// LogParams is the log notification's params.
type LogParams struct {
	Level string         `json:"level"` // debug, info, warn, error
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
}

// UnmarshalJSON decodes numbers in Attrs as json.Number, so an integer attr (a run id)
// prints as written ("39128319017"), never as a float ("3.9128319017e+10").
func (p *LogParams) UnmarshalJSON(b []byte) error {
	type plain LogParams
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v plain
	if err := d.Decode(&v); err != nil {
		return err
	}
	*p = LogParams(v)
	return nil
}

// SecretKeyParams names one secret.
type SecretKeyParams struct {
	Key string `json:"key"`
}

// SecretSetParams stores a secret.
type SecretSetParams struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

// SecretGetResult is secret/get's answer.
type SecretGetResult struct {
	Value string `json:"value,omitempty"`
	Found bool   `json:"found"`
}

// SecretInfo is one stored secret's name and when it was set; never its value.
type SecretInfo struct {
	Key       string    `json:"key"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// SecretListResult is secret/list's answer.
type SecretListResult struct {
	Secrets []SecretInfo `json:"secrets"`
}

// Flag levels for Host.SetFlag.
const (
	FlagAttention = "attention"
	FlagError     = "error"
	FlagNone      = "none"
)

// Flag raises (or with FlagNone clears) the plugin's flag on a thread. A thread has at
// most one flag per plugin; setting another replaces it. The GUI shows the reason as
// "<display name>: <reason>", so leave the plugin's name out of it.
type Flag struct {
	ThreadID string `json:"threadId"`
	Level    string `json:"level"`
	// Reason is one line, at most 80 characters ("deploy stage failed").
	Reason string `json:"reason,omitempty"`
	// UntilSeen clears the flag when the user opens the thread (at once when it is open).
	UntilSeen bool `json:"untilSeen,omitempty"`
	// SetAt is when the host recorded it (in InitializeParams.Flags; ignored on set).
	SetAt time.Time `json:"setAt,omitzero"`
}

// FlagResult is thread/setFlag's answer: whether anything changed.
type FlagResult struct {
	Changed bool `json:"changed"`
}

// ContextParams is context/set's params: a predicate key under "<plugin>.", global or
// for one thread or project.
type ContextParams struct {
	Key       string `json:"key"`
	Value     any    `json:"value"`
	ThreadID  string `json:"threadId,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
}

// Environment is the plugin's contribution to new Claude sessions: env, PATH entries
// and --add-dir directories, optionally limited to some projects.
type Environment struct {
	Env         map[string]string `json:"env,omitempty"`
	PathPrepend []string          `json:"pathPrepend,omitempty"`
	AddDirs     []string          `json:"addDirs,omitempty"`
	Scope       *EnvironmentScope `json:"scope,omitempty"`
}

// EnvironmentScope limits an Environment: empty Projects means every project.
type EnvironmentScope struct {
	Projects  []string `json:"projects,omitempty"`
	NoProject bool     `json:"noProject,omitempty"`
}

// EnvironmentResult is session/setEnvironment's answer.
type EnvironmentResult struct {
	Applied bool     `json:"applied"`
	Issues  []string `json:"issues,omitempty"`
}

// SubscribeParams is events/subscribe's params.
type SubscribeParams struct {
	Sources []string `json:"sources"`
}

// SubscribeResult names the subscription events/event carries.
type SubscribeResult struct {
	Subscription string `json:"subscription"`
}

// Event is one subscribed event (events/event). Event is the protojson of
// codefoundry.v1.Event, the shape the GUI's client sees. Snapshot marks the frames that
// bring the plugin to a source's current state: right after Subscribe, and again when
// the plugin fell behind and the host dropped events of the source.
type Event struct {
	Subscription string          `json:"subscription"`
	Snapshot     bool            `json:"snapshot,omitempty"`
	Event        json.RawMessage `json:"event"`
}

// Toast levels.
const (
	ToastInfo      = "info"
	ToastAttention = "attention"
	ToastError     = "error"
)

// ToastParams is view/toast's params.
type ToastParams struct {
	Instance string `json:"instance,omitempty"`
	Level    string `json:"level"`
	Text     string `json:"text"`
}

// SurfaceOpen is surface/open's params.
type SurfaceOpen struct {
	Instance string                     `json:"instance"`
	Surface  string                     `json:"surface"`
	Context  UiContext                  `json:"context"`
	Facts    map[string]json.RawMessage `json:"facts,omitempty"`
}

// SurfaceVisibility is surface/visibility's params.
type SurfaceVisibility struct {
	Instance string `json:"instance"`
	Visible  bool   `json:"visible"`
}

// SurfaceClose is surface/close's params.
type SurfaceClose struct {
	Instance string      `json:"instance"`
	Reason   CloseReason `json:"reason,omitempty"`
}

// CloseReason says why a surface instance closed (Surface.Close). A plugin's state for
// an instance (the selected run, a tab's scroll) goes with it: keep what must outlive a
// close in the plugin (by thread, project or pull request) and restore it on the next
// surface/open.
type CloseReason string

// Close reasons. The host sends the first three; the SDK closes with the last two.
const (
	// CloseIdle: no viewer for the host's grace (10 minutes).
	CloseIdle CloseReason = "idle"
	// CloseContextGone: the instance's thread was archived or removed, or its project
	// removed. It will not come back.
	CloseContextGone CloseReason = "context_gone"
	// CloseUnavailable: its when clause stopped holding while it was open (the pull
	// request's checks went away, a context fact changed). It opens afresh when the
	// clause holds again and someone looks.
	CloseUnavailable CloseReason = "unavailable"
	// CloseShutdown: the plugin is stopping (Serve is returning).
	CloseShutdown CloseReason = "shutdown"
	// CloseReopened: the host opened the same instance again (after a restart of the
	// host's side); the new Surface replaces this one.
	CloseReopened CloseReason = "reopened"
)

// SurfaceAct kinds.
const (
	ActClick  = "click"  // a button, row or chip with an event action
	ActSubmit = "submit" // a form's submit button
	ActChange = "change" // a field with a change event was edited
	ActTab    = "tab"    // the user switched tabs; Key and Value are the new tab's key
)

// SurfaceAct is surface/act's params: the user acted on a view element.
type SurfaceAct struct {
	Instance string `json:"instance"`
	// Context is what the panel the user acted in shows: its thread (and that thread's
	// project, worktree, workspace), or its project. A shared instance (scope pr,
	// project or global) learns from it which thread a click came from. From the CLI
	// (plugin act) it is the --context-* flags'.
	Context UiContext `json:"context"`
	// Version is the view version the user acted on (it may be older than the latest).
	Version uint64 `json:"version"`
	// Kind is ActClick, ActSubmit, ActChange or ActTab.
	Kind string `json:"kind"`
	// Action is the element's event name ("tab" for a tab).
	Action string `json:"action"`
	// Key is the element's key; Data the event's data, as the view declared it.
	Key  string `json:"key,omitempty"`
	Data string `json:"data,omitempty"`
	// Field is the name of the field a change is about.
	Field string `json:"field,omitempty"`
	// Value is a change's new value or a tab's key.
	Value any `json:"value,omitempty"`
	// Values are the enclosing form's fields by name (strings, booleans, string lists);
	// a secret input with store arrives as StoredSecret, and a secret never arrives in a
	// change.
	Values map[string]any `json:"values,omitempty"`
}

// StoredSecret replaces a secret input's value in SurfaceAct.Values when the input has
// a store key: the host wrote the value to the plugin's secrets (Secrets().Get(Key)).
// Decoded from JSON it is a map[string]any{"key", "stored"}: read it with
// SurfaceAct.Stored.
type StoredSecret struct {
	Key    string `json:"key"`
	Stored bool   `json:"stored"`
}

// Stored returns the secret a submit stored for the field name (a secret input with
// store), and whether it did: false when the user left the input empty.
func (a SurfaceAct) Stored(name string) (StoredSecret, bool) {
	switch v := a.Values[name].(type) {
	case StoredSecret:
		return v, v.Stored && v.Key != ""
	case map[string]any:
		key, _ := v["key"].(string)
		stored, _ := v["stored"].(bool)
		return StoredSecret{Key: key, Stored: stored}, stored && key != ""
	}
	return StoredSecret{}, false
}

// ViewUpdateParams is view/update's params.
type ViewUpdateParams struct {
	Instance string          `json:"instance"`
	View     json.RawMessage `json:"view"`
}

// ViewUpdateResult answers view/update and view/append: the instance's view version.
type ViewUpdateResult struct {
	Version uint64 `json:"version"`
}

// AppendLine is one toned line of a view/append to a lines log.
type AppendLine struct {
	Text string `json:"text"`
	Tone string `json:"tone,omitempty"`
}

// ViewAppendParams is view/append's params: Text extends a text log, Lines a lines
// log (each at most 64 KB per append). The host keeps the last 2,000 lines or 256 KB
// of each log node; a view that sets the node's text or lines replaces the buffer, one
// that leaves both empty keeps it.
type ViewAppendParams struct {
	Instance string       `json:"instance"`
	Key      string       `json:"key"`
	Text     string       `json:"text,omitempty"`
	Lines    []AppendLine `json:"lines,omitempty"`
}

// ThreadCreateParams is thread/create's params: a Claude thread the plugin owns (hidden
// from the user's thread list, shown in the plugin's thread nodes). The host checks Env
// and AddDirs like a session environment (reserved keys, paths under home, existing
// directories) and refuses the call naming each problem.
type ThreadCreateParams struct {
	// Title is the thread's name (one line, at most 120 characters).
	Title string `json:"title"`
	// Cwd is where Claude runs: an existing directory under the user's home ("~/" is
	// expanded). Default: the project's main worktree with ProjectID, else the plugin's
	// data dir. With ProjectID it must be one of that project's worktrees.
	Cwd string `json:"cwd,omitempty"`
	// ProjectID makes it a thread of that project (its scope for session environments,
	// pull requests and worktree panels).
	ProjectID string `json:"projectId,omitempty"`
	// AddDirs are --add-dir directories (a SKILL.md tree, say), after the host's own.
	AddDirs []string `json:"addDirs,omitempty"`
	// Env is added to the thread's environment, every time its Claude starts. It
	// replaces the plugin's own session environment for this thread (other plugins'
	// still apply).
	Env map[string]string `json:"env,omitempty"`
	// Model and Effort default to the user's settings (threads.default_model,
	// threads.default_effort).
	Model  string `json:"model,omitempty"`
	Effort string `json:"effort,omitempty"`
	// Prompt, when set, is the thread's first message.
	Prompt string `json:"prompt,omitempty"`
}

// ThreadCreateResult is thread/create's answer.
type ThreadCreateResult struct {
	ThreadID string `json:"threadId"`
}

// ThreadSendParams is thread/send's params.
type ThreadSendParams struct {
	ThreadID string `json:"threadId"`
	Text     string `json:"text"`
}

// ThreadRef names one of the plugin's threads.
type ThreadRef struct {
	ThreadID string `json:"threadId"`
}

// PluginThread is one of the plugin's threads (thread/list).
type PluginThread struct {
	ThreadID  string `json:"threadId"`
	Title     string `json:"title"`
	Cwd       string `json:"cwd"`
	ProjectID string `json:"projectId,omitempty"`
	Model     string `json:"model"`
	Effort    string `json:"effort,omitempty"`
	// State is Claude's process: starting, connected, closing or disconnected (stopped:
	// the next message starts it).
	State string `json:"state"`
	// Status is busy, idle, attention (a question, a permission prompt or a finished
	// turn), error, or unknown.
	Status    string    `json:"status"`
	Archived  bool      `json:"archived,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	// CostUSD is what the thread has cost so far (the Usage page's rates).
	CostUSD float64 `json:"costUsd,omitempty"`
}

// ThreadListResult is thread/list's answer, oldest first.
type ThreadListResult struct {
	Threads []PluginThread `json:"threads"`
}

// TerminalCreateParams is terminal/create's params: a terminal the plugin owns, shown
// in its terminal nodes and, on the user's request, in the bottom panel.
type TerminalCreateParams struct {
	// Argv is the program and its arguments (argv[0] is looked up on PATH). For the
	// user's own tools and aliases run "$SHELL", "-lc", "…".
	Argv []string `json:"argv"`
	// Cwd is an existing directory under the user's home; default the plugin's data dir.
	Cwd string `json:"cwd,omitempty"`
	// Env is added to the daemon's environment (checked like a session environment's).
	Env map[string]string `json:"env,omitempty"`
	// Title is the tab's title in the bottom panel (default argv[0]).
	Title string `json:"title,omitempty"`
}

// TerminalCreateResult is terminal/create's answer.
type TerminalCreateResult struct {
	TerminalID string `json:"terminalId"`
}

// TerminalRef names one of the plugin's terminals.
type TerminalRef struct {
	TerminalID string `json:"terminalId"`
}

// PluginTerminal is one of the plugin's terminals (terminal/list).
type PluginTerminal struct {
	TerminalID string   `json:"terminalId"`
	Title      string   `json:"title"`
	Argv       []string `json:"argv"`
	Cwd        string   `json:"cwd"`
	// State is running or exited; an exited terminal stays (its output readable) until
	// the plugin closes it.
	State     string    `json:"state"`
	ExitCode  int       `json:"exitCode,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// TerminalListResult is terminal/list's answer.
type TerminalListResult struct {
	Terminals []PluginTerminal `json:"terminals"`
}
