import { useState, type SyntheticEvent, type KeyboardEvent, type ReactNode } from "react";
import type { Field, FieldValue, FormNodeData, SelectOption } from "@/api/plugin";
import { ChevronDown } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { actOnElement, clearDrafts, draftKeyOf, revertDraft, runCommandElement, setDraft, usePending, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { FormContext, useFormCtx, useViewCtx } from "../context";
import { fieldValue, formValues, isSecret, pluginValue, validateField, validateForm, valueString } from "../form";
import { useSourceOptions } from "../options";
import { InlineView, PluginButton } from "../parts";
import type { NodeProps } from "../registry";
import { useInStrip } from "../strip";

const NO_DRAFTS: Readonly<Record<string, FieldValue>> = {};

interface FieldApi {
  drafts: Readonly<Record<string, FieldValue>>;
  hostErrors: Readonly<Record<string, string>>;
  /** The user changed a field (a draft); `commit` sends its change event now (selects, toggles). */
  change: (f: Field, v: FieldValue, commit: boolean) => void;
  /** Focus left a field: check it, and send a text field's change event. */
  blur: (f: Field) => void;
  submit: () => void;
}

function Description({ f, error }: { f: Field; error: string | undefined }) {
  const strip = useInStrip() !== null;
  if (error) return <p className="text-caption-sm text-destructive" data-testid="plugin-field-error">{error}</p>;
  // A strip is one row: descriptions are left out (errors still show, under the control).
  if (f.description === undefined || strip) return null;
  return (
    <p className="text-caption-sm">
      <InlineView value={f.description} />
    </p>
  );
}

function InputControl({ f, api, id, invalid }: { f: Field; api: FieldApi; id: string; invalid: boolean }) {
  const { locked, draftKey } = useFormCtx() ?? { locked: false, draftKey: "" };
  const input = f.input ?? {};
  const secret = input.kind === "secret";
  const name = f.name ?? f.key;
  const draft = api.drafts[name];
  const value = typeof draft === "string" ? draft : secret ? "" : (input.value ?? "");
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      api.submit();
    } else if (e.key === "Escape" && draft !== undefined) {
      e.preventDefault();
      e.stopPropagation();
      revertDraft(draftKey, name);
    }
  };
  return (
    <Input
      id={id}
      type={secret ? "password" : "text"}
      value={value}
      placeholder={secret && input.hasValue ? "Saved · type to replace" : input.placeholder}
      maxLength={input.maxLength || undefined}
      disabled={f.disabled || locked}
      aria-invalid={invalid || undefined}
      aria-required={f.required || undefined}
      autoComplete={secret ? "new-password" : "off"}
      spellCheck={false}
      className={cn("h-7 text-body-sm", input.mono && "font-mono")}
      data-testid="plugin-input"
      data-name={name}
      onChange={(e) => {
        api.change(f, e.target.value, false);
      }}
      onBlur={() => {
        api.blur(f);
      }}
      onKeyDown={onKey}
    />
  );
}

function optionLabel(o: SelectOption, list: boolean, control: ReactNode) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2 text-body-sm">
        {control}
        <span className={cn("min-w-0 truncate", o.disabled && "opacity-50")}>{o.label}</span>
      </span>
      {list && o.description !== undefined && (
        <span className="pl-6 text-caption-sm">
          <InlineView value={o.description} />
        </span>
      )}
    </span>
  );
}

function SelectControl({ f, api, id, invalid }: { f: Field; api: FieldApi; id: string; invalid: boolean }) {
  const { locked } = useFormCtx() ?? { locked: false };
  const sel = f.select ?? {};
  const sourced = useSourceOptions(sel.optionsSource);
  const options = sourced ?? sel.options ?? [];
  const v = fieldValue(f, api.drafts);
  const disabled = (f.disabled ?? false) || locked;
  const multiple = sel.multiple ?? false;
  if (multiple && sel.style !== "list") {
    return <MultiDropdown f={f} api={api} id={id} invalid={invalid} options={options} disabled={disabled} />;
  }
  if (multiple) {
    const chosen = new Set(Array.isArray(v) ? v : []);
    return (
      <div className="flex min-w-0 flex-col gap-1.5" role="group" aria-labelledby={`${id}-label`} aria-required={f.required || undefined} data-testid="plugin-select" data-name={f.name} data-style="checks">
        {options.map((o) => (
          <label key={o.key} className="flex min-w-0 cursor-default items-start">
            {optionLabel(
              o,
              true,
              <Checkbox
                checked={chosen.has(o.value)}
                disabled={disabled || o.disabled}
                aria-invalid={invalid || undefined}
                onCheckedChange={(on) => {
                  const next = options.map((x) => x.value).filter((x) => (x === o.value ? on === true : chosen.has(x)));
                  api.change(f, next, true);
                }}
                data-value={o.value}
              />,
            )}
          </label>
        ))}
      </div>
    );
  }
  const current = typeof v === "string" ? v : "";
  if (sel.style === "list") {
    return (
      <RadioGroup
        value={current}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        aria-required={f.required || undefined}
        className="gap-1.5"
        onValueChange={(next) => {
          api.change(f, next, true);
        }}
        data-testid="plugin-select"
        data-name={f.name}
        data-style="radios"
      >
        {options.map((o) => (
          <label key={o.key} className="flex min-w-0 cursor-default items-start">
            {optionLabel(o, true, <RadioGroupItem value={o.value} disabled={o.disabled} aria-invalid={invalid || undefined} />)}
          </label>
        ))}
      </RadioGroup>
    );
  }
  return (
    // Always controlled: "" shows the placeholder (a reset or the plugin's empty value clears it).
    <Select
      value={current}
      disabled={disabled}
      onValueChange={(next) => {
        api.change(f, next, true);
      }}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className="w-full text-body-sm"
        aria-invalid={invalid || undefined}
        aria-required={f.required || undefined}
        data-testid="plugin-select"
        data-name={f.name}
        data-style="dropdown"
      >
        <SelectValue placeholder={sel.placeholder || "Choose…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.key} value={o.value} disabled={o.disabled}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * A multiple select in the dropdown style: a trigger like the single dropdown's (the
 * placeholder while nothing is chosen, else the chosen labels) over a popover checklist.
 * Each check is a change at once, like the list style's.
 */
function MultiDropdown({ f, api, id, invalid, options, disabled }: { f: Field; api: FieldApi; id: string; invalid: boolean; options: readonly SelectOption[]; disabled: boolean }) {
  const v = fieldValue(f, api.drafts);
  const chosen = new Set(Array.isArray(v) ? v : []);
  const labels = options.filter((o) => chosen.has(o.value)).map((o) => o.label);
  const summary = labels.join(", ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-required={f.required || undefined}
          className={cn(
            "flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-2.5 py-1 text-body-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:ring-destructive/40",
            labels.length === 0 && "text-muted-foreground",
          )}
          data-testid="plugin-select"
          data-name={f.name}
          data-style="multi-dropdown"
        >
          <span className="min-w-0 truncate">{labels.length === 0 ? f.select?.placeholder || "Choose…" : summary}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {labels.length > 1 && <span className="text-caption-sm tabular-nums">{labels.length}</span>}
            <ChevronDown className="size-4 text-muted-foreground opacity-50" aria-hidden />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[calc(var(--radix-popover-trigger-width)/var(--cf-zoom))] p-1" data-testid="plugin-select-options">
        <div role="group" aria-label={f.label || f.name} className="flex max-h-64 flex-col overflow-y-auto">
          {options.map((o) => (
            <label key={o.key} className={cn("flex min-w-0 cursor-default items-center rounded-sm px-2 py-1.5 hover:bg-accent dark:hover:bg-accent/50", o.disabled && "pointer-events-none")}>
              {optionLabel(
                o,
                false,
                <Checkbox
                  checked={chosen.has(o.value)}
                  disabled={o.disabled}
                  onCheckedChange={(on) => {
                    const next = options.map((x) => x.value).filter((x) => (x === o.value ? on === true : chosen.has(x)));
                    api.change(f, next, true);
                  }}
                  data-value={o.value}
                />,
              )}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The label's mark for a required field, from the first paint (the host checks it on blur and submit). */
function RequiredMark() {
  return (
    <span className="text-muted-foreground" aria-hidden data-testid="plugin-required">
      *
    </span>
  );
}

function FieldView({ f, api }: { f: Field; api: FieldApi }) {
  const { draftKey, locked } = useFormCtx() ?? { draftKey: "", locked: false };
  const strip = useInStrip() !== null;
  const id = `${draftKey}-${f.key}`.replace(/[^A-Za-z0-9_-]/g, "_");
  const name = f.name ?? "";
  const error = api.hostErrors[name] ?? f.error;
  const invalid = Boolean(error);
  if (f.fieldset) {
    const fs = f.fieldset;
    return (
      <fieldset className="flex min-w-0 flex-col gap-2" data-testid="plugin-fieldset" data-key={f.key}>
        {fs.label && <legend className="mb-1 text-overline">{fs.label}</legend>}
        {fs.hint !== undefined && !fs.error && (
          <p className="-mt-1 text-caption-sm">
            <InlineView value={fs.hint} />
          </p>
        )}
        {fs.fields.map((c) => (
          <FieldView key={c.key} f={c} api={api} />
        ))}
        {fs.error && <p className="text-caption-sm text-destructive">{fs.error}</p>}
      </fieldset>
    );
  }
  if (f.toggle) {
    const v = fieldValue(f, api.drafts);
    return (
      <div className={cn("flex min-w-0 flex-col gap-1", strip && "shrink-0")} data-testid="plugin-field" data-name={name}>
        <div className={cn("flex min-w-0 items-center", strip ? "gap-2" : "gap-3")}>
          <Label htmlFor={id} className={cn("min-w-0 text-body-sm font-normal", strip ? "whitespace-nowrap" : "flex-1")}>
            {f.label}
          </Label>
          <Switch
            id={id}
            checked={v === true}
            disabled={f.disabled || locked}
            onCheckedChange={(on) => {
              api.change(f, on, true);
            }}
            data-testid="plugin-toggle"
            data-name={name}
          />
        </div>
        <Description f={f} error={error} />
      </div>
    );
  }
  return (
    // In a strip the control is the field (a search box): its label names it for screen readers only.
    <div className={cn("flex min-w-0 flex-col gap-1.5", strip && (f.input ? "min-w-32 flex-[2_1_0%]" : "min-w-28 flex-1"))} data-testid="plugin-field" data-name={name}>
      {f.label && (
        <Label id={`${id}-label`} htmlFor={id} className={cn("gap-1 text-body-sm font-medium", strip && "sr-only")}>
          {f.label}
          {f.required && <RequiredMark />}
        </Label>
      )}
      {f.input ? <InputControl f={f} api={api} id={id} invalid={invalid} /> : f.select ? <SelectControl f={f} api={api} id={id} invalid={invalid} /> : null}
      <Description f={f} error={error} />
    </div>
  );
}

/**
 * The one way values travel to the plugin (PRIMITIVES.md §A "form"). Values are host
 * drafts per instance, view tab and form until a submit the plugin takes is followed by a
 * view without errors for the form (a new resetToken drops them too); a pristine field
 * shows the plugin's value. Required fields carry a muted asterisk from the start. The host checks
 * required, max length and pattern on blur and on submit; the plugin's own errors come back
 * in its next view. From submit until the plugin answers (and while `busy`) the whole
 * form is disabled and the submit spins. Enter in a text field submits; Escape reverts it.
 * In a toolbar or footer (strip.ts) the same form lays its fields and buttons out in one
 * row that wraps: inputs and selects without visible labels or descriptions, toggles with
 * their label beside the switch.
 */
export function FormNode({ node, data }: NodeProps<"form">) {
  const { watchKey, instance, viewTab, uiContext, inert } = useViewCtx();
  const strip = useInStrip() !== null;
  const draftKey = draftKeyOf(instance, viewTab, node.key);
  const drafts = usePluginSurfacesStore((s) => s.drafts[draftKey]) ?? NO_DRAFTS;
  const [hostErrors, setHostErrors] = useState<Record<string, string>>({});
  const submitKey = data.submit?.key ?? "";
  const submitting = usePending(watchKey, submitKey);
  const locked = submitting || (data.busy ?? false) || inert;

  const send = async (form: FormNodeData) => {
    const submit = form.submit;
    if (!submit?.action || locked) return;
    const now = usePluginSurfacesStore.getState().drafts[draftKey];
    const errors = validateForm(form, now);
    setHostErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (submit.action.event) {
      await actOnElement(watchKey, submit.key, { values: formValues(form, now, true), submitOf: draftKey });
    } else if (submit.action.command) {
      // A form with a secret never submits through a command (the daemon refuses the view).
      const args: Record<string, string> = { ...submit.action.command.args };
      for (const [k, v] of Object.entries(formValues(form, now, false))) args[k] = valueString(v);
      if (await runCommandElement(watchKey, submit.key, submit.action.command.name, args, uiContext)) clearDrafts(draftKey);
    }
  };

  const api: FieldApi = {
    drafts,
    hostErrors,
    change: (f, v, commit) => {
      const name = f.name ?? "";
      if (!name) return;
      setDraft(draftKey, name, v);
      if (hostErrors[name]) {
        setHostErrors((e) => {
          const { [name]: _gone, ...rest } = e;
          return rest;
        });
      }
      if (commit && f.change?.event && !isSecret(f)) {
        const values = formValues(data, { ...drafts, [name]: v }, false);
        void actOnElement(watchKey, f.key, { value: valueString(v), values });
      }
    },
    blur: (f) => {
      const name = f.name ?? "";
      if (!name) return;
      const v = isSecret(f) ? drafts[name] : fieldValue(f, drafts);
      const err = drafts[name] === undefined && !f.required ? null : validateField(f, v);
      setHostErrors((e) => {
        if ((e[name] ?? null) === err) return e;
        const { [name]: _gone, ...rest } = e;
        return err ? { ...rest, [name]: err } : rest;
      });
      const draft = drafts[name];
      if (f.change?.event && !isSecret(f) && draft !== undefined && draft !== pluginValue(f)) {
        void actOnElement(watchKey, f.key, { value: valueString(draft), values: formValues(data, drafts, false) });
      }
    },
    submit: () => void send(data),
  };

  const onSubmit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    void send(data);
  };
  return (
    <FormContext.Provider value={{ draftKey, formKey: node.key, locked }}>
      <form
        className={cn("flex min-w-0", strip ? "flex-wrap items-center gap-1.5" : "flex-col gap-3")}
        onSubmit={onSubmit}
        noValidate
        data-testid="plugin-form"
        data-key={node.key}
        data-strip={strip || undefined}
        aria-busy={locked || undefined}
      >
        {data.fields.map((f) => (
          <FieldView key={f.key} f={f} api={api} />
        ))}
        {data.error && (
          <p className={cn("text-caption-sm text-destructive", strip && "order-last basis-full")} role="alert" data-testid="plugin-form-error">
            {data.error}
          </p>
        )}
        {(data.submit || (data.secondary?.length ?? 0) > 0) && (
          <div className={cn("flex min-w-0 items-center gap-1.5", strip ? "shrink-0" : "flex-wrap")}>
            {data.submit && <PluginButton button={data.submit} submit />}
            {data.secondary?.map((b) => (
              <PluginButton key={b.key} button={b} />
            ))}
          </div>
        )}
      </form>
    </FormContext.Provider>
  );
}
