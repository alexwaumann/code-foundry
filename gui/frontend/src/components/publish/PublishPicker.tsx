import { Building2, Check, ChevronDown, Globe, Loader2, Lock, User, Users } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { keepVisibility, visibilityLabels, visibilityOptions, type Visibility } from "@/lib/publish";
import type { OwnersState, PublishChoice } from "./usePublishOwners";

const visibilityIcons: Record<Visibility, typeof Globe> = { public: Globe, internal: Users, private: Lock };

const visibilityHints: Record<Visibility, string> = {
  public: "Anyone on the internet can see it.",
  internal: "Members of the organization's enterprise can see it.",
  private: "Only people you give access can see it.",
};

/**
 * Owner and visibility for a GitHub repository (shared by the New tab and the publish
 * dialog). Only the visibilities an owner allows are offered when GitHub tells us its
 * policy; all three, with a hint, when it does not (only org owners see it). error is
 * gh's refusal, shown verbatim under the picker.
 */
export function PublishPicker({
  owners,
  value,
  onChange,
  disabled = false,
  error = null,
}: {
  owners: OwnersState;
  value: PublishChoice;
  onChange: (next: PublishChoice) => void;
  disabled?: boolean;
  error?: string | null;
}) {
  if (owners.state === "loading") {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="publish-owners-loading">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Asking GitHub where you can publish…
      </p>
    );
  }
  if (owners.state === "error") {
    return (
      <p className="text-xs whitespace-pre-wrap text-destructive" role="alert" data-testid="publish-owners-error">
        Cannot list your GitHub accounts: {owners.message}
      </p>
    );
  }
  const owner = owners.owners.find((o) => o.login === value.owner);
  const options = visibilityOptions(owner);
  return (
    <div className="flex flex-col gap-2" data-testid="publish-picker">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-xs text-muted-foreground">Owner</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <Button type="button" variant="outline" size="sm" className="min-w-40 justify-between" data-testid="publish-owner" data-owner={value.owner}>
              <span className="flex items-center gap-1.5 truncate">
                {owner?.kind === "org" ? <Building2 aria-hidden /> : <User aria-hidden />}
                {value.owner || "Choose an owner"}
              </span>
              <ChevronDown className="opacity-50" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-48" data-testid="publish-owner-menu">
            {owners.owners.map((o) => (
              <DropdownMenuItem
                key={o.login}
                data-testid="publish-owner-option"
                data-login={o.login}
                onSelect={() => {
                  onChange({ owner: o.login, visibility: keepVisibility(value.visibility, o) });
                }}
              >
                {o.kind === "org" ? <Building2 aria-hidden /> : <User aria-hidden />}
                <span className="truncate">{o.login}</span>
                <span className="ml-auto text-xs text-muted-foreground">{o.kind === "org" ? "organization" : "you"}</span>
                {o.login === value.owner && <Check className="size-3.5" aria-hidden />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-16 text-xs text-muted-foreground" id="publish-visibility-label">
          Visibility
        </span>
        {options.length === 0 ? (
          <span className="text-xs text-destructive" data-testid="publish-visibility-none">
            {value.owner} does not let members create repositories.
          </span>
        ) : (
          <RadioGroupPrimitive.Root
            className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px]"
            aria-labelledby="publish-visibility-label"
            value={value.visibility ?? ""}
            disabled={disabled}
            onValueChange={(v) => {
              onChange({ ...value, visibility: v as Visibility });
            }}
            data-testid="publish-visibility"
            data-value={value.visibility ?? ""}
          >
            {options.map((v) => {
              const Icon = visibilityIcons[v];
              return (
                <RadioGroupPrimitive.Item
                  key={v}
                  value={v}
                  title={visibilityHints[v]}
                  className="inline-flex h-full items-center gap-1.5 rounded-md border border-transparent px-2.5 text-xs font-medium text-foreground/70 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50 data-[state=checked]:bg-background data-[state=checked]:text-foreground data-[state=checked]:shadow-sm dark:data-[state=checked]:border-input dark:data-[state=checked]:bg-input/30 [&_svg]:size-3.5"
                  data-testid={`publish-visibility-${v}`}
                >
                  <Icon aria-hidden />
                  {visibilityLabels[v]}
                </RadioGroupPrimitive.Item>
              );
            })}
          </RadioGroupPrimitive.Root>
        )}
      </div>
      {owner && !owner.known && (
        <p className="text-xs text-muted-foreground" data-testid="publish-visibility-hint">
          GitHub does not show {owner.login}'s repository policy to members, so every visibility is offered. If it does not allow the one you pick, GitHub refuses
          and you can pick another.
        </p>
      )}
      {error && (
        <p className="text-xs whitespace-pre-wrap text-destructive" role="alert" data-testid="publish-error">
          {error}
        </p>
      )}
    </div>
  );
}
