/**
 * Mock BrowserService (docs/notes/chrome-surface.md): the experimental Chrome surface with no
 * Chrome. A Watch sends the state and a small JPEG; POST /__mock/browser merges fields into the
 * state and sends it; GET /__mock/browser lists what the GUI called. Off unless
 * experimental.chrome_surface is on, when the commands do not exist, as in the daemon.
 */
import { BrowserPhase, type BrowserState } from "../src/gen/codefoundry/v1/browser_pb";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { Hub } from "./hub";
import { panelThreadArgs } from "./panelVerbs";
import type { UiIntentInit } from "./world";

/** A 16x16 grey JPEG. */
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAQABABAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AL+AD//Z",
  "base64",
);

type Fields = Partial<Omit<BrowserState, "$typeName" | "$unknown">>;

type Event = { event: { case: "state"; value: Fields } | { case: "frame"; value: { jpeg: Uint8Array; width: number; height: number } } };

export class MockBrowser {
  readonly calls: string[] = [];
  private state: Fields = { phase: BrowserPhase.READY, url: "about:blank" };
  private readonly events = new Hub<Event>();

  constructor(private readonly enabled: () => boolean) {}

  /** The service, for router.service. */
  watch(req: { surface: string; width: number; height: number; url: string }, signal: AbortSignal): AsyncGenerator<Event> {
    this.record(`watch ${req.surface} ${String(req.width)}x${String(req.height)} ${req.url}`.trim());
    if (req.url) this.state = { ...this.state, url: req.url };
    return this.events.subscribe(signal, [{ event: { case: "state", value: this.state } }, this.frame(req.width, req.height)]);
  }

  private frame(width: number, height: number): Event {
    return { event: { case: "frame", value: { jpeg: JPEG, width, height } } };
  }

  record(call: string): void {
    this.calls.push(call);
  }

  navigate(surface: string, url: string): { url: string } {
    this.record(`navigate ${surface} ${url}`);
    this.update({ url });
    return { url };
  }

  /** Merges fields into the state and sends it (POST /__mock/browser). */
  update(fields: Fields): void {
    this.state = { ...this.state, ...fields };
    this.events.publish({ event: { case: "state", value: this.state } });
  }

  reset(): void {
    this.calls.length = 0;
    this.state = { phase: BrowserPhase.READY, url: "about:blank" };
  }

  commands(emit: (i: UiIntentInit) => number) {
    const when = () => this.enabled();
    const refused = (name: string, title: string) => ({
      cmd: { name, title, category: "Browser", description: `${title}. Only from the window: refused from the CLI.`, keybindings: [] as string[], args: [] },
      when,
      run: (): string => {
        throw new Error(`${name}: not available in this context: only the user can do this, from the window`);
      },
    });
    return [
      {
        cmd: {
          name: "view.panel.browser",
          title: "Show Browser",
          category: "View",
          description: "Experimental: open the Browser tab in a thread's side panel, optionally at --url.",
          keybindings: [] as string[],
          args: [{ name: "url", type: ArgType.STRING, required: false, description: "Where to go: http or https only" }, ...panelThreadArgs],
        },
        when,
        run: (_ctx: UiContext | undefined, a: Record<string, string>): string => {
          const params: Record<string, string> = a.url ? { url: a.url } : {};
          return `delivered=${String(emit({ intent: { case: "showView", value: { name: "panel.browser", threadId: a.thread ?? "", params } } }))}`;
        },
      },
      refused("browser.back", "Browser: Back"),
      refused("browser.forward", "Browser: Forward"),
      refused("browser.reload", "Browser: Reload"),
      refused("browser.relaunch", "Browser: Relaunch Chrome"),
    ];
  }
}
