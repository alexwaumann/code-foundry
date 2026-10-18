import { ButtonBar } from "../parts";
import type { NodeProps } from "../registry";

/** A bar of buttons under what they act on; it wraps, each button pending on its own. */
export function ActionsNode({ data }: NodeProps<"actions">) {
  return <ButtonBar buttons={data.buttons} align={data.align} />;
}
