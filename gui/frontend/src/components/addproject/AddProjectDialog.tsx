import { CloudDownload, FolderOpen, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { closeAddProject, setAddProjectTab, useAddProjectStore, type AddProjectTab } from "@/stores/addProject";
import { GitHubTab } from "./GitHubTab";
import { LocalFolderTab } from "./LocalFolderTab";

/** New: starting a project from a name lands in a later change (repo.create). */
function NewTab() {
  return (
    <div className="flex flex-col gap-3" data-testid="add-project-new">
      <p className="text-xs text-muted-foreground">Start an empty project in ~/.code-foundry/projects with git initialized, and optionally publish it to GitHub.</p>
      <input
        disabled
        placeholder="Project name"
        aria-label="Project name"
        className="h-9 rounded-md border bg-transparent px-3 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground" data-testid="add-project-new-soon">
          Coming soon
        </span>
        <Button type="button" size="sm" disabled>
          Create project
        </Button>
      </div>
    </div>
  );
}

const tabs: { id: AddProjectTab; label: string; icon: typeof Sparkles }[] = [
  { id: "new", label: "New", icon: Sparkles },
  { id: "local", label: "Local folder", icon: FolderOpen },
  { id: "github", label: "GitHub", icon: CloudDownload },
];

/**
 * The Add Project dialog (repo.add's presenter): New, Local folder, GitHub. Each opening
 * starts fresh; closing it cancels a clone in flight.
 */
export function AddProjectDialog() {
  const open = useAddProjectStore((s) => s.open);
  const tab = useAddProjectStore((s) => s.tab);
  const seq = useAddProjectStore((s) => s.seq);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeAddProject();
      }}
    >
      <DialogContent className="max-w-xl p-4" data-testid="add-project-dialog" data-tab={tab}>
        <DialogTitle>Add Project</DialogTitle>
        <DialogDescription className="sr-only">Start a new project, add a folder on this Mac, or clone a repository from GitHub.</DialogDescription>
        <Tabs
          key={seq}
          value={tab}
          onValueChange={(v) => {
            setAddProjectTab(v as AddProjectTab);
          }}
          className="mt-3 gap-4"
        >
          <TabsList className="w-full" data-testid="add-project-tabs">
            {tabs.map(({ id, label, icon: Icon }) => (
              <TabsTrigger key={id} value={id} data-testid={`add-project-tab-${id}`}>
                <Icon aria-hidden />
                {label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="new">
            <NewTab />
          </TabsContent>
          <TabsContent value="local">
            <LocalFolderTab />
          </TabsContent>
          {/* Kept mounted when hidden, so switching tabs does not cancel a clone. */}
          <TabsContent value="github" forceMount className="data-[state=inactive]:hidden">
            <GitHubTab active={tab === "github"} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
