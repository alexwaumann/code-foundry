# The plugin protocol

`pluginsdk.Serve` implements all of this; read it to know what the host does and when.
The method names are constants in `pluginsdk` (`MethodSurfaceOpen`, …) and every params
and result type is a Go type there (`go doc github.com/alexwaumann/code-foundry/pluginsdk`).

## Wire

- JSON-RPC 2.0, one JSON object per line (UTF-8, `\n`-terminated, no Content-Length
  headers), host → plugin on the plugin's stdin, plugin → host on its stdout.
- stdout carries the protocol only. Logs go to stderr (every line lands in the plugin's
  log) or through the `log` notification (`h.Log()`). `Serve` points `os.Stdout` at stderr,
  so a stray `fmt.Println` is logged instead of breaking the stream.
- A line may be up to 4 MiB; a longer one is skipped. Each side queues at most 4 MiB for
  the other: a plugin that stops reading its stdin is restarted.
- Both sides send requests and notifications. The SDK runs each incoming request on its
  own goroutine (handlers run concurrently) and the notifications in order on one
  goroutine (`OnEvent`, visibility, close: return quickly). A panicking handler answers
  -32603 and the plugin keeps running.

## The process

- Started from `exec` with the **package folder as working directory** and a minimal
  environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`, `TZ`,
  `SSH_AUTH_SOCK`, plus `CODE_FOUNDRY_PLUGIN` (its name), `CODE_FOUNDRY_PLUGIN_DIR` (the
  package folder) and `CODE_FOUNDRY_PLUGIN_DATA` (its own state folder,
  `~/.code-foundry/plugin-data/<name>`, 0700, kept across updates). With the `api`
  permission also `CODE_FOUNDRY_ENDPOINT` and `CODE_FOUNDRY_TOKEN`. Never a thread id: the
  thread comes with each call's context.
- A tool the plugin runs (`gh`, `git`) is found on that PATH; it inherits the user's `gh`
  login through HOME.

## Lifecycle

1. The host starts the process and sends `initialize` (request, 5 s):
   `{protocol: 1, host: {version, capabilities}, plugin: {name, dir, dataDir, granted, dev}, flags}`.
   The plugin answers `{protocol: 1, capabilities: [...]}`. `Host.Name()`, `Dir()`,
   `DataDir()`, `Granted()`, `Dev()`, `HostVersion()`, `HasCapability()` and `Flags()`
   read it.
2. `initialized` (notification): the plugin is running. `Plugin.Init` runs now, on its own
   goroutine: subscribe, push the session environment, set context facts. An error from
   Init ends `Serve`, which the host counts as a crash.
3. Commands, surfaces, acts and events arrive while it runs. `ping` every 30 s (5 s to
   answer); two missed pings and the host restarts it.
4. `shutdown` (request, 2 s; `Plugin.Shutdown` gets 1.5 s), then the plugin exits. If it
   does not: stdin closed, then SIGTERM to its process group, then SIGKILL, 2 s apart.

**Crashes.** The process exiting while it should run (Init failing included), not
answering `initialize` in 5 s, two missed pings, or a full stdin queue is a crash. The
host restarts it after 1, 2, 4, … up to 60 s; 5 crashes within 10 minutes and it is
**failed** until `code-foundry plugin restart <name>` (10 minutes of running forgives
the count). A dev plugin (`plugin dev`) restarts within 2 s and never fails. A protocol
the host does not speak or a missing or non-executable `exec[0]` fails at once (a dev
plugin keeps retrying: you are about to build it). While it is down its commands stay
listed and fail with the reason; its surfaces say so.

## Host → plugin

| Method | Kind (timeout) | Params → result | SDK |
|---|---|---|---|
| `initialize` | request (5 s) | `InitializeParams` → `InitializeResult` | Serve |
| `initialized` | notification | `{}` | `Plugin.Init` |
| `ping` | request (5 s) | `{}` → `{}` | Serve |
| `shutdown` | request (2 s) | `{}` → `{}` | `Plugin.Shutdown` |
| `command/invoke` | request (the command's `timeoutSeconds`) | `CommandRequest{command, args, context}` → `CommandResult{message, json, exitCode}` | `Plugin.Commands[command]` |
| `surface/open` | request (5 s) | `SurfaceOpen{instance, surface, context, facts}` → `{}` | `Plugin.Surfaces[surface]` |
| `surface/visibility` | notification | `{instance, visible}`: viewers went from none to some (also right after open) or back | `Surface.Visibility` |
| `surface/close` | notification | `{instance, reason}`: `idle` (no viewer for 60 s), `shutdown` | `Surface.Close` |
| `surface/act` | request (10 s) | `SurfaceAct{instance, version, kind, action, key, data, field, value, values}` → `{}` | `Surface.Act` |
| `events/event` | notification | `Event{subscription, snapshot, event}` | `Plugin.OnEvent` |

After `surface/open` the plugin sends the instance's view with `view/update` within 10 s
(else the host shows "not responding"); a view sent before it answers the open counts, so
render inside the factory. An error from the factory or from `Act` is shown to the user
(the CLI's `plugin act` prints it and exits 1).

## Plugin → host

| Method | Kind | Params → result | SDK | Needs |
|---|---|---|---|---|
| `log` | notification | `{level: debug\|info\|warn\|error, msg, attrs}` | `h.Log()` (slog) | |
| `host/invoke` | request | `{command, args, context, confirm: never\|ask}` → `CommandResult` | `Invoke`, `InvokeAsk` | `commands` glob |
| `secret/get` / `set` / `delete` / `list` | request | `{key}` → `{value, found}`; `{key, value}`; `{key}`; → `{secrets: [{key, updatedAt}]}` | `h.Secrets()` | `secrets` |
| `view/update` | request (or notification) | `{instance, view}` → `{version}` | `UpdateView` | |
| `view/append` | request (or notification) | `{instance, key, text \| lines}` → `{version}` | `AppendLog`, `AppendLogLines` | |
| `view/toast` | notification | `{instance?, level: info\|attention\|error, text}` | `Toast`, `ToastIn` | |
| `context/set` | notification | `{key, value, threadId? \| projectId?}` | `SetContext` | |
| `thread/setFlag` | request | `{threadId, level, reason, untilSeen}` → `{changed}` | `SetFlag` | `threadStatus` |
| `events/subscribe` | request | `{sources}` → `{subscription}` | `Subscribe` | `events` |
| `events/unsubscribe` | request | `{subscription}` → `{}` | `Unsubscribe` | |
| `session/setEnvironment` | request | `{env, pathPrepend, addDirs, scope}` → `{applied, issues}` | `SetEnvironment` | `sessionEnv` |
| `thread/create`, `thread/send`, `terminal/create`, `terminal/close` | request | (later version) | none yet | `threads`, `terminals` |

What each does and its limits: `reference/host-api.md`. A method this host does not
support answers -32601 ("not supported yet by this Code Foundry").

## Errors

| Code | `pluginsdk` constant | Meaning |
|---|---|---|
| -32700, -32600 | `CodeParseError`, `CodeInvalidRequest` | malformed line or message |
| -32601 | `CodeMethodNotFound` | unknown or not yet supported method |
| -32602 | `CodeInvalidParams` | bad params; a refused view (the message names each problem); from a command: a usage error (CLI exit 2) |
| -32603 | `CodeInternal` | any other error, a panic |
| -32001 | `CodePermissionDenied` | the grant does not cover the call |
| -32002 | `CodeUnavailable` | not available in that context (the message says why), an archived thread |
| -32003 | `CodeConfirmationRequired` | the command asks the user first (`data.message`); use `InvokeAsk` |
| -32004 | `CodeNotFound` | no such command, surface, instance or thread |
| -32005 | `CodeRateLimited` | too fast (flags, toasts) |

A handler returns `pluginsdk.NewError(code, format, ...)` to choose the code; any other
error is -32603 with its message. `pluginsdk.ErrorCode(err)` reads a returned error's
code; `pluginsdk.ErrClosed` means the host went away (Serve is ending).

## Capabilities

`initialize` lists what the host supports, so a plugin can work with older and newer
hosts: `invoke`, `invoke.ask`, `secrets`, `log`, `surfaces`, `view.v1`, `view.append`,
`view.node.<kind>` for each node kind it renders, `view.tabs`, `view.fieldset`,
`view.optionsSource`, `view.duration`, `context`, `events`, `flags`, `sessionEnv`.
Check `h.HasCapability("view.node.chips")` before relying on something newer than
protocol 1's first release; `thread` and `terminal` nodes are not announced yet.

## Without the SDK

Any language works: the handshake as the host sends it, then one command.

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol":1,"host":{"version":"v0.20.0","capabilities":["invoke","log"]},"plugin":{"name":"echo","dir":"/Users/a/.code-foundry/plugins/echo","dataDir":"/Users/a/.code-foundry/plugin-data/echo","granted":{}}}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol":1,"capabilities":["ping"]}}
→ {"jsonrpc":"2.0","method":"initialized","params":{}}
→ {"jsonrpc":"2.0","id":2,"method":"command/invoke","params":{"command":"say","args":{"text":"hi"},"context":{"threadId":"s-1f2e3d4c5b6a"}}}
← {"jsonrpc":"2.0","method":"log","params":{"level":"info","msg":"said","attrs":{"n":1}}}
← {"jsonrpc":"2.0","id":2,"result":{"message":"hi"}}
→ {"jsonrpc":"2.0","id":3,"method":"shutdown","params":{}}
← {"jsonrpc":"2.0","id":3,"result":{}}
```
