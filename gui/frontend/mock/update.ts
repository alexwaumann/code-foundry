/**
 * Mock updater: the daemon's UpdateService state machine (internal/store/update) with
 * timers instead of gh and the installer. Driven by the app.* commands and by test
 * controls (see server.ts /__mock/update/*).
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
  cmd: { name: string; title: string; category: string; description: string; keybindings: string[]; args: [] };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
}

const REPO = "alexwaumann/code-foundry";
const PROGRESS = [
  "==> upgrading Code Foundry v0.1.0 -> {v}",
  "==> downloading CodeFoundry-darwin-arm64.zip from alexwaumann/code-foundry {v}",
  "==> verifying checksum",
  "==> unpacking",
  "==> installed ~/Applications/CodeFoundry.app",
];

export const updateStateNames: Record<string, UpdateState> = {
  idle: UpdateState.IDLE,
  available: UpdateState.AVAILABLE,
  downloading: UpdateState.DOWNLOADING,
  installed: UpdateState.INSTALLED,
  restartRequired: UpdateState.RESTART_REQUIRED,
  failed: UpdateState.FAILED,
};

export class MockUpdater {
  status!: MockStatus;
  latest = "v0.1.0";
  /** The next install fails with this reason (cleared after use). */
  failNext = "";
  /** Install progress step interval. */
  stepMs = 250;
  relaunches = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly publish: (e: UpdateEventInit) => number,
    private readonly liveSessions: () => number,
  ) {
    this.reset();
  }

  reset(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.latest = "v0.1.0";
    this.failNext = "";
    this.relaunches = 0;
    this.status = {
      state: UpdateState.IDLE,
      currentVersion: "v0.1.0",
      enabled: true,
      disabledReason: "",
      releaseRepo: REPO,
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
    const installedTarget = s.state === UpdateState.INSTALLED || s.state === UpdateState.RESTART_REQUIRED ? s.targetVersion : "";
    if (newer && this.latest !== installedTarget) this.set(UpdateState.AVAILABLE, this.latest);
    else if (!installedTarget) this.set(UpdateState.IDLE, "");
    else this.emit();
    return this.status;
  }

  install(): string {
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
            this.set(UpdateState.INSTALLED, target);
          }
        },
        this.stepMs * (PROGRESS.length + 1),
      ),
    );
    return `installing ${target}`;
  }

  relaunch(): number {
    this.relaunches++;
    if (this.status.state === UpdateState.INSTALLED) this.set(UpdateState.RESTART_REQUIRED);
    return this.publish({ event: { case: "relaunchRequested", value: {} } });
  }

  /** daemon.restart: the mock keeps running but comes back as the installed version. */
  restart(): string {
    if (this.status.state === UpdateState.DOWNLOADING) throw new Error("an update is being installed; restart when it finishes");
    const n = this.liveSessions();
    const installed = this.status.state === UpdateState.INSTALLED || this.status.state === UpdateState.RESTART_REQUIRED;
    if (installed) this.status.currentVersion = this.status.targetVersion;
    this.set(UpdateState.IDLE, "");
    return `restarting the daemon: closing ${String(n)} session${n === 1 ? "" : "s"}; the next client starts the installed version`;
  }

  private installable(): boolean {
    const s = this.status.state;
    return (s === UpdateState.AVAILABLE || s === UpdateState.FAILED) && this.status.targetVersion !== "";
  }

  commands(): UpdateCommandEntry[] {
    const always = () => true;
    return [
      {
        cmd: { name: "app.version", title: "Version", category: "App", description: "Show the running version", keybindings: [], args: [] },
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
          title: this.installable() ? `Update to ${this.status.targetVersion}` : "Update Code Foundry",
          category: "App",
          description: "Download and install the available update",
          keybindings: [],
          args: [],
        },
        when: () => this.installable(),
        run: () => this.install(),
      },
      {
        cmd: { name: "app.relaunch", title: "Relaunch App", category: "App", description: "Quit and reopen the app window", keybindings: [], args: [] },
        when: always,
        run: () => (this.relaunch() === 0 ? "no app window is connected; open it with `code-foundry gui`" : "relaunching the app"),
      },
      {
        cmd: { name: "daemon.restart", title: "Restart Daemon", category: "Daemon", description: "Close every session and restart the daemon", keybindings: [], args: [] },
        when: always,
        run: () => this.restart(),
      },
    ];
  }
}
