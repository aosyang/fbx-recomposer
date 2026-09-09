import { useEffect, useMemo, useRef, useState } from "react";
import type { Peer } from "peerjs";
import type { MotionStackConfig } from "./AnimationFixStack";
import type { FbxExportSelection } from "../lib/fbx-export";
import {
  LanFileTransferController,
  type LanFileTransferState,
  type LanReceiveFileMeta,
} from "../lib/lan-transfer-controller.js";
import {
  defaultLanDeviceName,
  isValidLanPairingCode,
  makeLanPairingId,
  normalizeLanPairingCode,
} from "../lib/lan-signaling-config.js";
import { connectLanPeerjsSession } from "../lib/lan-peerjs-session.js";
import { ManualQrSignalingAdapter, parseLanSignalQrPayload } from "../lib/lan-qr-signaling.js";
import { LanPeerSession } from "../lib/lan-peer-session.js";
import type { LanSignalKind } from "../lib/lan-signaling.js";
import type { LanTransferProgress } from "../lib/lan-transfer-protocol.js";
import {
  announceTopbarMenu,
  closeOpenFileMenus,
  TOPBAR_MENU_EVENT,
  type TopbarMenuId,
} from "../lib/topbar-menus.js";
import LanPairingQrCode from "./LanPairingQrCode";
import LanPairingQrScanner from "./LanPairingQrScanner";
import { classifyLanQrPayload, type LanScannedPayload } from "../lib/lan-pairing-qr.js";

/** Offline dual-QR signaling is hidden until scan reliability is fixed. */
const ENABLE_OFFLINE_QR = false;

type MethodTab = "code" | "cloudless";
type Screen =
  | "tabs"
  | "code-host"
  | "cloudless-show"
  | "cloudless-scan-reply"
  | "cloudless-show-reply"
  | "scan-join"
  | "connected";
type PairingPhase = "idle" | "waiting" | "connecting" | "connected" | "error";
type TransferDirection = "send" | "receive";

type LanManualPairingProps = {
  canSendCharacter?: boolean;
  canSendAnimation?: boolean;
  characterFileName?: string;
  animationFileName?: string;
  createOpenedExportFile?: (selection: FbxExportSelection) => File;
  getMotionStackConfig?: () => MotionStackConfig;
  onReceiveFile?: (file: File, meta?: LanReceiveFileMeta) => void | Promise<void>;
};

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

function shortName(name: string, fallback: string): string {
  const trimmed = name.trim();
  if (!trimmed) return fallback;
  return trimmed.toLowerCase().endsWith(".fbx") ? trimmed.slice(0, -4) : trimmed;
}

export default function LanManualPairing({
  canSendCharacter = false,
  canSendAnimation = false,
  characterFileName = "",
  animationFileName = "",
  createOpenedExportFile,
  getMotionStackConfig,
  onReceiveFile,
}: LanManualPairingProps) {
  const [open, setOpen] = useState(false);
  const [methodTab, setMethodTab] = useState<MethodTab>("code");
  const [screen, setScreen] = useState<Screen>("tabs");
  const [pairingId, setPairingId] = useState(() => makeLanPairingId());
  const [manualCode, setManualCode] = useState("");
  const [phase, setPhase] = useState<PairingPhase>("idle");
  const [status, setStatus] = useState("Not connected");
  const [peerName, setPeerName] = useState<string | null>(null);
  const [localSignalPayload, setLocalSignalPayload] = useState<string | null>(null);
  const [localSignalKind, setLocalSignalKind] = useState<LanSignalKind | null>(null);
  const [awaitingRemoteKind, setAwaitingRemoteKind] = useState<LanSignalKind | null>(null);
  const [pastePayload, setPastePayload] = useState("");
  const [transferDirection, setTransferDirection] = useState<TransferDirection | null>(null);
  const [transferProgress, setTransferProgress] = useState<LanTransferProgress | null>(null);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const sendFileInputRef = useRef<HTMLInputElement | null>(null);
  const deviceNameRef = useRef(defaultLanDeviceName());
  const peerNameRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const peerjsRef = useRef<Peer | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const transferRef = useRef<LanFileTransferController | null>(null);
  const sendAbortRef = useRef<AbortController | null>(null);
  const remotePayloadWaiterRef = useRef<{
    kind: LanSignalKind;
    resolve: (payload: string) => void;
    reject: (error: unknown) => void;
  } | null>(null);

  const transferPercent = progressPercent(transferProgress);
  const transferActive = transferDirection !== null;
  const busy = phase === "waiting" || phase === "connecting";
  const canSendOpened = Boolean(createOpenedExportFile) && (canSendCharacter || canSendAnimation);
  const connected = screen === "connected" || phase === "connected";

  const clearTransferState = () => {
    setTransferDirection(null);
    setTransferProgress(null);
  };

  const clearSignalUi = () => {
    setLocalSignalPayload(null);
    setLocalSignalKind(null);
    setAwaitingRemoteKind(null);
    setPastePayload("");
    const waiter = remotePayloadWaiterRef.current;
    remotePayloadWaiterRef.current = null;
    waiter?.reject(new DOMException("Pairing cancelled", "AbortError"));
  };

  const tearDownConnection = () => {
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
    peerjsRef.current?.destroy();
    peerjsRef.current = null;
    peerNameRef.current = null;
    clearTransferState();
    clearSignalUi();
    setPeerName(null);
  };

  const resetToTabs = (nextStatus = "Not connected") => {
    tearDownConnection();
    setPhase("idle");
    setScreen("tabs");
    setStatus(nextStatus);
  };

  useEffect(() => () => {
    tearDownConnection();
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
    channelRef.current = channel;
    transferRef.current = new LanFileTransferController(channel, {
      onSendProgress: (progress) => {
        setTransferDirection("send");
        setTransferProgress(progress);
      },
      onReceiveProgress: (progress) => {
        setTransferDirection("receive");
        setTransferProgress(progress);
      },
      onReceiveFile: async (file, meta) => {
        setStatus(`Received ${file.name}. Opening it...`);
        await onReceiveFile?.(file, meta);
        setStatus(
          meta?.motionStack
            ? `Received and opened ${file.name} with Tools settings.`
            : `Received and opened ${file.name}.`,
        );
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

  const markConnected = (label?: string) => {
    const connectedName = label ?? peerNameRef.current;
    setPhase("connected");
    setScreen("connected");
    setStatus(connectedName ? `Connected to ${connectedName}` : "Connected");
    if (connectedName) setPeerName(connectedName);
  };

  const connectPeerjs = async (role: "host" | "joiner", code: string) => {
    tearDownConnection();
    const normalized = normalizeLanPairingCode(code);
    if (role === "joiner" && !isValidLanPairingCode(normalized)) {
      setPhase("error");
      setStatus("That pairing code is not valid. Generate a new code to try again.");
      return;
    }
    setPairingId(normalized);
    setMethodTab("code");
    setScreen(role === "host" ? "code-host" : "scan-join");
    setPhase(role === "host" ? "waiting" : "connecting");
    setStatus(role === "host" ? "Waiting for another device" : "Connecting…");

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const session = await connectLanPeerjsSession(role, normalized, controller.signal, {
        metadata: { deviceName: deviceNameRef.current },
      });
      if (controller.signal.aborted) {
        session.peer.destroy();
        return;
      }
      peerjsRef.current = session.peer;
      const remoteMeta = session.connection.metadata as { deviceName?: string } | undefined;
      if (remoteMeta?.deviceName) {
        peerNameRef.current = remoteMeta.deviceName;
        setPeerName(remoteMeta.deviceName);
      }
      installTransferController(session.channel);
      session.channel.addEventListener("close", () => {
        if (!controller.signal.aborted) resetToTabs("Not connected");
      }, { once: true });
      markConnected(remoteMeta?.deviceName);
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setStatus(
        error instanceof Error
          ? error.message
          : "Make sure both devices are on the same local network, then try again.",
      );
    }
  };

  const startCloudlessSession = async (
    role: "host" | "joiner",
    initialOfferPayload?: string,
  ) => {
    tearDownConnection();
    const code = makeLanPairingId();
    setPairingId(code);
    setMethodTab("cloudless");
    setScreen(role === "host" ? "cloudless-show" : "scan-join");
    setPhase(role === "host" ? "waiting" : "connecting");
    setStatus(
      role === "host"
        ? "Show this QR. The other device taps Scan to join — no need to switch tabs."
        : "Connecting…",
    );

    const controller = new AbortController();
    abortRef.current = controller;
    let offerFed = false;

    const adapter = new ManualQrSignalingAdapter({
      presentLocalPayload: (kind, payload) => {
        setLocalSignalKind(kind);
        setLocalSignalPayload(payload);
        if (kind === "offer") {
          setScreen("cloudless-show");
          setStatus("Show this QR to the other device. Do not scan it on this device.");
        } else {
          setScreen("cloudless-show-reply");
          setStatus("Show this QR to the other device. Waiting for them to scan it…");
        }
      },
      waitForRemotePayload: (kind, signal) => new Promise<string>((resolve, reject) => {
        const existing = remotePayloadWaiterRef.current;
        existing?.reject(new Error("Superseded signaling wait"));
        setAwaitingRemoteKind(kind);
        if (kind === "offer" && !initialOfferPayload) setScreen("scan-join");
        const onAbort = () => {
          if (remotePayloadWaiterRef.current?.kind === kind) {
            remotePayloadWaiterRef.current = null;
          }
          setAwaitingRemoteKind((current) => (current === kind ? null : current));
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        remotePayloadWaiterRef.current = {
          kind,
          resolve: (payload) => {
            signal?.removeEventListener("abort", onAbort);
            remotePayloadWaiterRef.current = null;
            setAwaitingRemoteKind((current) => (current === kind ? null : current));
            resolve(payload);
          },
          reject: (error) => {
            signal?.removeEventListener("abort", onAbort);
            remotePayloadWaiterRef.current = null;
            setAwaitingRemoteKind((current) => (current === kind ? null : current));
            reject(error);
          },
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        if (kind === "offer" && initialOfferPayload && !offerFed) {
          offerFed = true;
          window.queueMicrotask(() => {
            if (remotePayloadWaiterRef.current?.kind === "offer") {
              remotePayloadWaiterRef.current.resolve(initialOfferPayload);
            }
          });
        } else if (kind === "offer") {
          setStatus("Scan the QR shown on the other device.");
        }
      }),
    });

    try {
      const session = new LanPeerSession(adapter, {
        rtcConfig: { iceServers: [] },
      });
      const { peer, channel } = await session.connect(role, code, controller.signal);
      if (controller.signal.aborted) {
        peer.close();
        channel.close();
        return;
      }
      peerRef.current = peer;
      installTransferController(channel);
      channel.addEventListener("close", () => {
        if (!controller.signal.aborted) resetToTabs("Connection closed.");
      }, { once: true });
      clearSignalUi();
      markConnected();
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase("error");
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const submitRemoteSignalPayload = async (payload: string) => {
    const waiter = remotePayloadWaiterRef.current;
    if (!waiter) {
      setStatus("Not waiting for a QR from the other device right now.");
      return;
    }
    const normalized = payload.trim().replace(/\s+/g, "");
    const bundle = await parseLanSignalQrPayload(normalized);
    if (!bundle) {
      setStatus("That QR is not a valid pairing message. Try again.");
      return;
    }
    if (bundle.kind !== waiter.kind) {
      setStatus("That QR is for the other step. Ask them to show the QR they have now, then scan again.");
      return;
    }
    waiter.resolve(normalized);
    setPastePayload("");
  };

  const handleUnifiedScan = async (result: LanScannedPayload) => {
    // If this device is already waiting for a specific signaling QR (host step 2), prefer that.
    if (remotePayloadWaiterRef.current) {
      if (result.kind === "signal") {
        await submitRemoteSignalPayload(result.payload);
        return;
      }
      setStatus("That QR is for the other step. Ask them to show the QR they have now, then scan again.");
      return;
    }

    if (result.kind === "code") {
      await connectPeerjs("joiner", result.code);
      return;
    }

    if (!ENABLE_OFFLINE_QR) {
      setStatus("Offline QR is temporarily unavailable. Use a pairing code instead.");
      return;
    }

    const bundle = await parseLanSignalQrPayload(result.payload);
    if (!bundle) {
      setStatus("That QR is not a valid pairing message.");
      return;
    }
    if (bundle.kind === "answer") {
      setStatus("That QR is a reply. Scan the first QR on the other device instead.");
      return;
    }

    // Joiner cloudless: start with the offer already scanned.
    void startCloudlessSession("joiner", result.payload);
  };

  const sendFile = async (
    file?: File,
    options?: { motionStack?: MotionStackConfig },
  ) => {
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
      await transfer.send(file, controller.signal, {
        motionStack: options?.motionStack,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setPhase("error");
        setStatus(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (sendAbortRef.current === controller) sendAbortRef.current = null;
    }
  };

  const sendOpenedSelection = async (selection: FbxExportSelection) => {
    if (!createOpenedExportFile) {
      setStatus("No opened FBX is available to send.");
      return;
    }
    try {
      const file = createOpenedExportFile(selection);
      await sendFile(file, { motionStack: getMotionStackConfig?.() });
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
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

  const copyText = async (value: string, okMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(okMessage);
    } catch {
      setStatus("Could not copy to the clipboard.");
    }
  };

  const statusBadge = useMemo(() => {
    if (connected) return "Connected";
    if (phase === "error") return "Connection failed";
    if (phase === "waiting") return "Waiting for another device";
    if (phase === "connecting") return "Connecting…";
    return "Not connected";
  }, [connected, phase]);

  const characterLabel = shortName(characterFileName, "character");
  const animationLabel = shortName(animationFileName || characterFileName, "animation");

  const showTabsChrome =
    ENABLE_OFFLINE_QR
    && !connected
    && (screen === "tabs" || screen === "code-host" || screen === "cloudless-show");

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
        <div className="lan-pairing-panel" role="dialog" aria-label="LAN transfer">
          <div className="lan-pairing-header">
            <div>
              <h2 className="typo-title">LAN Transfer</h2>
              <p className="typo-secondary">
                Connect another device on the same local network.
              </p>
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
            <div className={`lan-pairing-status is-${phase}${busy ? " is-ready" : ""}`}>
              <span className="lan-pairing-status-badge">{statusBadge}</span>
              {connected && peerName ? <p>{`Connected to ${peerName}`}</p> : null}
              {!connected && status !== statusBadge ? (
                <p className="lan-pairing-status-detail">{status}</p>
              ) : null}
            </div>

            {showTabsChrome ? (
              <div className="lan-pairing-tabs" role="tablist" aria-label="Pairing method">
                <button
                  type="button"
                  role="tab"
                  aria-selected={methodTab === "code"}
                  className={`lan-pairing-tab ${methodTab === "code" ? "is-active" : ""}`}
                  disabled={busy && methodTab !== "code"}
                  onClick={() => {
                    if (busy) return;
                    setMethodTab("code");
                    if (screen !== "code-host") setScreen("tabs");
                  }}
                >
                  Pairing code
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={methodTab === "cloudless"}
                  className={`lan-pairing-tab ${methodTab === "cloudless" ? "is-active" : ""}`}
                  disabled={busy && methodTab !== "cloudless"}
                  onClick={() => {
                    if (busy) return;
                    setMethodTab("cloudless");
                    if (screen !== "cloudless-show") setScreen("tabs");
                  }}
                >
                  Offline QR
                </button>
              </div>
            ) : null}

            {!connected && methodTab === "code" && (screen === "tabs" || screen === "code-host") ? (
              <div className="lan-pairing-tab-panel">
                {screen === "code-host" ? (
                  <div className="lan-pairing-code-card">
                    <strong className="lan-pairing-section-title typo-section">Show this pairing code</strong>
                    <strong className="lan-pairing-code typo-code">{pairingId}</strong>
                    <LanPairingQrCode code={pairingId} />
                    <p className="lan-pairing-hint typo-secondary">
                      On the other device, scan or enter this code.
                    </p>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      onClick={() => void copyText(pairingId, "Pairing code copied.")}
                    >
                      Copy code
                    </button>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      onClick={() => {
                        resetToTabs("Not connected");
                        void connectPeerjs("host", makeLanPairingId());
                      }}
                    >
                      Generate new code
                    </button>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      onClick={() => resetToTabs("Not connected")}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      className="primary-button lan-pairing-full"
                      disabled={busy}
                      onClick={() => void connectPeerjs("host", makeLanPairingId())}
                    >
                      Create pairing code
                    </button>

                    <div className="lan-pairing-connect-block">
                      <strong className="lan-pairing-section-title typo-section">Connect to another device</strong>
                      <button
                        type="button"
                        className="secondary-button lan-pairing-full"
                        disabled={busy}
                        onClick={() => {
                          setPastePayload("");
                          setManualCode("");
                          setScreen("scan-join");
                          setPhase("idle");
                          setStatus("Not connected");
                        }}
                      >
                        Scan pairing code
                      </button>
                      <label className="lan-pairing-field">
                        <span className="lan-pairing-label">or enter a pairing code</span>
                        <input
                          className="lan-pairing-input"
                          value={manualCode}
                          onChange={(event) => setManualCode(event.target.value.toUpperCase())}
                          disabled={busy}
                          placeholder="e.g. 95A542"
                          spellCheck={false}
                          autoCapitalize="characters"
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary-button lan-pairing-full"
                        disabled={busy || !manualCode.trim()}
                        onClick={() => void connectPeerjs("joiner", manualCode)}
                      >
                        Connect
                      </button>
                    </div>

                    <p className="lan-pairing-hint typo-secondary">
                      FBX files transfer directly between devices.
                    </p>
                  </>
                )}
              </div>
            ) : null}

            {!connected && methodTab === "cloudless" && ENABLE_OFFLINE_QR && (screen === "tabs" || screen === "cloudless-show") ? (
              <div className="lan-pairing-tab-panel">
                {screen === "cloudless-show" && localSignalPayload ? (
                  <div className="lan-pairing-code-card">
                    <strong className="lan-pairing-section-title typo-section">Show this QR</strong>
                    <LanPairingQrCode payload={localSignalPayload} errorCorrectionLevel="L" />
                    <p className="lan-pairing-hint typo-secondary">
                      Usually the computer shows; the phone taps Scan to join. Do not scan this on this device.
                    </p>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      onClick={() => void copyText(localSignalPayload, "QR payload copied.")}
                    >
                      Copy QR text
                    </button>
                    {awaitingRemoteKind === "answer" ? (
                      <button
                        type="button"
                        className="primary-button lan-pairing-full"
                        onClick={() => {
                          setScreen("cloudless-scan-reply");
                          setStatus("Scan the QR now shown on the other device.");
                        }}
                      >
                        They scanned it — continue
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      onClick={() => resetToTabs("Not connected")}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="lan-pairing-hint typo-secondary">
                      No pairing service. Two QR exchanges. Usually the computer shows first; the phone only taps Scan to join.
                    </p>
                    <button
                      type="button"
                      className="primary-button lan-pairing-full"
                      disabled={busy}
                      onClick={() => void startCloudlessSession("host")}
                    >
                      Show a QR
                    </button>
                  </>
                )}
              </div>
            ) : null}

            {!connected && ENABLE_OFFLINE_QR && screen === "cloudless-scan-reply" ? (
              <div className="lan-pairing-signal-scan">
                <strong className="lan-pairing-section-title typo-section">Scan their QR</strong>
                <p className="lan-pairing-hint typo-secondary">
                  Scan the new QR on the other device — not the one you showed earlier.
                </p>
                <LanPairingQrScanner
                  mode="signal"
                  onSignal={(payload) => {
                    void submitRemoteSignalPayload(payload);
                  }}
                />
                <label className="lan-pairing-field">
                  <span className="lan-pairing-label">Or paste their QR text</span>
                  <textarea
                    className="lan-pairing-input lan-pairing-textarea"
                    value={pastePayload}
                    onChange={(event) => setPastePayload(event.target.value)}
                    rows={3}
                    spellCheck={false}
                  />
                </label>
                <div className="lan-pairing-button-row">
                  <button
                    type="button"
                    className="primary-button lan-pairing-full"
                    disabled={!pastePayload.trim()}
                    onClick={() => void submitRemoteSignalPayload(pastePayload)}
                  >
                    Connect
                  </button>
                  <button
                    type="button"
                    className="secondary-button lan-pairing-full"
                    onClick={() => {
                      setScreen("cloudless-show");
                      setStatus("Show this QR to the other device again.");
                    }}
                  >
                    Back to my QR
                  </button>
                  <button
                    type="button"
                    className="secondary-button lan-pairing-full"
                    onClick={() => resetToTabs("Not connected")}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}

            {!connected && ENABLE_OFFLINE_QR && screen === "cloudless-show-reply" && localSignalPayload ? (
              <div className="lan-pairing-code-card">
                <strong className="lan-pairing-section-title typo-section">Show this QR</strong>
                <LanPairingQrCode payload={localSignalPayload} errorCorrectionLevel="L" />
                <p className="lan-pairing-hint typo-secondary">
                  Hold this up for the other device. Waiting for them to scan…
                </p>
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  onClick={() => void copyText(localSignalPayload, "QR payload copied.")}
                >
                  Copy QR text
                </button>
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  onClick={() => resetToTabs("Not connected")}
                >
                  Cancel
                </button>
              </div>
            ) : null}

            {!connected && screen === "scan-join" ? (
              <div className="lan-pairing-signal-scan">
                <strong className="lan-pairing-section-title typo-section">Scan to connect</strong>
                <p className="lan-pairing-hint typo-secondary">
                  Scan the pairing code shown on the other device.
                </p>
                <LanPairingQrScanner
                  mode={ENABLE_OFFLINE_QR ? "auto" : "code"}
                  onScan={(result) => {
                    void handleUnifiedScan(result);
                  }}
                />
                <label className="lan-pairing-field">
                  <span className="lan-pairing-label">or enter a pairing code</span>
                  <input
                    className="lan-pairing-input"
                    value={pastePayload}
                    onChange={(event) => setPastePayload(event.target.value.toUpperCase())}
                    disabled={busy}
                    placeholder="e.g. 95A542"
                    spellCheck={false}
                    autoCapitalize="characters"
                  />
                </label>
                <div className="lan-pairing-button-row">
                  <button
                    type="button"
                    className="primary-button lan-pairing-full"
                    disabled={!pastePayload.trim() || busy}
                    onClick={() => {
                      const classified = classifyLanQrPayload(pastePayload);
                      if (!classified || classified.kind !== "code") {
                        setStatus("That pairing code is not valid.");
                        return;
                      }
                      void handleUnifiedScan(classified);
                    }}
                  >
                    Connect
                  </button>
                  <button
                    type="button"
                    className="secondary-button lan-pairing-full"
                    onClick={() => resetToTabs("Not connected")}
                  >
                    Back
                  </button>
                </div>
              </div>
            ) : null}

            {!connected && ENABLE_OFFLINE_QR && screen !== "scan-join" && screen !== "cloudless-scan-reply" && screen !== "cloudless-show-reply" && screen !== "code-host" ? (
              <div className="lan-pairing-join-footer">
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  disabled={busy && screen !== "tabs"}
                  onClick={() => {
                    if (busy && screen !== "tabs") return;
                    setPastePayload("");
                    setScreen("scan-join");
                    setPhase("idle");
                    setStatus("Not connected");
                  }}
                >
                  Scan pairing code
                </button>
              </div>
            ) : null}

            {connected ? (
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
                {canSendOpened ? (
                  <div className="lan-pairing-send-opened">
                    <strong className="lan-pairing-section-title typo-section">Send opened assets</strong>
                    <p className="lan-pairing-hint typo-secondary">
                      Includes current Tools modifier settings. Pose Warp target FBX must be reloaded on the other device.
                    </p>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      disabled={transferActive || !canSendCharacter}
                      title={canSendCharacter ? `Send character (${characterLabel})` : undefined}
                      onClick={() => void sendOpenedSelection({ character: true, animation: false })}
                    >
                      <span className="lan-pairing-send-label">Send character</span>
                      {canSendCharacter ? (
                        <span className="lan-pairing-send-name">{characterLabel}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="secondary-button lan-pairing-full"
                      disabled={transferActive || !canSendAnimation}
                      title={canSendAnimation ? `Send animation (${animationLabel})` : undefined}
                      onClick={() => void sendOpenedSelection({ character: false, animation: true })}
                    >
                      <span className="lan-pairing-send-label">Send animation</span>
                      {canSendAnimation ? (
                        <span className="lan-pairing-send-name">{animationLabel}</span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="primary-button lan-pairing-full"
                      disabled={transferActive || !canSendCharacter || !canSendAnimation}
                      onClick={() => void sendOpenedSelection({ character: true, animation: true })}
                    >
                      Send character + animation
                    </button>
                  </div>
                ) : (
                  <p className="lan-pairing-hint typo-secondary">
                    Open a character or animation first, or pick an FBX from disk.
                  </p>
                )}
                <button
                  type="button"
                  className="secondary-button lan-pairing-full"
                  disabled={transferActive}
                  onClick={() => sendFileInputRef.current?.click()}
                >
                  Send FBX from disk
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
                  onClick={() => resetToTabs("Not connected")}
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
