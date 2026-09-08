export const LAN_SIGNALING_PROTOCOL_VERSION = 1;

export type LanSignalKind = "offer" | "answer";

export type LanSignalCandidate = {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
};

export type LanSignalBundle = {
  version: typeof LAN_SIGNALING_PROTOCOL_VERSION;
  kind: LanSignalKind;
  description: RTCSessionDescriptionInit;
  candidates: LanSignalCandidate[];
};

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseNullableString(value: unknown, label: string): string | null {
  if (value === null || typeof value === "undefined") return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function parseNullableInteger(value: unknown, label: string): number | null {
  if (value === null || typeof value === "undefined") return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer or null`);
  }
  return value as number;
}

function normalizeCandidate(candidate: RTCIceCandidateInit): LanSignalCandidate {
  if (typeof candidate.candidate !== "string") throw new Error("ICE candidate text is required");
  const normalized: LanSignalCandidate = {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
  };
  if (typeof candidate.usernameFragment !== "undefined") {
    normalized.usernameFragment = candidate.usernameFragment ?? null;
  }
  return normalized;
}

export function createLanSignalBundle(
  kind: LanSignalKind,
  description: RTCSessionDescriptionInit,
  candidates: readonly RTCIceCandidateInit[],
): LanSignalBundle {
  if (description.type !== kind) {
    throw new Error(`signal description type ${description.type} does not match ${kind}`);
  }
  if (typeof description.sdp !== "string" || description.sdp.length === 0) {
    throw new Error("signal description SDP is required");
  }
  return {
    version: LAN_SIGNALING_PROTOCOL_VERSION,
    kind,
    description: { type: description.type, sdp: description.sdp },
    candidates: candidates.map(normalizeCandidate),
  };
}

export function serializeLanSignalBundle(bundle: LanSignalBundle): string {
  return JSON.stringify(bundle);
}

export function parseLanSignalBundle(serialized: string): LanSignalBundle {
  if (!serialized.trim()) throw new Error("signal bundle is empty");

  const root = requireObject(JSON.parse(serialized) as unknown, "signal bundle");
  if (root.version !== LAN_SIGNALING_PROTOCOL_VERSION) {
    throw new Error("signal bundle version is unsupported");
  }
  if (root.kind !== "offer" && root.kind !== "answer") {
    throw new Error("signal bundle kind is invalid");
  }

  const description = requireObject(root.description, "signal description");
  if (description.type !== root.kind) {
    throw new Error("signal description type does not match bundle kind");
  }
  if (typeof description.sdp !== "string" || description.sdp.length === 0) {
    throw new Error("signal description SDP is required");
  }

  if (!Array.isArray(root.candidates)) {
    throw new Error("signal candidates must be an array");
  }
  const candidates = root.candidates.map((value, index): LanSignalCandidate => {
    const candidate = requireObject(value, `signal candidate ${index}`);
    if (typeof candidate.candidate !== "string") {
      throw new Error(`signal candidate ${index} text is required`);
    }
    const normalized: LanSignalCandidate = {
      candidate: candidate.candidate,
      sdpMid: parseNullableString(candidate.sdpMid, `signal candidate ${index} sdpMid`),
      sdpMLineIndex: parseNullableInteger(candidate.sdpMLineIndex, `signal candidate ${index} sdpMLineIndex`),
    };
    if ("usernameFragment" in candidate) {
      normalized.usernameFragment = parseNullableString(
        candidate.usernameFragment,
        `signal candidate ${index} usernameFragment`,
      );
    }
    return normalized;
  });

  return {
    version: LAN_SIGNALING_PROTOCOL_VERSION,
    kind: root.kind,
    description: { type: root.kind, sdp: description.sdp },
    candidates,
  };
}

export interface LanSignalingAdapter {
  publish(pairingId: string, bundle: LanSignalBundle, signal?: AbortSignal): Promise<void>;
  waitForRemote(pairingId: string, kind: LanSignalKind, signal?: AbortSignal): Promise<LanSignalBundle>;
}
