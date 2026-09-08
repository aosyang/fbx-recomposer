import {
  parseLanSignalBundle,
  serializeLanSignalBundle,
  type LanSignalBundle,
  type LanSignalKind,
  type LanSignalingAdapter,
} from "./lan-signaling.js";

export type HttpLanSignalMeta = {
  pairingId: string;
  kind: LanSignalKind;
  deviceName: string;
};

export type HttpLanSignalListener = (meta: HttpLanSignalMeta) => void;

type PollResponse = {
  ok: boolean;
  kind?: LanSignalKind;
  serialized?: string;
  deviceName?: string;
  error?: string;
};

function requirePairingId(pairingId: string): string {
  const normalized = pairingId.trim().toUpperCase();
  if (!normalized) throw new Error("pairingId is required");
  return normalized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function readJson(response: Response): Promise<PollResponse> {
  const payload = (await response.json()) as PollResponse;
  if (!response.ok) {
    throw new Error(payload.error || `Signaling request failed (${response.status})`);
  }
  return payload;
}

export class HttpLanSignalingAdapter implements LanSignalingAdapter {
  constructor(
    private readonly deviceName: string,
    private readonly onRemoteMeta?: HttpLanSignalListener,
    private readonly basePath = "/api/lan-signal",
  ) {}

  async publish(
    pairingId: string,
    bundle: LanSignalBundle,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const code = requirePairingId(pairingId);
    const response = await fetch(`${this.basePath}/${encodeURIComponent(code)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: bundle.kind,
        serialized: serializeLanSignalBundle(bundle),
        deviceName: this.deviceName,
      }),
      signal,
    });
    await readJson(response);
  }

  async waitForRemote(
    pairingId: string,
    kind: LanSignalKind,
    signal?: AbortSignal,
  ): Promise<LanSignalBundle> {
    const code = requirePairingId(pairingId);

    while (true) {
      throwIfAborted(signal);
      const response = await fetch(
        `${this.basePath}/${encodeURIComponent(code)}?kind=${kind}&waitMs=25000`,
        { method: "GET", signal },
      );
      const payload = await readJson(response);
      if (!payload.ok) continue;
      if (payload.kind !== kind || typeof payload.serialized !== "string") {
        throw new Error("Signaling response was incomplete");
      }
      this.onRemoteMeta?.({
        pairingId: code,
        kind,
        deviceName: payload.deviceName?.trim() || "Another device",
      });
      return parseLanSignalBundle(payload.serialized);
    }
  }

  async clearRoom(pairingId: string, signal?: AbortSignal): Promise<void> {
    const code = requirePairingId(pairingId);
    try {
      await fetch(`${this.basePath}/${encodeURIComponent(code)}`, {
        method: "DELETE",
        signal,
      });
    } catch {
      // Best-effort cleanup when disconnecting.
    }
  }
}

export async function isLanHttpSignalingAvailable(
  basePath = "/api/lan-signal",
): Promise<boolean> {
  try {
    const response = await fetch(`${basePath}/health`, { method: "GET" });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

export function defaultLanDeviceName(): string {
  const existing = window.localStorage.getItem("fbx-lan-device-name");
  if (existing?.trim()) return existing.trim().slice(0, 64);
  const suffix = Math.floor(Math.random() * 900 + 100);
  const name = `Browser ${suffix}`;
  window.localStorage.setItem("fbx-lan-device-name", name);
  return name;
}
