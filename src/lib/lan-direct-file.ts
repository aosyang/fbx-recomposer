export const LAN_DIRECT_FILE_PROTOCOL_VERSION = 1;

export type LanDirectFileMetadata = {
  kind: "fbx-file";
  version: typeof LAN_DIRECT_FILE_PROTOCOL_VERSION;
  name: string;
  size: number;
  mimeType: string;
};

export function createLanDirectFileMetadata(
  file: Pick<File, "name" | "size" | "type">,
): LanDirectFileMetadata {
  if (!file.name.toLowerCase().endsWith(".fbx")) {
    throw new Error("LAN transfer only accepts .fbx files");
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error("FBX file size is invalid");
  }
  return {
    kind: "fbx-file",
    version: LAN_DIRECT_FILE_PROTOCOL_VERSION,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
  };
}

export function serializeLanDirectFileMetadata(metadata: LanDirectFileMetadata): string {
  return JSON.stringify(metadata);
}

export function parseLanDirectFileMetadata(serialized: string): LanDirectFileMetadata {
  const value = JSON.parse(serialized) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("LAN file metadata must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "fbx-file" || record.version !== LAN_DIRECT_FILE_PROTOCOL_VERSION) {
    throw new Error("LAN file metadata kind or version is unsupported");
  }
  if (typeof record.name !== "string" || !record.name.toLowerCase().endsWith(".fbx")) {
    throw new Error("LAN file metadata name must end with .fbx");
  }
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) {
    throw new Error("LAN file metadata size is invalid");
  }
  if (typeof record.mimeType !== "string") {
    throw new Error("LAN file metadata mimeType is invalid");
  }
  return {
    kind: "fbx-file",
    version: LAN_DIRECT_FILE_PROTOCOL_VERSION,
    name: record.name,
    size: record.size as number,
    mimeType: record.mimeType,
  };
}

export function directTransferLimit(peer: RTCPeerConnection): number | null {
  const maxMessageSize = peer.sctp?.maxMessageSize;
  if (!maxMessageSize || !Number.isFinite(maxMessageSize) || maxMessageSize <= 0) return null;
  return maxMessageSize;
}
