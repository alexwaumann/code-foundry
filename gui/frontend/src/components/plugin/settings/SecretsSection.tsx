import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, KeyRound, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { formatAgo } from "@/lib/thread";
import { deletePluginSecret, loadPluginSecrets, usePluginSecrets } from "@/stores/pluginSecrets";

/** The Secrets toggle among a row's actions. */
export function SecretsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <Button variant="ghost" size="xs" className="text-cf-text-muted hover:text-cf-text" aria-expanded={open} onClick={onToggle} data-testid="plugin-secrets-toggle">
      <KeyRound aria-hidden />
      Secrets
      <Chevron aria-hidden />
    </Button>
  );
}

/**
 * A plugin's secrets in the Keychain: each name and when it was set, never a value, with a
 * delete (plugin.secrets.delete, which the daemon confirms). Read when it opens and after a
 * delete; no event says a secret changed.
 */
export function SecretsList({ name }: { name: string }) {
  const entry = usePluginSecrets(name);
  const now = useNow(30_000);
  const [deleting, setDeleting] = useState<string | null>(null);
  useEffect(() => {
    void loadPluginSecrets(name);
  }, [name]);
  const list = entry?.list ?? null;
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-cf-border px-3 py-1.5" data-testid="plugin-secrets">
      {entry?.error ? (
        <p className="py-0.5 text-caption-sm break-words text-cf-error-text" role="alert" data-testid="plugin-secrets-error">
          {entry.error}
        </p>
      ) : list === null ? (
        <p className="py-0.5 text-caption-sm">Reading the Keychain…</p>
      ) : list.length === 0 ? (
        <p className="py-0.5 text-caption-sm" data-testid="plugin-secrets-none">
          No secrets in the Keychain.
        </p>
      ) : (
        list.map((s) => (
          <div key={s.key} className="flex min-w-0 items-center gap-2" data-testid="plugin-secret" data-key={s.key}>
            <span className="min-w-0 truncate font-mono text-caption-sm text-cf-text">{s.key}</span>
            <span className="shrink-0 text-caption-sm tabular-nums" data-testid="plugin-secret-set">
              {s.updatedAtMs === null ? "set" : `set ${formatAgo(s.updatedAtMs, now)}`}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto text-cf-text-muted hover:text-cf-error-text"
              aria-label={`Delete secret ${s.key}`}
              disabled={deleting !== null}
              onClick={() => {
                setDeleting(s.key);
                void deletePluginSecret(name, s.key).finally(() => {
                  setDeleting(null);
                });
              }}
              data-testid="plugin-secret-delete"
            >
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))
      )}
    </div>
  );
}
