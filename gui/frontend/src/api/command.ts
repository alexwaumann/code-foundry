import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  ArgType,
  CommandService,
  ConfirmationRequiredSchema,
  UiContextSchema,
  type ArgSpec,
  type Command,
  type UiContext,
} from "@/gen/codefoundry/v1/command_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type ArgTypeView = "string" | "bool" | "int" | "enum" | "path";

export interface ArgSpecView {
  name: string;
  type: ArgTypeView;
  required: boolean;
  description: string;
  enumValues: string[];
  defaultValue: string;
}

export interface CommandView {
  name: string;
  title: string;
  description: string;
  category: string;
  args: ArgSpecView[];
  keybindings: string[];
  available: boolean;
  /** Invoke asks for confirmation first (FailedPrecondition + ConfirmationRequired). */
  requiresConfirmation?: boolean;
}

/** A destructive command waiting for the user's yes (ConfirmationRequired detail). */
export interface ConfirmationView {
  command: string;
  title: string;
  message: string;
  /**
   * A second-stage confirmation's args (deleting uncommitted work: { force: "true" }):
   * on yes, invoke again with them merged over the original args. Absent on a
   * command's own (first) confirmation.
   */
  args?: Record<string, string>;
  /**
   * Args a command's own confirmation binds the yes to (plugin consent: the digest of
   * the text shown): on yes, invoke again with them merged. Not a second stage, so the
   * command's own presenter still asks.
   */
  bind?: Record<string, string>;
  /** What the command already did, the result when the user declines a second stage. */
  declined?: InvokeResultView;
  /** The confirm button's words when the command names them ("Forget all"). */
  confirmLabel?: string;
}

/**
 * The confirm button's words: the command's own (ConfirmationView.confirmLabel), else
 * its title without a "Category: " prefix ("Ember: Cancel Task" → "Cancel Task").
 */
export function confirmButtonLabel(title: string, confirmLabel?: string): string {
  if (confirmLabel) return confirmLabel;
  const i = title.indexOf(": ");
  return i > 0 && i + 2 < title.length ? title.slice(i + 2) : title;
}

/** What the user is looking at. Mirrors codefoundry.v1.UiContext; empty string = none. */
export interface UiContextView {
  activeTerminalId: string;
  activeThreadId: string;
  activeProjectId: string;
  activeWorktreePath: string;
  activeView: string;
  /** The workspace that owns the active thread (or the composer's workspace); "" otherwise. */
  activeWorkspaceId: string;
}

export interface InvokeResultView {
  message: string;
  resultJson: string;
}

const argTypeMap: Record<ArgType, ArgTypeView> = {
  [ArgType.UNSPECIFIED]: "string",
  [ArgType.STRING]: "string",
  [ArgType.BOOL]: "bool",
  [ArgType.INT]: "int",
  [ArgType.ENUM]: "enum",
  [ArgType.PATH]: "path",
};

export function toArgSpecView(a: ArgSpec): ArgSpecView {
  return {
    name: a.name,
    type: argTypeMap[a.type],
    required: a.required,
    description: a.description,
    enumValues: [...a.enumValues],
    defaultValue: a.defaultValue,
  };
}

export function toCommandView(c: Command): CommandView {
  return {
    name: c.name,
    title: c.title || c.name,
    description: c.description,
    category: c.category || "General",
    args: c.args.map(toArgSpecView),
    keybindings: [...c.keybindings],
    available: c.available,
    requiresConfirmation: c.requiresConfirmation,
  };
}

/** The confirmation an Invoke error asks for, or null for any other error. */
export function confirmationOf(err: unknown): ConfirmationView | null {
  if (!(err instanceof ConnectError)) return null;
  const [d] = err.findDetails(ConfirmationRequiredSchema);
  if (!d) return null;
  const view: ConfirmationView = { command: d.command, title: d.title, message: d.message };
  if (Object.keys(d.args).length > 0) view.args = { ...d.args };
  if (Object.keys(d.bind).length > 0) view.bind = { ...d.bind };
  if (d.declined) view.declined = { message: d.declined.message, resultJson: d.declined.resultJson };
  if (d.confirmLabel) view.confirmLabel = d.confirmLabel;
  return view;
}

/** Invoke failed because the daemon has no such command (an older daemon): NotFound. */
export function isUnknownCommand(err: unknown): boolean {
  return err instanceof ConnectError && err.code === Code.NotFound;
}

export function toUiContext(ctx: UiContextView): UiContext {
  // Field by field: the view model's names need not be the proto's (activeProjectId).
  return create(UiContextSchema, {
    activeTerminalId: ctx.activeTerminalId,
    activeThreadId: ctx.activeThreadId,
    activeProjectId: ctx.activeProjectId,
    activeWorktreePath: ctx.activeWorktreePath,
    activeView: ctx.activeView,
    activeWorkspaceId: ctx.activeWorkspaceId,
  });
}

export async function listCommands(
  ctx: UiContextView,
  opts: { includeUnavailable?: boolean; signal?: AbortSignal } = {},
  conn: DaemonConnection = daemon,
): Promise<CommandView[]> {
  const c = await conn.client(CommandService);
  const res = await c.list(
    { context: toUiContext(ctx), includeUnavailable: opts.includeUnavailable ?? false },
    { signal: opts.signal },
  );
  return res.commands.map(toCommandView);
}

export async function invokeCommand(
  name: string,
  ctx: UiContextView,
  args: Record<string, string>,
  conn: DaemonConnection = daemon,
  opts: { confirmed?: boolean } = {},
): Promise<InvokeResultView> {
  const c = await conn.client(CommandService);
  const res = await c.invoke({ name, context: toUiContext(ctx), args, confirmed: opts.confirmed ?? false });
  return { message: res.message, resultJson: res.resultJson };
}
