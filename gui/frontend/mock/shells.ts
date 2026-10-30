/**
 * A thread's own background shells in the mock daemon (docs/notes/background-shells.md):
 * Bash calls with run_in_background and Monitor calls. Their result comes at once and
 * their item stays running until the shell ends; Thread.background_shells_running
 * counts the running ones (mock/world.ts threadMsg), so the strip above the composer
 * shows them.
 *
 *   POST /__mock/thread?state=shells   shells only: a Bash run_in_background and a Monitor
 *        running, the thread idle at its prompt (state=agents has one shell beside its agents)
 *   POST /__mock/thread/shell-end?id=s-r1[&status=failed]   the oldest running shell ends:
 *        its call done with Claude's summary (or an error with it), the count published
 *
 * Thread.background_shells lists them with the ports each listens on (the thread info
 * card's server rows, docs/notes/thread-servers.md); thread.shell.stop ends one with a
 * note, as the daemon's stop does once Claude reports the shell killed.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ToolCallStatus, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { ArgType } from "../src/gen/codefoundry/v1/command_pb";
import type { AgentThreads, AgentsScript, Command } from "./agents";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;

/** A running shell: its call's item id, what Thread.background_shells says of it, and what its end says. */
export interface ShellCall {
  toolUseId: string;
  taskId: string;
  command: string;
  description: string;
  monitor: boolean;
  startedAt: Date;
  /** The TCP ports its process group listens on (the daemon's probe); [] for none. */
  ports: number[];
}

const callId = (it: ItemInit) => (it.payload?.case === "toolCall" ? (it.payload.value.toolUseId ?? "") : "");

/** A background shell's call, running, with the launch result Claude gives at once. */
export function launchShell(s: AgentsScript, o: { taskId: string; command: string; description: string; monitor?: boolean; at: Date; ports?: number[] }): ShellCall {
  const monitor = o.monitor ?? false;
  const call = monitor
    ? s.tool(
        "Monitor",
        { command: o.command, description: o.description, timeout_ms: 1_800_000 },
        {
          status: ToolCallStatus.RUNNING,
          output: `Monitor started (task ${o.taskId}, expires in 30m unless the source ends first). You will be notified on each event.`,
          resultJson: JSON.stringify({ taskId: o.taskId, timeoutMs: 1_800_000, persistent: false }),
        },
        { at: o.at },
      )
    : s.tool(
        "Bash",
        { command: o.command, description: o.description, run_in_background: true },
        {
          status: ToolCallStatus.RUNNING,
          output: `Command running in background with ID: ${o.taskId}. Output is being written to: /private/tmp/claude-501/tasks/${o.taskId}.output. You will be notified when it completes.`,
          resultJson: JSON.stringify({ stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: o.taskId }),
        },
        { at: o.at },
      );
  return { toolUseId: callId(call), taskId: o.taskId, command: o.command, description: o.description, monitor, startedAt: o.at, ports: o.ports ?? [] };
}

/** The "shells" state's conversation: a dev server and a CI watch left running. */
export function scriptShells(s: AgentsScript, now = Date.now()): ShellCall[] {
  const ago = (sec: number) => new Date(now - sec * 1000);
  s.it({ case: "userMessage", value: { text: "Start the e2e suite in the background and watch CI on the PR; tell me when either is done.", attachments: [] } }, { at: ago(95) });
  const shells = [
    launchShell(s, { taskId: "bq3k9x2m1", command: "make gui-e2e", description: "Run the GUI e2e suite", at: ago(90) }),
    launchShell(s, { taskId: "bmw7c0r4e", command: "gh pr checks 105 --watch --fail-fast", description: "Wait for CI on PR 105", monitor: true, at: ago(86) }),
  ];
  s.it({ case: "assistantText", value: { text: "Both are running in the background: the e2e suite and a watch on PR 105's checks. I will report when they end." } }, { at: ago(84) });
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 11_000n, numTurns: 3, costUsd: 0.03, turnCostUsd: 0.03, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(83) });
  return shells;
}

/**
 * The thread info card's "servers" scenario (World.addThreadInfo): two dev servers
 * listening (one on two ports) beside the "shells" state's two shells that do not.
 */
export function scriptServers(s: AgentsScript, now = Date.now()): ShellCall[] {
  const ago = (sec: number) => new Date(now - sec * 1000);
  const shells = scriptShells(s, now);
  s.it({ case: "userMessage", value: { text: "Serve the docs preview and start the web dev server too.", attachments: [] } }, { at: ago(80) });
  const servers = [
    launchShell(s, { taskId: "bk4v8n2p7", command: "pnpm --dir web dev", description: "Start the web dev server", at: ago(78), ports: [5173, 24678] }),
    launchShell(s, { taskId: "bd9r3t6w1", command: "python3 -m http.server 9399 --directory docs/_build", description: "Serve the docs preview", at: ago(74), ports: [9399] }),
  ];
  s.it({ case: "assistantText", value: { text: "The web dev server is on localhost:5173 and the docs preview on localhost:9399." } }, { at: ago(72) });
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 6_000n, numTurns: 3, costUsd: 0.02, turnCostUsd: 0.02, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(71) });
  return [...shells, ...servers];
}

/** Claude's summary of a shell's end, as the daemon puts it on the call. */
export function shellSummary(c: ShellCall, failed: boolean): string {
  if (c.monitor) return `Monitor "${c.description}" stream ended`;
  return failed ? `Background command "${c.description}" failed with exit code 2` : `Background command "${c.description}" completed (exit code 0)`;
}

/** thread.shell.stop, like the daemon's: the shell ends at once with its stop note. */
export function shellCommands(threads: AgentThreads): Command[] {
  return [
    {
      cmd: {
        name: "thread.shell.stop",
        noPalette: true,
        title: "Stop Background Shell",
        category: "Thread",
        description: "Stop one of a thread's own background shells (a Bash call run in the background, a Monitor): its process group gets SIGTERM, then SIGKILL 3 seconds later.",
        keybindings: [],
        args: [
          { name: "task", type: ArgType.STRING, required: true, description: "The shell's task id (thread get lists them)" },
          { name: "id", type: ArgType.STRING, required: true, description: "Thread id" },
        ],
      },
      when: (ctx) => Boolean(ctx?.activeThreadId),
      run: (ctx, a) => {
        const id = a.id || ctx?.activeThreadId || "";
        const task = a.task ?? "";
        threads.calls.push(`shell stop ${id} ${task}`);
        threads.stopShell(id, task);
        return `stopping background shell ${task} of thread ${id}`;
      },
    },
  ];
}
