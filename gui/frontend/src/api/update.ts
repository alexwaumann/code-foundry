import { timestampDate } from "@bufbuild/protobuf/wkt";
import { UpdateState, type UpdateEvent, type UpdateStatus } from "@/gen/codefoundry/v1/update_pb";

export type UpdateStateView = "idle" | "available" | "downloading" | "installed" | "restartRequired" | "failed";

/** codefoundry.v1.UpdateStatus as the GUI sees it. */
export interface UpdateStatusView {
  state: UpdateStateView;
  /** The running daemon's version. */
  currentVersion: string;
  enabled: boolean;
  disabledReason: string;
  releaseRepo: string;
  checking: boolean;
  lastCheckedAt: Date | null;
  lastCheckError: string;
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
};

export function toUpdateStatusView(s: UpdateStatus): UpdateStatusView {
  return {
    state: stateMap[s.state],
    currentVersion: s.currentVersion,
    enabled: s.enabled,
    disabledReason: s.disabledReason,
    releaseRepo: s.releaseRepo,
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
