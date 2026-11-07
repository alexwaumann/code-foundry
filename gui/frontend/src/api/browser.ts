/**
 * BrowserService, the experimental Chrome surface (docs/notes/chrome-surface.md). Generated
 * types stay here. Every string in a view that came from a page is the page's: it is shown as
 * text, never as markup.
 */
import { create } from "@bufbuild/protobuf";
import {
  BrowserInputEventSchema,
  BrowserKeyEventSchema,
  BrowserMouseEventSchema,
  BrowserPhase,
  BrowserService,
  type BrowserEvent,
  type BrowserInputEvent,
  type BrowserState,
} from "@/gen/codefoundry/v1/browser_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";

export type BrowserPhaseView = "starting" | "ready" | "unavailable" | "crashed";

export interface BrowserDialogView {
  id: string;
  kind: string;
  message: string;
  defaultPrompt: string;
  origin: string;
  /** The origin's registrable domain, which has to stay readable. */
  site: string;
}

export interface BrowserFileChooserView {
  id: string;
  multiple: boolean;
  origin: string;
  /** The origin's registrable domain, which has to stay readable. */
  site: string;
}

export interface BrowserSelectView {
  id: string;
  options: readonly { label: string; disabled: boolean }[];
  selected: number;
  /** Where the control sits in the page, CSS pixels. */
  x: number;
  y: number;
  width: number;
}

export interface BrowserDownloadView {
  id: string;
  name: string;
  /** asking, inProgress, completed, canceled or blocked. */
  state: string;
  /** Who asked for it; empty when nothing says. */
  site: string;
}

/** How a page arrived: "" is fine or no page, else the bar says so. */
export type BrowserSecurityView = "" | "insecure" | "cert";

export interface BrowserStateView {
  phase: BrowserPhaseView;
  message: string;
  url: string;
  /** The domain url is registered under: the part the bar keeps visible. */
  site: string;
  security: BrowserSecurityView;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  popup: boolean;
  dialog: BrowserDialogView | null;
  fileChooser: BrowserFileChooserView | null;
  select: BrowserSelectView | null;
  notice: string;
  downloads: readonly BrowserDownloadView[];
  /** Refused downloads the list had no room for. */
  downloadsBlocked: number;
  /** Goes up when a click left new text on Chrome's own clipboard. */
  copied: number;
}

/** What a surface shows before its first state arrives. */
export const BROWSER_STARTING: BrowserStateView = {
  phase: "starting",
  message: "",
  url: "",
  site: "",
  security: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  popup: false,
  dialog: null,
  fileChooser: null,
  select: null,
  notice: "",
  downloads: [],
  downloadsBlocked: 0,
  copied: 0,
};

export interface BrowserFrameView {
  jpeg: Uint8Array;
  /** The page's size in CSS pixels. */
  width: number;
  height: number;
}

export type BrowserEventView = { kind: "state"; state: BrowserStateView } | { kind: "frame"; frame: BrowserFrameView };

const phases: Record<BrowserPhase, BrowserPhaseView> = {
  [BrowserPhase.UNSPECIFIED]: "starting",
  [BrowserPhase.STARTING]: "starting",
  [BrowserPhase.READY]: "ready",
  [BrowserPhase.UNAVAILABLE]: "unavailable",
  [BrowserPhase.CRASHED]: "crashed",
};

function toSecurity(s: string): BrowserSecurityView {
  return s === "insecure" || s === "cert" ? s : "";
}

export function toBrowserState(s: BrowserState): BrowserStateView {
  return {
    phase: phases[s.phase],
    message: s.message,
    url: s.url,
    site: s.site,
    security: toSecurity(s.security),
    title: s.title,
    loading: s.loading,
    canGoBack: s.canGoBack,
    canGoForward: s.canGoForward,
    popup: s.popup,
    dialog: s.dialog ? { id: s.dialog.id, kind: s.dialog.kind, message: s.dialog.message, defaultPrompt: s.dialog.defaultPrompt, origin: s.dialog.origin, site: s.dialog.site } : null,
    fileChooser: s.fileChooser ? { id: s.fileChooser.id, multiple: s.fileChooser.multiple, origin: s.fileChooser.origin, site: s.fileChooser.site } : null,
    select: s.select
      ? {
          id: s.select.id,
          options: s.select.options.map((o) => ({ label: o.label, disabled: o.disabled })),
          selected: s.select.selected,
          x: s.select.x,
          y: s.select.y,
          width: s.select.width,
        }
      : null,
    notice: s.notice,
    downloads: s.downloads.map((d) => ({ id: d.id, name: d.name, state: d.state, site: d.site })),
    downloadsBlocked: s.downloadsBlocked,
    copied: Number(s.copied),
  };
}

export function toBrowserEvent(ev: BrowserEvent): BrowserEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "state":
      return { kind: "state", state: toBrowserState(e.value) };
    case "frame":
      return { kind: "frame", frame: { jpeg: e.value.jpeg, width: e.value.width, height: e.value.height } };
    default:
      return null;
  }
}

export async function* watchBrowser(
  req: { surface: string; width: number; height: number; url: string },
  signal: AbortSignal,
  conn: DaemonConnection = daemon,
): AsyncGenerator<BrowserEventView | Heartbeat> {
  const c = await conn.client(BrowserService);
  for await (const ev of c.watch(req, { signal })) {
    if (ev.event.case === "heartbeat") {
      yield HEARTBEAT;
      continue;
    }
    const v = toBrowserEvent(ev);
    if (v) yield v;
  }
}

/** A mouse or wheel event in CSS pixels of the page. */
export interface BrowserMouseView {
  kind: "mouse";
  type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
  button: "none" | "left" | "middle" | "right" | "back" | "forward";
  x: number;
  y: number;
  buttons: number;
  clickCount: number;
  modifiers: number;
  deltaX: number;
  deltaY: number;
}

export interface BrowserKeyView {
  kind: "key";
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  text: string;
  keyCode: number;
  modifiers: number;
  location: number;
  autoRepeat: boolean;
}

export interface BrowserTextView {
  kind: "text";
  text: string;
}

export type BrowserInputView = BrowserMouseView | BrowserKeyView | BrowserTextView;

function toInput(e: BrowserInputView): BrowserInputEvent {
  switch (e.kind) {
    case "mouse": {
      const { kind: _kind, ...value } = e;
      return create(BrowserInputEventSchema, { event: { case: "mouse", value: create(BrowserMouseEventSchema, value) } });
    }
    case "key": {
      const { kind: _kind, ...value } = e;
      return create(BrowserInputEventSchema, { event: { case: "key", value: create(BrowserKeyEventSchema, value) } });
    }
    case "text":
      return create(BrowserInputEventSchema, { event: { case: "text", value: e.text } });
  }
}

export async function sendBrowserInput(surface: string, events: readonly BrowserInputView[], conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.input({ surface, events: events.map(toInput) });
}

export async function navigateBrowser(surface: string, url: string, conn: DaemonConnection = daemon): Promise<string> {
  const c = await conn.client(BrowserService);
  return (await c.navigate({ surface, url })).url;
}

export async function browserGo(surface: string, delta: -1 | 1, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.go({ surface, delta });
}

export async function reloadBrowser(surface: string, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.reload({ surface });
}

export async function resizeBrowser(surface: string, width: number, height: number, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.resize({ surface, width, height });
}

export async function answerBrowserDialog(surface: string, id: string, accept: boolean, text: string, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.answer({ surface, id, answer: { case: "dialog", value: { accept, text } } });
}

export async function answerBrowserFiles(surface: string, id: string, paths: readonly string[], conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.answer({ surface, id, answer: { case: "files", value: { paths: [...paths] } } });
}

export async function answerBrowserSelect(surface: string, id: string, option: number, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.answer({ surface, id, answer: { case: "option", value: option } });
}

/** The user's word on a download the surface asked about. */
export async function answerBrowserDownload(surface: string, id: string, allow: boolean, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.answer({ surface, id, answer: { case: "download", value: allow } });
}

export async function pasteToBrowser(surface: string, text: string, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.paste({ surface, text });
}

/**
 * Moves the user's copy to the Mac's clipboard and returns how many characters went: what the last
 * cmd+c changed, or with pageCopy what a click on the page's own Copy button left.
 */
export async function copyFromBrowser(surface: string, pageCopy = false, conn: DaemonConnection = daemon): Promise<number> {
  const c = await conn.client(BrowserService);
  return (await c.copy({ surface, pageCopy })).length;
}

export async function revealBrowserDownload(surface: string, id: string, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.reveal({ surface, id });
}

export async function relaunchBrowser(conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.relaunch({});
}

export async function closeBrowser(surface: string, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(BrowserService);
  await c.close({ surface });
}
