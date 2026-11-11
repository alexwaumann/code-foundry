/**
 * file.export (internal/command/commands_file_export.go): a page's file saved into its
 * thread's checkout, with the daemon's refusals. The daemon's rules are tested in Go; this
 * keeps the mock's answers the same for e2e. Symlinks are not modelled.
 */
import { ArgType, CallOrigin, type UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { CommandError } from "./errors";
import { HOME } from "./filesystem";

/** The daemon's MaxExportBytes: the bridge's cap on a call. */
const MAX_EXPORT_BYTES = 256 * 1024;

/** The mock's disk, as file.export reaches it (mock/files.ts MockFiles). */
export interface ExportDisk {
  textOf(abs: string): string | null;
  write(abs: string, text: string): void;
  hasFolder(abs: string): boolean;
}

/** The daemon's byteSize. */
function byteSize(n: number): string {
  if (n < 1024) return n === 1 ? "1 byte" : `${String(n)} bytes`;
  return `${(n / 1024).toFixed(1)} KiB`;
}

/** The daemon's exportPath: relative, inside the checkout as spelled, no name starting with a dot. */
function exportPath(p: string): string {
  if (p.trim() === "") throw new CommandError("invalid", "file.export: path: needs a file name");
  if (p.startsWith("/") || p.startsWith("~")) throw new CommandError("invalid", `file.export: path: ${JSON.stringify(p)} is not relative: give a file name, or a path inside the thread's checkout`);
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg !== "..") out.push(seg);
    else if (out.pop() === undefined) throw new CommandError("invalid", `file.export: path: ${JSON.stringify(p)} leads outside the thread's checkout`);
  }
  if (out.length === 0) throw new CommandError("invalid", `file.export: path: ${JSON.stringify(p)} leads outside the thread's checkout`);
  if (out.some((seg) => seg.startsWith("."))) throw new CommandError("invalid", `file.export: path: ${JSON.stringify(p)} has a name starting with a dot, where programs keep their settings: choose another name`);
  return out.join("/");
}

/** The daemon's exportContents: text or base64, exactly one, within the cap. */
function exportContents(args: Record<string, string>): string {
  const text = args.text;
  const enc = args.base64;
  if (text !== undefined && enc !== undefined) throw new CommandError("invalid", "file.export: base64: pass the contents once: --text or --base64");
  let out: string;
  let bytes: number;
  if (text !== undefined) {
    out = text;
    bytes = new TextEncoder().encode(text).length;
  } else if (enc !== undefined) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(enc) || enc.length % 4 !== 0) throw new CommandError("invalid", "file.export: base64: is not base64");
    out = Buffer.from(enc, "base64").toString("latin1");
    bytes = out.length;
  } else throw new CommandError("invalid", "file.export: text: needs the contents: --text, or --base64 for bytes");
  if (bytes > MAX_EXPORT_BYTES) throw new CommandError("invalid", `file.export: text: the contents are ${byteSize(bytes)}, at most ${byteSize(MAX_EXPORT_BYTES)}`);
  return out;
}

export function fileExportCommands(cwdOf: (threadId: string) => string | undefined, disk: () => ExportDisk | null) {
  /** The call checked: where it goes, what is there, and what it writes. */
  const plan = (ctx: UiContext | undefined, args: Record<string, string>) => {
    const contents = exportContents(args);
    const rel = exportPath(args.path ?? "");
    const id = args.thread || ctx?.activeThreadId || "";
    if (!id) throw new CommandError("invalid", "file.export: thread: needs a thread whose checkout to save in (--thread, or run it inside a thread)");
    const cwd = cwdOf(id);
    if (cwd === undefined) throw new CommandError("notfound", `no thread ${id}`);
    if (!cwd) throw new CommandError("unavailable", `thread ${id} has no checkout yet`);
    const abs = `${cwd}/${rel}`;
    if (abs.startsWith(`${HOME}/Library/`)) throw new CommandError("invalid", `file.export: path: ${abs} is in a protected folder (Code Foundry's own data, credentials or ~/Library)`);
    const d = disk();
    if (!d) throw new CommandError("unavailable", "no file exports here");
    const dir = abs.slice(0, abs.lastIndexOf("/"));
    if (!d.hasFolder(dir)) throw new CommandError("invalid", `file.export: path: the directory of ${rel} does not exist`);
    if (d.hasFolder(abs)) throw new CommandError("invalid", `file.export: path: ${rel} is a directory`);
    const was = d.textOf(abs);
    return { abs, contents, was, disk: d };
  };
  return [
    {
      cmd: {
        name: "file.export",
        title: "Export File",
        category: "View",
        description: "Save a file into a thread's checkout (its working directory): for a page's Export button, since a page cannot download.",
        keybindings: [],
        noPalette: true,
        args: [
          { name: "path", type: ArgType.STRING, required: true, positional: true, description: "A file name, or a path relative to the checkout that stays inside it" },
          { name: "text", type: ArgType.STRING, required: false, description: "The contents, as text" },
          { name: "base64", type: ArgType.STRING, required: false, description: "The contents, as base64, for a file that is not text" },
          { name: "thread", type: ArgType.STRING, required: false, description: "Thread whose checkout it goes in" },
        ],
        // A page asks first (PageRuns); a file already there asks to be replaced, from anyone.
        confirm: (ctx: UiContext | undefined, args: Record<string, string>) => {
          const p = plan(ctx, args);
          if (p.was !== null) return `Replace ${p.abs}? A file is there already (${byteSize(p.was.length)}); it becomes ${byteSize(p.contents.length)}.`;
          const call = [`file.export --path ${JSON.stringify(args.path ?? "")}`];
          for (const k of ["text", "base64"]) if (args[k] !== undefined) call.push(`--${k} <${byteSize(args[k].length)}>`);
          return `Run this?\n${call.join(" ")}\nSaves ${byteSize(p.contents.length)} to ${p.abs}`;
        },
        confirmIf: (ctx: UiContext | undefined, args: Record<string, string>) => plan(ctx, args).was !== null || ctx?.origin === CallOrigin.PAGE,
        confirmLabel: (ctx: UiContext | undefined, args: Record<string, string>) => (plan(ctx, args).was !== null ? "Replace" : "Allow"),
      },
      when: (ctx: UiContext | undefined) => Boolean(ctx?.activeThreadId),
      run: (ctx: UiContext | undefined, args: Record<string, string>) => {
        const p = plan(ctx, args);
        p.disk.write(p.abs, p.contents);
        const replaced = p.was !== null;
        return Promise.resolve({
          message: `${replaced ? "replaced" : "saved"} ${p.abs} (${byteSize(p.contents.length)})`,
          resultJson: JSON.stringify({ path: p.abs, size: p.contents.length, ...(replaced ? { replaced: true } : {}) }),
        });
      },
    },
  ];
}
