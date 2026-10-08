import { create } from "@bufbuild/protobuf";
import {
  ArgType,
  CommandService,
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
}

/** What the user is looking at. Mirrors codefoundry.v1.UiContext; empty string = none. */
export interface UiContextView {
  activeTerminalId: string;
  activeSessionId: string;
  activeRepoId: string;
  activeWorktreePath: string;
  activeView: string;
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
  };
}

export function toUiContext(ctx: UiContextView): UiContext {
  return create(UiContextSchema, ctx);
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
): Promise<InvokeResultView> {
  const c = await conn.client(CommandService);
  const res = await c.invoke({ name, context: toUiContext(ctx), args });
  return { message: res.message, resultJson: res.resultJson };
}
