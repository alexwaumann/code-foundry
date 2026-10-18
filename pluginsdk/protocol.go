package pluginsdk

import (
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
	// MethodSurfaceOpen, MethodSurfaceVisibility, MethodSurfaceClose and MethodSurfaceAct
	// drive surface instances (protocol PR 2).
	MethodSurfaceOpen       = "surface/open"
	MethodSurfaceVisibility = "surface/visibility"
	MethodSurfaceClose      = "surface/close"
	MethodSurfaceAct        = "surface/act"
	// MethodEventsEvent (notification) carries one subscribed event (protocol PR 3).
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
	// The rest arrive with later protocol PRs; until a host supports one it answers
	// CodeMethodNotFound.
	MethodViewUpdate        = "view/update"
	MethodViewToast         = "view/toast"
	MethodContextSet        = "context/set"
	MethodThreadSetFlag     = "thread/setFlag"
	MethodEventsSubscribe   = "events/subscribe"
	MethodEventsUnsubscribe = "events/unsubscribe"
	MethodSetEnvironment    = "session/setEnvironment"
	MethodThreadCreate      = "thread/create"
	MethodThreadSend        = "thread/send"
	MethodTerminalCreate    = "terminal/create"
	MethodTerminalClose     = "terminal/close"
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
	// Confirm is "never" (default: a command that asks the user first fails with
	// CodeConfirmationRequired) or "ask" (the host asks the user in the GUI; protocol
	// PR 2).
	Confirm string `json:"confirm,omitempty"`
}

// LogParams is the log notification's params.
type LogParams struct {
	Level string         `json:"level"` // debug, info, warn, error
	Msg   string         `json:"msg"`
	Attrs map[string]any `json:"attrs,omitempty"`
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

// SurfaceAct is surface/act's params: the user acted on a view element.
type SurfaceAct struct {
	Instance string `json:"instance"`
	Version  uint64 `json:"version"`
	// Kind is "click", "submit", "change" or "tab".
	Kind   string         `json:"kind"`
	Action string         `json:"action"`
	Key    string         `json:"key,omitempty"`
	Data   string         `json:"data,omitempty"`
	Field  string         `json:"field,omitempty"`
	Values map[string]any `json:"values,omitempty"`
}

// ViewUpdateParams is view/update's params.
type ViewUpdateParams struct {
	Instance string          `json:"instance"`
	View     json.RawMessage `json:"view"`
}
