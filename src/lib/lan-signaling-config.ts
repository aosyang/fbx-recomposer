/** Central LAN signaling backend selection for future Worker / PeerServer swaps. */

export type LanSignalingMode = "peerjs" | "worker";

export type LanSignalingConfig = {
  mode: LanSignalingMode;
  /** PeerJS Cloud is the default; override for a self-hosted PeerServer. */
  peerjsHost: string;
  peerjsPort: number;
  peerjsPath: string;
  peerjsSecure: boolean;
  peerjsKey: string;
  /** Optional custom Worker / HTTP signaling base (future). */
  workerBaseUrl: string | null;
  /** Prefer LAN host candidates when empty. */
  iceServers: RTCIceServer[];
};

function readEnv(name: string): string | undefined {
  try {
    const value = (import.meta as ImportMeta & { env?: Record<string, string> }).env?.[name];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function getLanSignalingConfig(): LanSignalingConfig {
  const modeRaw = (readEnv("VITE_LAN_SIGNALING_MODE") ?? "peerjs").toLowerCase();
  const mode: LanSignalingMode = modeRaw === "worker" ? "worker" : "peerjs";
  const workerBaseUrl = readEnv("VITE_LAN_SIGNALING_URL") ?? null;

  return {
    mode,
    peerjsHost: readEnv("VITE_PEERJS_HOST") ?? "0.peerjs.com",
    peerjsPort: Number(readEnv("VITE_PEERJS_PORT") ?? "443") || 443,
    peerjsPath: readEnv("VITE_PEERJS_PATH") ?? "/",
    peerjsSecure: (readEnv("VITE_PEERJS_SECURE") ?? "true") !== "false",
    peerjsKey: readEnv("VITE_PEERJS_KEY") ?? "peerjs",
    workerBaseUrl,
    // Empty list keeps host / .local candidates first for same-Wi-Fi transfers.
    iceServers: [],
  };
}

export function defaultLanDeviceName(): string {
  const platform = navigator.platform || "device";
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Mac/i.test(platform)) return "Mac";
  if (/Win/i.test(platform)) return "Windows PC";
  if (/Linux/i.test(platform)) return "Linux";
  return "Browser";
}

/** PeerJS accepts alphanumerics; our codes are uppercase hex. */
export function normalizeLanPairingCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidLanPairingCode(code: string): boolean {
  return /^[A-Z0-9]{4,16}$/.test(code);
}

/** Short uppercase hex id used as PeerJS pairing code. */
export function makeLanPairingId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}
