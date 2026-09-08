import { useEffect, useMemo, useRef, useState } from "react";
import {
  LanFileTransferController,
  type LanFileTransferState,
} from "../lib/lan-transfer-controller.js";
import {
  defaultLanDeviceName,
  HttpLanSignalingAdapter,
  isLanHttpSignalingAvailable,
} from "../lib/lan-http-signaling.js";
import { LanPeerSession, type LanPeerRole } from "../lib/lan-peer-session.js";
import type { LanTransferProgress } from "../lib/lan-transfer-protocol.js";
import {
  announceTopbarMenu,
  closeOpenFileMenus,
  TOPBAR_MENU_EVENT,
  type TopbarMenuId,
} from "../lib/topbar-menus.js";
import LanPairingQrCode from "./LanPairingQrCode";
import LanPairingQrScanner from "./LanPairingQrScanner";

type UiMode = "home" | "create" | "enter" | "connected";
type PairingPhase = "idle" | "waiting" | "connecting" | "connected" | "error";

type LanManualPairingProps = {
  onReceiveFile?: (file: File) => void | Promise<void>;
};

type TransferDirection = "send" | "receive";

function makePairingId(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

function progressPercent(progress: LanTransferProgress | null): number {
  if (!progress) return 0;
  if (progress.totalBytes === 0) return 100;
  return Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100));
}

function stateMessage(state: LanFileTransferState): string {
  switch (state.phase) {
    case "sending":
      return state.awaitingAck
        ? `Waiting for the other device to confirm ${state.fileName}...`
        : `Sending ${state.fileName}...`;
    case "receiving":
      return `Receiving ${state.fileName}...`;
    case "completed":
      return state.direction === "receive"
        ? `Received and opened ${state.fileName}.`
        : `Transfer completed: ${state.fileName}.`;
    case "cancelled":
      return state.fileName
        ? `${state.fileName} cancelled: ${state.reason}.`
        : `Transfer cancelled: ${state.reason}.`;
    case "peer_closed":
      return state.reason;
  }
}

export default function LanManualPairing({ onReceiveFile }: LanManualPairingProps) {
  const [open, setOpen] = useState(false);
  const [uiMode, setUiMode] = useState<UiMode>("home");
  const [pairingId, setPairingId] = useState(() => makePairingId());
  const [enterCode, setEnterCode] = useState("");
  const [phase, setPhase] = useState<PairingPhase>("idle");
  const [status, setStatus] = useState("Not connected");
  const [peerName, setPeerName] = useState<string | null>(null);
  const [httpAvailable, setHttpAvailable] = useState<boolean | null>(null);
  const [transferDirection, setTransferDirection] = useState<TransferDirection | null>(null);
  const [transferProgress, setTransferProgress] = useState<LanTransferProgress | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const sendFileInputRef = useRef<HTMLInputElement | null>(null);
  const deviceNameRef = useRef(defaultLanDeviceName());
  const peerNameRef = useRef<string | null>(null);
  const httpAdapterRef = useRef<HttpLanSignalingAdapter | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const transferRef = useRef<LanFileTransferController | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const activeCodeRef = useRef<string | null>(null);

  const transferPercent = progressPercent(transferProgress);
  const transferActive = transferDirection !== null;
  const busy = phase === "waiting" || phase === "connecting";

  const clearTransferState = () => {
    setTransferDirection(null);
    setTransferProgress(null);
  };

  const tearDownConnection = () => {
    const code = activeCodeRef.current;
    const httpAdapter = httpAdapterRef.current;
    sendAbortRef.current?.abort(new DOMException("Pairing disconnected", "AbortError"));
    sendAbortRef.current = null;
    transferRef.current?.cancelReceive("Pairing disconnected");
    transferRef.current?.dispose();
    transferRef.current = null;
    abortRef.current?.abort(new DOMException("Pairing cancelled", "AbortError"));
    abortRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    if (code && httpAdapter) {
      void httpAdapter.clearRoom(code);
    }
    httpAdapterRef.current = null;
    activeCodeRef.current = null;
    peerNameRef.current = null;
    clearTransferState();
    setPeerName(null);
  };

  const disconnect = (nextStatus = "Not connected") => {
    tearDownConnection();
    setPhase("idle");
    setUiMode("home");
    setStatus(nextStatus);
  };

  useEffect(() => () => {
    tearDownConnection();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void isLanHttpSignalingAvailable().then((available) => {
      if (!cancelled) setHttpAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onTopbarMenu = (event: Event) => {
      const menu = (event as CustomEvent<TopbarMenuId>).detail;
      if (menu !== "lan") setOpen(false);
    };
    window.addEventListener(TOPBAR_MENU_EVENT, onTopbarMenu);
    return () => window.removeEventListener(TOPBAR_MENU_EVENT, onTopbarMenu);
  }, []);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggleOpen = () => {
    setOpen((value) => {
      const next = !value;
      if (next) {
        closeOpenFileMenus();
        announceTopbarMenu("lan");
      }
      return next;
    });
  };
  const installTransferController = (channel: RTCDataChannel) => {
    transferRef.current?.dispose();
    transferRef.current = new LanFileTransferController(channel, {
      onSendProgress: (progress) => {
        setTransferDirection("send");
        setTransferProgress(progress);
      },
      onReceiveProgress: (progress) => {
        setTransferDirection("receive");
        setTransferProgress(progress);
      },
      onReceiveFile: async (file) => {
        setStatus(`Received ${file.name}. Opening it...`);
        await onReceiveFile?.(file);
        setStatus(`Received and opened ${file.name}.`);
      },
      onState: (state) => {
        setStatus(stateMessage(state));
        if (state.phase === "sending") setTransferDirection("send");
        if (state.phase === "receiving") setTransferDirection("receive");
        if (
          state.phase === "completed" ||
          state.phase === "cancelled" ||
          state.phase === "peer_closed"
        ) {
          sendAbortRef.current = null;
          clearTransferState();
        }
      },
      onError: (error) => {
        sendAbortRef.current = null;
        setPhase("error");
        setStatus(error.message);
      },
    });
  };

  const connectPeer = async (
    role: LanPeerRole,
    code: string,
    waitingStatus: string,
    nextUiMode: UiMode,
  ) => {
    tearDownConnection();
    const adapter = new HttpLanSignalingAdapter(deviceNameRef.current, (meta) => {
      peerNameRef.current = meta.deviceName;
      setPeerName(meta.deviceName);
      setStatus(`Connecting to ${meta.deviceName}...`);
    });
    httpAdapterRef.current = adapter;
    activeCodeRef.current = code;
    setPairingId(code);
    setUiMode(nextUiMode);
    setPhase(role === "host" ? "waiting" : "connecting");
    setStatus(waitingStatus);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const session = new LanPeerSession(adapter);
      const { peer, channel } = await session.connect(role, code, controller.signal);
      if (controller.signal.aborted) {
        peer.close();
        channel.close();
        return;
      }

      peerRef.current = peer;
      channelRef.current = channel;
      installTransferController(channel);

      const markConnected = () => {
        const connectedName = peerNameRef.current;
        setPhase("connected");
        setUiMode("connected");
        setStatus(connectedName ? `Connected to ${connectedName}` : "Connected");
      };
      if (channel.readyState === "open") {
        markConnected();
      } else {
        channel.addEventListener("open", markConnected, { once: true });
        setPhase("connecting");
        setStatus("Finishing connection...");
      }
      channel.addEventListener("close", () => {
        if (!controller.signal.aborted) {
          disconnect("Connection closed.");
        }
      }, { once: true });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const createCode = async () => {
    if (httpAvailable === false) {
      setPhase("error");
      setStatus("LAN pairing needs the app server running on this network.");
      return;
    }

    const code = makePairingId();
    peerNameRef.current = null;
    setPeerName(null);
    await connectPeer("host", code, "Waiting for another device to connect…", "create");
  };

  const connectWithCode = async (rawCode = enterCode) => {
    const code = rawCode.trim().toUpperCase();
    if (!code) {
      setPhase("error");
      setStatus("Enter a pairing code first.");
      return;
    }
    if (httpAvailable === false) {
      setPhase("error");
      setStatus("LAN pairing needs the app server running on this network.");
      return;
    }

    setEnterCode(code);
    peerNameRef.current = null;
    setPeerName(null);
    await connectPeer("joiner", code, `Connecting with code ${code}...`, "enter");
  };

  const sendFile = async (file?: File) => {
    if (!file) return;
    const transfer = transferRef.current;
    if (!transfer || channelRef.current?.readyState !== "open") {
      setStatus("Connect to a device before sending an FBX.");
      return;
    }
    if (sendAbortRef.current) {
      setStatus("A send is already active.");
      return;
    }

    const controller = new AbortController();
    sendAbortRef.current = controller;
    setTransferDirection("send");
    setTransferProgress(null);

    try {
      await transfer.send(file, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhase("error");
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  const cancelTransfer = () => {
    const hadSend = Boolean(sendAbortRef.current);
    sendAbortRef.current?.abort(new DOMException("Cancelled by user", "AbortError"));
    sendAbortRef.current = null;
    transferRef.current?.cancelReceive("Cancelled by user");
    clearTransferState();
    setStatus(hadSend ? "Cancelling send..." : "Transfer cancelled.");
  };

  const copyPairingCode = async () => {
    try {
      await navigator.clipboard.writeText(pairingId);
      setStatus("Pairing code copied.");
    } catch {
      setStatus("Could not copy the pairing code.");
    }
  };

  const headline = useMemo(() => {
    if (phase === "connected") {
      return peerName ? `Connected to ${peerName}` : "Connected";
    }
    if (phase === "error") return "Connection failed";
    if (uiMode === "create" && busy) return "Waiting for another device to connect…";
    if (uiMode === "enter" && busy) return "Connecting…";
    return "Not connected";
  }, [busy, peerName, phase, uiMode]);

  const statusBadge = useMemo(() => {
    if (phase === "connected") return "Connected";
    if (phase === "error") return "Failed";
    if (uiMode === "create" && busy) return "Ready";
    if (uiMode === "enter" && busy) return "Connecting";
    return "Idle";
  }, [busy, phase, uiMode]);

  return (
    <div className="lan-pairing" ref={rootRef}>
      <button
        type="button"
        className={`secondary-button lan-pairing-trigger ${open ? "is-open" : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={toggleOpen}
      >
        LAN
        <span className="display-menu-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div
          className="lan-pairing-panel"
          role="dialog"
          aria-label="LAN transfer"
        >
          <div className="lan-pairing-header">
            <div>
              <h2 className="typo-title">LAN Transfer</h2>
              <p className="typo-secondary">Send FBX files to another device on the same network.</p>
            </div>
            <button
              type="button"
              className="lan-pairing-close"
              aria-label="Close LAN transfer"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </div>

          <div className="lan-pairing-body">
            <div className={`lan-pairing-status is-${phase}${uiMode === "create" && busy ? " is-ready" : ""}`}>
              <span className="lan-pairing-status-badge">
                {statusBadge}
              </span>
              <p>{headline}</p>
              {status !== headline ? <p className="lan-pairing-status-detail">{status}</p> : null}
            </div>

            {uiMode === "home" && phase !== "connected" ? (
              <div className="lan-pairing-home">
                <button
                  type="button"
                  className="primary-button lan-pairing-full"
                  onClick={() => void createCode()}
                  disabled={busy || httpAvailable === false}
                >
                  Create pairing code
                </button>
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  onClick={() => {
                    setUiMode("enter");
                    setPhase("idle");
                    setStatus("Scan the QR code or enter the pairing code.");
                  }}
                  disabled={busy}
                >
                  Enter pairing code
                </button>
                {httpAvailable === false ? (
                  <p className="lan-pairing-hint">
                    LAN pairing is unavailable because the app server is not reachable.
                  </p>
                ) : null}
              </div>
            ) : null}

            {uiMode === "create" && phase !== "connected" ? (
              <div className="lan-pairing-create">
                <div className="lan-pairing-code-card">
                  <strong className="lan-pairing-section-title typo-section">Pair another device</strong>
                  <span className="lan-pairing-label typo-section">Pairing code</span>
                  <strong className="lan-pairing-code typo-code">{pairingId}</strong>
                  <LanPairingQrCode code={pairingId} />
                  <p className="lan-pairing-hint typo-secondary">
                    On the other device, open LAN Transfer and scan this QR code or enter the pairing code.
                  </p>
                  <div className="lan-pairing-actions">
                    <button type="button" className="secondary-button" onClick={() => void copyPairingCode()}>
                      Copy code
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => void createCode()}
                    >
                      Generate new code
                    </button>
                  </div>
                </div>
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  onClick={() => disconnect("Not connected")}
                >
                  Cancel
                </button>
              </div>
            ) : null}

            {uiMode === "enter" && phase !== "connected" ? (
              <div className="lan-pairing-enter">
                <LanPairingQrScanner
                  disabled={busy}
                  onCode={(code) => {
                    setStatus(`Scanned ${code}. Connecting...`);
                    void connectWithCode(code);
                  }}
                />
                <label className="lan-pairing-field">
                  <span className="lan-pairing-label">Or enter the pairing code</span>
                  <input
                    className="lan-pairing-input"
                    value={enterCode}
                    onChange={(event) => setEnterCode(event.target.value.toUpperCase())}
                    disabled={busy}
                    placeholder="e.g. 5F1AF5"
                    spellCheck={false}
                    autoCapitalize="characters"
                    aria-label="Enter pairing code"
                  />
                </label>
                <div className="lan-pairing-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void connectWithCode()}
                    disabled={busy || !enterCode.trim()}
                  >
                    Connect
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => disconnect("Not connected")}
                    disabled={busy}
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : null}

            {phase === "connected" ? (
              <div className="lan-pairing-connected">
                <input
                  ref={sendFileInputRef}
                  className="visually-hidden"
                  type="file"
                  accept=".fbx"
                  disabled={transferActive}
                  onChange={(event) => {
                    void sendFile(event.currentTarget.files?.[0]);
                    event.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  className="primary-button lan-pairing-full"
                  disabled={transferActive}
                  onClick={() => sendFileInputRef.current?.click()}
                >
                  Send FBX
                </button>
                {transferActive ? (
                  <div className="lan-pairing-transfer">
                    <div className="lan-pairing-transfer-meta">
                      <span>{transferDirection === "send" ? "Sending" : "Receiving"} FBX</span>
                      <span>{transferPercent}%</span>
                    </div>
                    <div
                      className="lan-pairing-progress"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={transferPercent}
                    >
                      <span style={{ width: `${transferPercent}%` }} />
                    </div>
                    <p className="lan-pairing-hint">
                      {transferProgress
                        ? `${transferProgress.receivedBytes.toLocaleString()} / ${transferProgress.totalBytes.toLocaleString()} bytes`
                        : "Preparing transfer..."}
                    </p>
                    <button type="button" className="secondary-button lan-pairing-full" onClick={cancelTransfer}>
                      Cancel transfer
                    </button>
                  </div>
                ) : null}
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  onClick={() => disconnect("Not connected")}
                >
                  Disconnect
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
