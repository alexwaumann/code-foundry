import { timestampDate } from "@bufbuild/protobuf/wkt";
import { UpdateState, type UpdateEvent, type UpdateStatus } from "@/gen/codefoundry/v1/update_pb";

export type UpdateStateView = "idle" | "available" | "downloading" | "downloaded" | "installed" | "restartRequired" | "failed";

/** The release channel the updater follows (the update.channel setting). */
export type UpdateChannel = "stable" | "tip";

/** codefoundry.v1.UpdateStatus as the GUI sees it. */
export interface UpdateStatusView {
  state: UpdateStateView;
  /** The running daemon's version. */
  currentVersion: string;
  enabled: boolean;
  disabledReason: string;
  releaseRepo: string;
  /** The channel checks follow; "stable" from a daemon that predates channels. */
  channel: UpdateChannel;
  checking: boolean;
  lastCheckedAt: Date | null;
  lastCheckError: string;
  /** The channel's latest release; may be older than currentVersion on stable after a switch from tip. */
  latestVersion: string;
  /** The version available / installing / installed / failed. */
  targetVersion: string;
  notesUrl: string;
  progress: string;
  failureReason: string;
}

export type UpdateEventView = { kind: "status"; status: UpdateStatusView } | { kind: "relaunch" };

const stateMap: Record<UpdateState, UpdateStateView> = {
  [UpdateState.UNSPECIFIED]: "idle",
  [UpdateState.IDLE]: "idle",
  [UpdateState.AVAILABLE]: "available",
  [UpdateState.DOWNLOADING]: "downloading",
  [UpdateState.INSTALLED]: "installed",
  [UpdateState.RESTART_REQUIRED]: "restartRequired",
  [UpdateState.FAILED]: "failed",
  [UpdateState.DOWNLOADED]: "downloaded",
};

export function toUpdateStatusView(s: UpdateStatus): UpdateStatusView {
  return {
    state: stateMap[s.state],
    currentVersion: s.currentVersion,
    enabled: s.enabled,
    disabledReason: s.disabledReason,
    releaseRepo: s.releaseRepo,
    channel: s.channel === "tip" ? "tip" : "stable",
    checking: s.checking,
    lastCheckedAt: s.lastCheckedAt ? timestampDate(s.lastCheckedAt) : null,
    lastCheckError: s.lastCheckError,
    latestVersion: s.latestVersion,
    targetVersion: s.targetVersion,
    notesUrl: s.notesUrl,
    progress: s.progress,
    failureReason: s.failureReason,
  };
}

export function toUpdateEventView(e: UpdateEvent): UpdateEventView | null {
  switch (e.event.case) {
    case "status":
      return { kind: "status", status: toUpdateStatusView(e.event.value) };
    case "relaunchRequested":
      return { kind: "relaunch" };
    default:
      return null;
  }
}
