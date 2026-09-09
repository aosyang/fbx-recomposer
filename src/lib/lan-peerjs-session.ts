import { Peer, type DataConnection, type PeerErrorType } from "peerjs";
import {
  getLanSignalingConfig,
  isValidLanPairingCode,
  normalizeLanPairingCode,
  type LanSignalingConfig,
} from "./lan-signaling-config.js";

export type LanPeerjsSessionResult = {
  peer: Peer;
  connection: DataConnection;
  channel: RTCDataChannel;
  pairingId: string;
  role: "host" | "joiner";
};

export type LanPeerjsSessionOptions = {
  config?: LanSignalingConfig;
  connectTimeoutMs?: number;
  metadata?: Record<string, unknown>;
};

type PeerJsError = Error & { type?: PeerErrorType | string };

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function peerErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "type" in error) {
    const typed = error as PeerJsError;
    const type = String(typed.type || "error");
    const message = typed.message || String(error);
    if (type === "network" || type === "server-error" || type === "socket-error") {
      return `Could not reach the pairing service (${message}). Check the network and try again.`;
    }
    if (type === "unavailable-id") {
      return "This pairing code is already in use. Generate a new code.";
    }
    if (type === "peer-unavailable") {
      return "No device is waiting with that pairing code.";
    }
    return message;
  }
  return error instanceof Error ? error.message : String(error);
}

function waitForPeerOpen(peer: Peer, signal?: AbortSignal): Promise<string> {
  throwIfAborted(signal);
  if (peer.open && peer.id) return Promise.resolve(peer.id);

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      peer.off("open", onOpen);
      peer.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onOpen = (id: string) => {
      cleanup();
      resolve(id);
    };
    const onError = (error: PeerJsError) => {
      cleanup();
      reject(new Error(peerErrorMessage(error)));
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    peer.on("open", onOpen);
    peer.on("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForDataChannel(connection: DataConnection, signal?: AbortSignal): Promise<RTCDataChannel> {
  throwIfAborted(signal);

  const existing = connection.dataChannel;
  if (existing && existing.readyState === "open") return Promise.resolve(existing);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      connection.off("open", onOpen);
      connection.off("error", onError);
      connection.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const tryResolve = () => {
      const channel = connection.dataChannel;
      if (!channel) {
        settle(() => reject(new Error("PeerJS connection opened without a data channel")));
        return;
      }
      if (channel.readyState === "open") {
        settle(() => resolve(channel));
        return;
      }
      const onChannelOpen = () => {
        channel.removeEventListener("open", onChannelOpen);
        settle(() => resolve(channel));
      };
      channel.addEventListener("open", onChannelOpen, { once: true });
    };
    const onOpen = () => tryResolve();
    const onError = (error: unknown) => settle(() => reject(new Error(peerErrorMessage(error))));
    const onClose = () => settle(() => reject(new Error("Peer connection closed before the data channel opened")));
    const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));

    connection.on("open", onOpen);
    connection.on("error", onError);
    connection.on("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    if (connection.open) tryResolve();
  });
}

function createPeer(id: string | undefined, config: LanSignalingConfig): Peer {
  const options = {
    host: config.peerjsHost,
    port: config.peerjsPort,
    path: config.peerjsPath,
    secure: config.peerjsSecure,
    key: config.peerjsKey,
    debug: 0 as const,
    config: {
      iceServers: config.iceServers,
    },
  };
  return id ? new Peer(id, options) : new Peer(options);
}

/**
 * Host waits for a joiner that connects to the short pairing code peer id.
 * Joiner connects to that id. Returns the underlying RTCDataChannel for FBX transfer.
 */
export async function connectLanPeerjsSession(
  role: "host" | "joiner",
  pairingCode: string,
  signal?: AbortSignal,
  options: LanPeerjsSessionOptions = {},
): Promise<LanPeerjsSessionResult> {
  const config = options.config ?? getLanSignalingConfig();
  const code = normalizeLanPairingCode(pairingCode);
  if (!isValidLanPairingCode(code)) {
    throw new Error("Enter a valid pairing code (4–16 letters or digits).");
  }
  throwIfAborted(signal);

  const timeoutMs = options.connectTimeoutMs ?? 45_000;
  const timeout = new AbortController();
  const onParentAbort = () => timeout.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
  const timer = window.setTimeout(() => {
    timeout.abort(
      new DOMException(
        "Couldn’t connect in time. Make sure both devices are on the same local network, then try again.",
        "TimeoutError",
      ),
    );
  }, timeoutMs);
  if (signal) {
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const combined = timeout.signal;

  let peer: Peer | null = null;
  try {
    if (role === "host") {
      peer = createPeer(code, config);
      await waitForPeerOpen(peer, combined);
      const connection = await new Promise<DataConnection>((resolve, reject) => {
        const cleanup = () => {
          peer?.off("connection", onConnection);
          peer?.off("error", onError);
          combined.removeEventListener("abort", onAbort);
        };
        const onConnection = (conn: DataConnection) => {
          cleanup();
          resolve(conn);
        };
        const onError = (error: PeerJsError) => {
          cleanup();
          reject(new Error(peerErrorMessage(error)));
        };
        const onAbort = () => {
          cleanup();
          reject(combined.reason ?? new DOMException("Aborted", "AbortError"));
        };
        peer!.on("connection", onConnection);
        peer!.on("error", onError);
        combined.addEventListener("abort", onAbort, { once: true });
      });
      const channel = await waitForDataChannel(connection, combined);
      return { peer, connection, channel, pairingId: code, role };
    }

    peer = createPeer(undefined, config);
    await waitForPeerOpen(peer, combined);
    const connection = peer.connect(code, {
      reliable: true,
      serialization: "raw",
      metadata: options.metadata ?? {},
      label: "fbx-transfer",
    });
    const channel = await waitForDataChannel(connection, combined);
    return { peer, connection, channel, pairingId: code, role: "joiner" };
  } catch (error) {
    peer?.destroy();
    throw error instanceof Error ? error : new Error(peerErrorMessage(error));
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", onParentAbort);
  }
}
