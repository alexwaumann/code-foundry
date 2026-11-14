/** DOM ids of the shell's tabs and pane bodies (a tab's aria-controls, a pane's aria-labelledby). */

export function shellTabDomId(tabId: string): string {
  return `shell-tab-${tabId}`;
}

export function shellBodyDomId(paneId: string): string {
  return `shell-pane-body-${paneId}`;
}
