import {
  createLanSignalBundle,
  parseLanSignalBundle,
  serializeLanSignalBundle,
  type LanSignalBundle,
  type LanSignalKind,
  type LanSignalingAdapter,
} from "./lan-signaling.js";

const SIGNAL_QR_PREFIX = "fbx-lan-sig1:";

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((value) => {
    binary += String.fromCharCode(value);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return input;
  const stream = new Blob([input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(input: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") return input;
  try {
    const stream = new Blob([input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer])
      .stream()
      .pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return input;
  }
}

export async function encodeLanSignalQrPayload(bundle: LanSignalBundle): Promise<string> {
  const json = serializeLanSignalBundle(bundle);
  const encoded = new TextEncoder().encode(json);
  const compressed = await gzipBytes(encoded);
  return `${SIGNAL_QR_PREFIX}${bytesToBase64Url(compressed)}`;
}

export async function parseLanSignalQrPayload(raw: string): Promise<LanSignalBundle | null> {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return null;
  if (!text.startsWith(SIGNAL_QR_PREFIX)) return null;
  const body = text.slice(SIGNAL_QR_PREFIX.length);
  if (!body) return null;
  try {
    const compressed = base64UrlToBytes(body);
    const jsonBytes = await gunzipBytes(compressed);
    const json = new TextDecoder().decode(jsonBytes);
    return parseLanSignalBundle(json);
  } catch {
    return null;
  }
}

export function isLanSignalQrPayload(raw: string): boolean {
  return raw.trim().replace(/\s+/g, "").startsWith(SIGNAL_QR_PREFIX);
}

export type ManualQrSignalingHooks = {
  /** Called when this device has a local offer/answer payload ready to show as QR / copy. */
  presentLocalPayload: (kind: LanSignalKind, payload: string) => void;
  /** Resolves when the user scans or pastes the remote peer's payload. */
  waitForRemotePayload: (kind: LanSignalKind, signal?: AbortSignal) => Promise<string>;
};

/**
 * Signaling adapter that publishes via UI (QR / clipboard) instead of a server.
 * Used only when PeerJS Cloud is unavailable.
 */
export class ManualQrSignalingAdapter implements LanSignalingAdapter {
  constructor(private readonly hooks: ManualQrSignalingHooks) {}

  async publish(
    _pairingId: string,
    bundle: LanSignalBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    const payload = await encodeLanSignalQrPayload(bundle);
    this.hooks.presentLocalPayload(bundle.kind, payload);
  }

  async waitForRemote(
    _pairingId: string,
    kind: LanSignalKind,
    signal?: AbortSignal,
  ): Promise<LanSignalBundle> {
    const payload = await this.hooks.waitForRemotePayload(kind, signal);
    const bundle = await parseLanSignalQrPayload(payload);
    if (!bundle) throw new Error("That QR / paste payload is not a valid LAN signaling message.");
    // Kind is validated in the UI before resolve; keep a final guard here.
    if (bundle.kind !== kind) {
      throw new Error(
        kind === "answer"
          ? "Need the other device’s reply QR, but received an invite QR."
          : "Need the other device’s invite QR, but received a reply QR.",
      );
    }
    return bundle;
  }
}

export { createLanSignalBundle };
