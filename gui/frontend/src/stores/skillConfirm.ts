/**
 * The Skills page's confirms (docs/notes/skills-4-gui.md). skill.disable, skill.uninstall
 * and skill.remove confirm in the daemon (Confirm, --yes on the CLI). From Settings → Skills
 * the user has answered already, in the page's dialog with the restart warning: that call
 * is not asked twice. From the palette it gets the generic confirm with the daemon's words.
 * The plugin page does the same for plugin.uninstall (stores/pluginRegistry.ts).
 */
import { skillCommandName } from "@/api/skill";
import { registerConfirmPresenter, requestConfirm, type ConfirmRequest } from "./confirm";
import { disableSkill, removeLocalSkill, uninstallSkill, type SkillItemRef } from "./skill";

/** The actions that confirm. */
export type ConfirmedSkillAction = "disable" | "uninstall" | "remove";

const preconfirmed = new Set<string>();

function key(command: string, name: string): string {
  return `${command}\u0000${name}`;
}

/** The name argument each command is called with (stores/skill.ts: a plugin's name@marketplace; remove the bare name). */
function nameArg(action: ConfirmedSkillAction, item: SkillItemRef): string {
  return action === "remove" ? item.name : skillCommandName(item.kind, item.name, item.registry);
}

const run: Record<ConfirmedSkillAction, (item: SkillItemRef) => Promise<boolean>> = {
  disable: disableSkill,
  uninstall: uninstallSkill,
  remove: removeLocalSkill,
};

/** Runs an action the user confirmed in the page's dialog: the daemon's confirm for that call is answered yes. */
export async function runConfirmedSkill(action: ConfirmedSkillAction, item: SkillItemRef): Promise<boolean> {
  const k = key(`skill.${action}`, nameArg(action, item));
  preconfirmed.add(k);
  try {
    return await run[action](item);
  } finally {
    preconfirmed.delete(k);
  }
}

for (const action of ["disable", "uninstall", "remove"] as const) {
  const command = `skill.${action}`;
  registerConfirmPresenter(command, (req: ConfirmRequest) => (preconfirmed.has(key(command, req.args?.name ?? "")) ? Promise.resolve(true) : requestConfirm(req)));
}
