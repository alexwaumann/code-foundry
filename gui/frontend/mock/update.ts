/**
 * Mock updater: the daemon's UpdateService state machine (internal/store/update) with
 * timers instead of gh and the installer. Driven by the app.* commands and by test
 * controls (see server.ts /__mock/update/*). Download (app.update) stages the release:
 * Available → Downloading → Downloaded (or Failed); Install, which app.restart runs
 * first, swaps it in: Downloaded → Installed.
 *
 * Initial state: v0.1.0, up to date, latest release v0.1.0. POST
 * /__mock/update/latest?version=v0.2.0 publishes a newer release for the next check.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { UpdateState, type UpdateEventSchema, type UpdateStatusSchema } from "../src/gen/codefoundry/v1/update_pb";

export type UpdateEventInit = MessageInitShape<typeof UpdateEventSchema>;
type UpdateStatusInit = MessageInitShape<typeof UpdateStatusSchema>;

interface MockStatus {
  state: UpdateState;
  currentVersion: string;
  enabled: boolean;
  disabledReason: string;
  releaseRepo: string;
  channel: string;
  checking: boolean;
  lastCheckedAt: Date | null;
  lastCheckError: string;
  latestVersion: string;
  targetVersion: string;
  notesUrl: string;
  progress: string;
  failureReason: string;
}

/** Entry shape of World.registry(). */
export interface UpdateCommandEntry {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    noPalette?: boolean;
    args: [];
    /** Destructive: Invoke needs confirmed=true (see World.invoke). */
    confirm?: (ctx: UiContext | undefined) => string;
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
}

const REPO = "alexwaumann/code-foundry";
/** install.sh --stage-only's output. */
const PROGRESS = [
  "==> downloading code-foundry-darwin-arm64.tar.gz from alexwaumann/code-foundry {v}",
  "==> verifying checksum",
  "==> unpacking",
  "==> downloaded {v} to ~/.code-foundry/app.new",
];

export const updateStateNames: Record<string, UpdateState> = {
  idle: UpdateState.IDLE,
  available: UpdateState.AVAILABLE,
  downloading: UpdateState.DOWNLOADING,
  downloaded: UpdateState.DOWNLOADED,
  installed: UpdateState.INSTALLED,
  restartRequired: UpdateState.RESTART_REQUIRED,
  failed: UpdateState.FAILED,
};

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * What a restart cuts off, summed over the threads (the daemon's command.RestartCost):
 * threads that lose something, of them the ones working or waiting on the user, and the
 * background agents and shells of running threads.
 */
export interface RestartCost {
  threads: number;
  midTurn: number;
  agents: number;
  shells: number;
}

/** The daemon's RestartCost.String: "1 thread working or waiting on you and 2 background agents". */
function costText(c: RestartCost): string {
  const parts: string[] = [];
  if (c.midTurn > 0) parts.push(`${plural(c.midTurn, "thread")} working or waiting on you`);
  if (c.agents > 0 && c.shells > 0) parts.push(`${plural(c.agents, "background agent")} and ${plural(c.shells, "shell")}`);
  else if (c.agents > 0) parts.push(plural(c.agents, "background agent"));
  else if (c.shells > 0) parts.push(plural(c.shells, "background shell"));
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1] ?? ""}`;
}

/** The daemon's restartConfirm: "Restart the daemon? Threads keep their history; …". */
function restartConfirm(what: string, c: RestartCost): string {
  if (c.threads === 0) return `${what}? Threads keep their history; a message starts each again.`;
  return `${costText(c)} will be cut off. ${what} anyway?`;
}

/** The daemon's cutOff: " (cuts off 1 thread working or waiting on you)" for a restart's result, "" for none. */
function cutOff(c: RestartCost): string {
  return c.threads === 0 ? "" : ` (cuts off ${costText(c)})`;
}

export class MockUpdater {
  status!: MockStatus;
  latest = "v0.1.0";
  /** The next download fails with this reason (cleared after use). */
  failNext = "";
  /** Download progress step interval. */
  stepMs = 250;
  relaunches = 0;
  /** app.restart runs (Restart Now). */
  restarts = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly publish: (e: UpdateEventInit) => number,
    /** What a restart cuts off (the daemon's command.RestartCostOf). */
    private readonly restartCost: () => RestartCost,
  ) {
    this.reset();
  }

  reset(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.latest = "v0.1.0";
    this.failNext = "";
    this.relaunches = 0;
    this.restarts = 0;
    this.status = {
      state: UpdateState.IDLE,
      currentVersion: "v0.1.0",
      enabled: true,
      disabledReason: "",
      releaseRepo: REPO,
      channel: "stable",
      checking: false,
      lastCheckedAt: null,
      lastCheckError: "",
      latestVersion: "",
      targetVersion: "",
      notesUrl: "",
      progress: "",
      failureReason: "",
    };
    this.emit();
  }

  msg(): UpdateStatusInit {
    const s = this.status;
    return { ...s, lastCheckedAt: s.lastCheckedAt ? timestampFromDate(s.lastCheckedAt) : undefined };
  }

  event(): UpdateEventInit {
    return { event: { case: "status", value: this.msg() } };
  }

  private emit(): void {
    this.publish(this.event());
  }

  /** Moves to state (test control and internal transitions). */
  set(state: UpdateState, target = this.status.targetVersion, extra: Partial<MockStatus> = {}): void {
    const notesUrl = target ? `https://github.com/${REPO}/releases/tag/${target}` : "";
    this.status = { ...this.status, state, targetVersion: target, notesUrl, progress: "", failureReason: "", ...extra };
    this.emit();
  }

  check(): MockStatus {
    if (!this.status.enabled) throw new Error(`updates are disabled: ${this.status.disabledReason}`);
    const s = this.status;
    s.lastCheckedAt = new Date();
    s.latestVersion = this.latest;
    s.lastCheckError = "";
    if (s.state === UpdateState.DOWNLOADING) {
      this.emit();
      return s;
    }
    const newer = this.latest !== s.currentVersion && this.latest > s.currentVersion;
    // A download or an install of the latest stays; a newer release is offered over it.
    const installedTarget = s.state === UpdateState.DOWNLOADED || s.state === UpdateState.INSTALLED || s.state === UpdateState.RESTART_REQUIRED ? s.targetVersion : "";
    if (newer && this.latest !== installedTarget) this.set(UpdateState.AVAILABLE, this.latest);
    else if (!installedTarget) this.set(UpdateState.IDLE, "");
    else this.emit();
    return this.status;
  }

  /** UpdateService.Download: stages the target in the background (app.update). */
  download(): string {
    const s = this.status;
    if (s.state !== UpdateState.AVAILABLE && s.state !== UpdateState.FAILED) throw new Error("no update available");
    const target = s.targetVersion;
    this.set(UpdateState.DOWNLOADING, target, { progress: "starting installer" });
    PROGRESS.forEach((line, i) => {
      this.timers.push(
        setTimeout(
          () => {
            if (this.status.state !== UpdateState.DOWNLOADING) return;
            this.status = { ...this.status, progress: line.replace("{v}", target) };
            this.emit();
          },
          this.stepMs * (i + 1),
        ),
      );
    });
    this.timers.push(
      setTimeout(
        () => {
          if (this.failNext) {
            const reason = this.failNext;
            this.failNext = "";
            this.set(UpdateState.FAILED, target, { failureReason: reason });
          } else {
            this.set(UpdateState.DOWNLOADED, target);
          }
        },
        this.stepMs * (PROGRESS.length + 1),
      ),
    );
    return `downloading ${target}`;
  }

  /** UpdateService.Install: the synchronous swap app.restart runs before restarting. */
  install(): string {
    if (this.status.state !== UpdateState.DOWNLOADED) throw new Error("no downloaded update to install");
    this.set(UpdateState.INSTALLED);
    return this.status.targetVersion;
  }

  private downloadedTarget(): string {
    return this.status.state === UpdateState.DOWNLOADED ? this.status.targetVersion : "";
  }

  relaunch(): number {
    this.relaunches++;
    if (this.status.state === UpdateState.INSTALLED) this.set(UpdateState.RESTART_REQUIRED);
    return this.publish({ event: { case: "relaunchRequested", value: {} } });
  }

  /**
   * daemon.restart: the mock keeps running but comes back as the installed version. It
   * installs nothing: a download survives (the new daemon starts in Downloaded).
   */
  restart(): string {
    if (this.status.state === UpdateState.DOWNLOADING) throw new Error("an update is downloading; restart when it finishes");
    const n = this.restartCost();
    const installed = this.status.state === UpdateState.INSTALLED || this.status.state === UpdateState.RESTART_REQUIRED;
    if (installed) this.status.currentVersion = this.status.targetVersion;
    if (this.status.state !== UpdateState.DOWNLOADED) this.set(UpdateState.IDLE, "");
    else this.emit();
    return `restarting the daemon${cutOff(n)}; the next client starts the installed version`;
  }

  /** app.restart: installs a download first (a failed install restarts nothing), then restarts. */
  restartApp(): string {
    if (this.status.state === UpdateState.DOWNLOADING) throw new Error("an update is downloading; restart when it finishes");
    const installed = this.downloadedTarget() ? this.install() : "";
    this.restarts++;
    const msg = this.restart().replace("restarting the daemon", "restarting Code Foundry").replace("the next client starts the installed version", "the app relaunches once the daemon has stopped");
    return installed ? `installed ${installed}; ${msg}` : msg;
  }

  private installable(): boolean {
    const s = this.status.state;
    return (s === UpdateState.AVAILABLE || s === UpdateState.FAILED) && this.status.targetVersion !== "";
  }

  commands(): UpdateCommandEntry[] {
    const always = () => true;
    return [
      {
        cmd: { name: "app.version", noPalette: true, title: "Version", category: "App", description: "Show the running version", keybindings: [], args: [] },
        when: always,
        run: () => `Code Foundry ${this.status.currentVersion}`,
      },
      {
        cmd: { name: "app.update.check", title: "Check for Updates", category: "App", description: "Ask GitHub for the latest release now", keybindings: [], args: [] },
        when: always,
        run: () => {
          const s = this.check();
          return s.state === UpdateState.AVAILABLE ? `${s.targetVersion} available` : `Code Foundry ${s.currentVersion} is up to date`;
        },
      },
      {
        cmd: {
          name: "app.update",
          title: this.installable() ? `Download ${this.status.targetVersion}` : "Download Update",
          category: "App",
          description: "Download the available update in the background. Nothing changes on disk until `app.restart` installs it and restarts; until then the app and daemon keep running the current version.",
          keybindings: [],
          args: [],
        },
        when: () => this.installable(),
        run: () => this.download(),
      },
      {
        cmd: { name: "app.relaunch", title: "Relaunch App", category: "App", description: "Quit and reopen the app window", keybindings: [], args: [] },
        when: always,
        run: () => (this.relaunch() === 0 ? "no app window is connected; open it with `code-foundry gui`" : "relaunching the app"),
      },
      {
        // The update dialog's (Install and) Restart Now (confirmed: the dialog is the
        // confirmation). The real daemon installs a download, stops threads, asks the
        // window host to relaunch once it has exited, and exits; the mock comes back as the
        // installed version, like daemon.restart.
        cmd: {
          name: "app.restart",
          title: this.downloadedTarget() ? `Install ${this.downloadedTarget()} and Restart` : "Restart Code Foundry",
          category: "App",
          description:
            "Restart the daemon and relaunch the app so both run the installed version, installing a downloaded update first. Threads keep their history and a message starts each again; a turn or background work running is cut off.",
          keybindings: [],
          args: [],
          confirm: () => {
            const t = this.downloadedTarget();
            return restartConfirm(t ? `Install ${t} and restart Code Foundry` : "Restart Code Foundry", this.restartCost());
          },
        },
        when: always,
        run: () => this.restartApp(),
      },
      {
        cmd: {
          name: "daemon.restart",
          title: "Restart Daemon",
          category: "Daemon",
          description: "Restart the daemon, so it runs the installed version. Threads keep their history and a message starts each again; one that is working is cut off.",
          keybindings: [],
          args: [],
          confirm: () => restartConfirm("Restart the daemon", this.restartCost()),
        },
        when: always,
        run: () => this.restart(),
      },
    ];
  }
}
