import { openPullRequestLinkInCurrentPanel } from "@/components/pr/prLinks";
import { openUrl } from "@/stores/gh";

/**
 * Opens a cmd+clicked terminal link the way a thread's messages do: a GitHub pull request
 * as a Pull request tab of the selection's panel, anything else (and cmd+shift+click on
 * a pull request) in the browser through view.open.url. The web view drops window.open.
 */
export function openTerminalLink(uri: string, e: Pick<MouseEvent, "shiftKey">): void {
  if (!/^https?:\/\//i.test(uri)) return;
  if (!e.shiftKey && openPullRequestLinkInCurrentPanel(uri)) return;
  void openUrl(uri);
}
