import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { modelList, toggleModel } from "@/lib/ember";
import { cn } from "@/lib/utils";
import { useModelChoices } from "@/stores/settings";
import type { EditorProps } from "./editor";

/**
 * ember.worker_models (docs/notes/ember-3-gui.md): one chip per model of the registry
 * (its label, "Opus 4.7"), pressed while the model is in the list; a click toggles it. The
 * last pressed chip cannot be released (Ember needs one). A model added goes to the end:
 * new workers take the list in order, round robin. Every model is shown, so there is no
 * "+ Add".
 */
export function WorkerModelsEditor({ field, value, pending, invalid, commit }: EditorProps) {
  const models = useModelChoices();
  const list = modelList(value);
  return (
    <div className="flex flex-wrap justify-end gap-1.5" role="group" aria-label={field.title} aria-invalid={invalid || undefined} data-testid="ember-worker-models">
      {models.map((m) => {
        const on = list.includes(m.value);
        const last = on && list.length === 1;
        const chip = (
          <Button
            key={m.value}
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={on}
            aria-disabled={last || undefined}
            disabled={pending}
            data-model={m.value}
            className={cn("rounded-full px-2.5 font-medium", on ? "border-info bg-info/12 text-foreground hover:bg-info/18 dark:border-info dark:bg-info/12 dark:hover:bg-info/18" : "text-muted-foreground")}
            onClick={() => {
              if (last) return;
              commit(toggleModel(list, m.value).join(","));
            }}
          >
            {on && <Check aria-hidden />}
            {m.label}
          </Button>
        );
        return last ? (
          <Tip key={m.value} label="Ember needs at least one worker model">
            {chip}
          </Tip>
        ) : (
          chip
        );
      })}
    </div>
  );
}
