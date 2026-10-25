/**
 * The Add Project dialog's folder-of-repos choice (docs/notes/workspaces-v2-6-scan.md): the
 * lines around its two buttons.
 */

/** The line beside "Add as workspace": what happens to the n repositories inside. */
export function workspaceChoiceLine(n: number): string {
  return n === 1
    ? "The 1 repo inside becomes a project; this folder is its root for instructions and skills."
    : `The ${String(n)} repos inside become projects; this folder is their shared root for instructions and skills.`;
}

/** The line beside "Add as project". */
export const projectChoiceLine = "One folder. No git features for the repos inside.";

/** The rest of the line above the choices, after the folder: how many repositories are inside. */
export function folderChoiceHeading(n: number): string {
  return n === 1 ? "has a git repository inside." : `has ${String(n)} git repositories inside.`;
}
