/**
 * Development builds only: `window.__cfModule("/src/stores/panel.ts")` resolves to the app's
 * own instance of that module, the way `import("/src/…")` does under the Vite dev server. e2e
 * specs use it to drive a store directly (open a tab, set a width, read a panel entry); it
 * works in the dev server and in the bundled development build the e2e suite runs against,
 * where `/src/…` URLs do not exist. Production builds drop it (main.tsx gates it on DEV).
 */
const modules = import.meta.glob(["/src/stores/*.ts", "/src/api/*.ts", "!/src/**/*.test.ts"]);

export function devModule(path: string): Promise<unknown> {
  const load = modules[path];
  if (!load) return Promise.reject(new Error(`__cfModule: no module ${path} (src/stores/*.ts and src/api/*.ts only)`));
  return load();
}

declare global {
  interface Window {
    __cfModule?: (path: string) => Promise<unknown>;
  }
}
