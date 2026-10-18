/**
 * The plugin consent prompt (DECISIONS.md, "Consent"): plugin.enable and plugin.dev ask
 * through the daemon's confirm (ConfirmationRequired, its message the consent text) only
 * when the user has not consented to the manifest's permissions (never, or they grew).
 * Their confirm opens the consent dialog (components/plugin/ConsentDialog) instead of the
 * generic one: registered here as their confirm presenter.
 */
import { create } from "zustand";
import { registerConfirmPresenter, type ConfirmRequest } from "./confirm";

export interface ConsentRequest {
  /** The daemon's consent text (plugin.ConsentText). */
  text: string;
  /** The plugin's name (plugin.enable's arg), "" for a folder being linked (plugin.dev). */
  plugin: string;
  /** The folder plugin.dev links. */
  path: string;
  caller?: string;
}

interface ConsentState {
  pending: (ConsentRequest & { resolve: (yes: boolean) => void }) | null;
}

export const useConsentStore = create<ConsentState>()(() => ({ pending: null }));

/** Opens the consent dialog; resolves true when the user enables. A second request cancels the first. */
export function requestConsent(req: ConsentRequest): Promise<boolean> {
  useConsentStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useConsentStore.setState({ pending: { ...req, resolve } });
  });
}

export function answerConsent(yes: boolean): void {
  const p = useConsentStore.getState().pending;
  if (!p) return;
  useConsentStore.setState({ pending: null });
  p.resolve(yes);
}

function present(req: ConfirmRequest): Promise<boolean> {
  return requestConsent({ text: req.message, plugin: req.args?.name ?? "", path: req.args?.path ?? "", ...(req.caller ? { caller: req.caller } : {}) });
}

registerConfirmPresenter("plugin.enable", present);
registerConfirmPresenter("plugin.dev", present);
