import { useShallow } from "zustand/react/shallow";
import { projectRenameError } from "@/lib/projectName";
import { renameProject } from "@/stores/projectRename";
import { useProjectsStore } from "@/stores/projects";
import { NameEditor } from "./NameEditor";

/**
 * A project's name edited in place (project.rename): the project page header's, opened by its ⋯ Rename or by
 * startProjectRename from anywhere (stores/projectRename.ts). Names are unique among projects whatever their case.
 */
export function ProjectNameEditor({ projectId, name, onDone }: { projectId: string; name: string; onDone: () => void }) {
  const ids = useProjectsStore(useShallow((s) => s.order.filter((x) => x !== projectId)));
  const names = useProjectsStore(useShallow((s) => s.order.filter((x) => x !== projectId).map((x) => s.byId[x]?.name ?? "")));
  return (
    <NameEditor
      name={name}
      validate={(v) => projectRenameError(v, ids.map((id, i) => ({ id, name: names[i] ?? "" })))}
      onRename={(v) => void renameProject(projectId, v)}
      onDone={onDone}
      label="Project name"
      testId="project-name"
    />
  );
}
