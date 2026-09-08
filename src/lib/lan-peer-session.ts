import {
  createLanSignalBundle,
  type LanSignalBundle,
  type LanSignalingAdapter,
} from "./lan-signaling.js";

export type LanPeerRole = "host" | "joiner";

export type LanPeerSessionOptions = {
  rtcConfig?: RTCConfiguration;
  channelLabel?: string;
  peerFactory?: (config?: RTCConfiguration) => RTCPeerConnection;
};

export type LanPeerSessionResult = {
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
};

const DEFAULT_CHANNEL_LABEL = "fbx-transfer";

function candidateToInit(candidate: RTCIceCandidate): RTCIceCandidateInit {
  const json = candidate.toJSON();
  return {
    candidate: json.candidate ?? "",
    sdpMid: json.sdpMid ?? null,
    sdpMLineIndex: json.sdpMLineIndex ?? null,
    usernameFragment: json.usernameFragment ?? null,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

async function waitForIceGatheringComplete(peer: RTCPeerConnection, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (peer.iceGatheringState === "complete") return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener("icegatheringstatechange", onState);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      cleanup();
      fn();
    };
    const onState = () => {
      if (peer.iceGatheringState === "complete") finish(resolve);
    };
    const onAbort = () => finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
    peer.addEventListener("icegatheringstatechange", onState);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function localBundle(
  kind: "offer" | "answer",
  peer: RTCPeerConnection,
  candidates: readonly RTCIceCandidateInit[],
): LanSignalBundle {
  if (!peer.localDescription) throw new Error("local description is not available");
  return createLanSignalBundle(kind, peer.localDescription, candidates);
}

async function applyRemoteBundle(peer: RTCPeerConnection, bundle: LanSignalBundle): Promise<void> {
  await peer.setRemoteDescription(bundle.description);
  for (const candidate of bundle.candidates) {
    await peer.addIceCandidate(candidate);
  }
}

function createRemoteChannelPromise(peer: RTCPeerConnection, signal?: AbortSignal): Promise<RTCDataChannel> {
  return new Promise<RTCDataChannel>((resolve, reject) => {
    const cleanup = () => {
      peer.removeEventListener("datachannel", onChannel as EventListener);
      signal?.removeEventListener("abort", onAbort);
    };
    const finishResolve = (channel: RTCDataChannel) => {
      cleanup();
      resolve(channel);
    };
    const finishReject = (error: unknown) => {
      cleanup();
      reject(error);
    };
    const onChannel = (event: RTCDataChannelEvent) => finishResolve(event.channel);
    const onAbort = () => finishReject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    peer.addEventListener("datachannel", onChannel as EventListener, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class LanPeerSession {
  private readonly adapter: LanSignalingAdapter;
  private readonly rtcConfig?: RTCConfiguration;
  private readonly channelLabel: string;
  private readonly peerFactory: (config?: RTCConfiguration) => RTCPeerConnection;

  constructor(adapter: LanSignalingAdapter, options: LanPeerSessionOptions = {}) {
    this.adapter = adapter;
    this.rtcConfig = options.rtcConfig;
    this.channelLabel = options.channelLabel ?? DEFAULT_CHANNEL_LABEL;
    this.peerFactory = options.peerFactory ?? ((config) => new RTCPeerConnection(config));
  }

  async connect(role: LanPeerRole, pairingId: string, signal?: AbortSignal): Promise<LanPeerSessionResult> {
    if (!pairingId.trim()) throw new Error("pairingId is required");
    throwIfAborted(signal);
    return role === "host"
      ? this.connectAsHost(pairingId, signal)
      : this.connectAsJoiner(pairingId, signal);
  }

  private async connectAsHost(pairingId: string, signal?: AbortSignal): Promise<LanPeerSessionResult> {
    const peer = this.peerFactory(this.rtcConfig);
    const candidates: RTCIceCandidateInit[] = [];
    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) candidates.push(candidateToInit(event.candidate));
    });

    try {
      const channel = peer.createDataChannel(this.channelLabel, { ordered: true });
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIceGatheringComplete(peer, signal);
      await this.adapter.publish(pairingId, localBundle("offer", peer, candidates), signal);
      const answer = await this.adapter.waitForRemote(pairingId, "answer", signal);
      await applyRemoteBundle(peer, answer);
      return { peer, channel };
    } catch (error) {
      peer.close();
      throw error;
    }
  }

  private async connectAsJoiner(pairingId: string, signal?: AbortSignal): Promise<LanPeerSessionResult> {
    const peer = this.peerFactory(this.rtcConfig);
    const candidates: RTCIceCandidateInit[] = [];
    peer.addEventListener("icecandidate", (event) => {
      if (event.candidate) candidates.push(candidateToInit(event.candidate));
    });
    const channelPromise = createRemoteChannelPromise(peer, signal);

    try {
      const offer = await this.adapter.waitForRemote(pairingId, "offer", signal);
      await applyRemoteBundle(peer, offer);
      await peer.setLocalDescription(await peer.createAnswer());
      await waitForIceGatheringComplete(peer, signal);
      await this.adapter.publish(pairingId, localBundle("answer", peer, candidates), signal);
      const channel = await channelPromise;
      return { peer, channel };
    } catch (error) {
      peer.close();
      throw error;
    }
  }
}
