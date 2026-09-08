import {
  DEFAULT_LAN_CHUNK_SIZE,
  LAN_TRANSFER_PROTOCOL_VERSION,
  LanTransferReassembler,
  chunkBlob,
  createLanTransferOffer,
  encodeLanChunkFrame,
  type LanTransferOffer,
  type LanTransferProgress,
  waitForLanBackpressure,
} from "./lan-transfer-protocol.js";

const CONTROL_VERSION = 1;

type OfferControl = {
  kind: "fbx-transfer-offer";
  version: typeof CONTROL_VERSION;
  offer: LanTransferOffer;
};

type CancelControl = {
  kind: "fbx-transfer-cancel";
  version: typeof CONTROL_VERSION;
  transferId: string;
  reason?: string;
};

type CompleteControl = {
  kind: "fbx-transfer-complete";
  version: typeof CONTROL_VERSION;
  transferId: string;
};

type TransferControl = OfferControl | CancelControl | CompleteControl;

type PendingAck = {
  resolve: () => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
};

export type LanFileTransferState =
  | { phase: "sending"; fileName: string; transferId: string; awaitingAck?: boolean }
  | { phase: "receiving"; fileName: string; transferId: string }
  | { phase: "completed"; fileName: string; transferId: string; direction: "send" | "receive" }
  | { phase: "cancelled"; fileName?: string; transferId?: string; reason: string }
  | { phase: "peer_closed"; reason: string };

export type LanFileTransferCallbacks = {
  onSendProgress?: (progress: LanTransferProgress) => void;
  onReceiveProgress?: (progress: LanTransferProgress) => void;
  onReceiveFile?: (file: File) => void | Promise<void>;
  onState?: (state: LanFileTransferState) => void;
  onError?: (error: Error) => void;
};

export type LanFileTransferOptions = {
  chunkSize?: number;
  maxBufferedAmount?: number;
};

function serializeControl(control: TransferControl): string {
  return JSON.stringify(control);
}

function parseControl(serialized: string): TransferControl {
  const raw = JSON.parse(serialized) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("LAN transfer control must be an object");
  }

  const record = raw as Record<string, unknown>;
  if (record.version !== CONTROL_VERSION) {
    throw new Error("LAN transfer control version is unsupported");
  }

  if (record.kind === "fbx-transfer-offer") {
    const offer = record.offer as LanTransferOffer | undefined;
    if (!offer || typeof offer !== "object") {
      throw new Error("LAN transfer offer is missing");
    }
    if (offer.version !== LAN_TRANSFER_PROTOCOL_VERSION) {
      throw new Error("LAN transfer offer version is unsupported");
    }
    // Constructor performs the full consistency validation.
    new LanTransferReassembler(offer);
    return { kind: "fbx-transfer-offer", version: CONTROL_VERSION, offer };
  }

  if (record.kind === "fbx-transfer-cancel") {
    if (typeof record.transferId !== "string" || !record.transferId) {
      throw new Error("LAN transfer cancel transferId is invalid");
    }
    if (typeof record.reason !== "undefined" && typeof record.reason !== "string") {
      throw new Error("LAN transfer cancel reason is invalid");
    }
    return {
      kind: "fbx-transfer-cancel",
      version: CONTROL_VERSION,
      transferId: record.transferId,
      reason: record.reason as string | undefined,
    };
  }

  if (record.kind === "fbx-transfer-complete") {
    if (typeof record.transferId !== "string" || !record.transferId) {
      throw new Error("LAN transfer complete transferId is invalid");
    }
    return {
      kind: "fbx-transfer-complete",
      version: CONTROL_VERSION,
      transferId: record.transferId,
    };
  }

  throw new Error("LAN transfer control kind is unsupported");
}

function createTransferId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `fbx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function abortError(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Transfer cancelled", "AbortError");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

export class LanFileTransferController {
  private receiver: LanTransferReassembler | null = null;
  private disposed = false;
  private readonly chunkSize: number;
  private readonly maxBufferedAmount: number;
  private readonly pendingAcks = new Map<string, PendingAck>();
  private readonly receivedAcks = new Set<string>();

  constructor(
    private readonly channel: RTCDataChannel,
    private readonly callbacks: LanFileTransferCallbacks = {},
    options: LanFileTransferOptions = {},
  ) {
    this.chunkSize = options.chunkSize ?? DEFAULT_LAN_CHUNK_SIZE;
    this.maxBufferedAmount = options.maxBufferedAmount ?? 1024 * 1024;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", this.onMessage);
    channel.addEventListener("close", this.onClose);
    channel.addEventListener("error", this.onChannelError);
  }

  async send(file: File, signal?: AbortSignal): Promise<void> {
    this.ensureUsable();
    if (signal?.aborted) throw abortError(signal);

    const transferId = createTransferId();
    const offer = createLanTransferOffer(file, transferId, this.chunkSize);
    this.callbacks.onState?.({ phase: "sending", fileName: offer.name, transferId });

    try {
      this.channel.send(serializeControl({
        kind: "fbx-transfer-offer",
        version: CONTROL_VERSION,
        offer,
      }));

      let sentBytes = 0;
      let sentChunks = 0;
      this.callbacks.onSendProgress?.({
        receivedBytes: 0,
        receivedChunks: 0,
        totalBytes: offer.size,
        totalChunks: offer.totalChunks,
      });

      for await (const chunk of chunkBlob(file, offer.chunkSize)) {
        if (signal?.aborted) throw abortError(signal);
        await waitForLanBackpressure(this.channel, this.maxBufferedAmount, signal);
        if (signal?.aborted) throw abortError(signal);

        this.channel.send(encodeLanChunkFrame(offer.transferId, chunk.index, chunk.bytes));
        sentBytes += chunk.bytes.byteLength;
        sentChunks += 1;
        this.callbacks.onSendProgress?.({
          receivedBytes: sentBytes,
          receivedChunks: sentChunks,
          totalBytes: offer.size,
          totalChunks: offer.totalChunks,
        });
      }

      this.callbacks.onState?.({
        phase: "sending",
        fileName: offer.name,
        transferId,
        awaitingAck: true,
      });
      await this.waitForCompleteAck(transferId, signal);
      this.callbacks.onState?.({ phase: "completed", fileName: offer.name, transferId, direction: "send" });
    } catch (error) {
      this.rejectPendingAck(transferId, error);
      if (signal?.aborted || isAbortError(error)) {
        this.sendCancel(transferId, "Cancelled by sender");
        this.callbacks.onState?.({
          phase: "cancelled",
          fileName: offer.name,
          transferId,
          reason: "Cancelled by sender",
        });
      } else {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    }
  }

  cancelReceive(reason = "Cancelled by receiver"): void {
    const receiver = this.receiver;
    if (!receiver) return;
    this.receiver = null;
    this.sendCancel(receiver.offer.transferId, reason);
    this.callbacks.onState?.({
      phase: "cancelled",
      fileName: receiver.offer.name,
      transferId: receiver.offer.transferId,
      reason,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.receiver = null;
    this.receivedAcks.clear();
    for (const [transferId, pending] of this.pendingAcks) {
      pending.cleanup();
      pending.reject(new Error(`LAN transfer controller disposed while waiting for ${transferId}`));
    }
    this.pendingAcks.clear();
    this.channel.removeEventListener("message", this.onMessage);
    this.channel.removeEventListener("close", this.onClose);
    this.channel.removeEventListener("error", this.onChannelError);
  }

  private ensureUsable(): void {
    if (this.disposed) throw new Error("LAN transfer controller is disposed");
    if (this.channel.readyState !== "open") {
      throw new Error(`data channel is ${this.channel.readyState}`);
    }
  }

  private sendCancel(transferId: string, reason: string): void {
    if (this.channel.readyState !== "open") return;
    this.channel.send(serializeControl({
      kind: "fbx-transfer-cancel",
      version: CONTROL_VERSION,
      transferId,
      reason,
    }));
  }

  private sendComplete(transferId: string): void {
    if (this.channel.readyState !== "open") return;
    this.channel.send(serializeControl({
      kind: "fbx-transfer-complete",
      version: CONTROL_VERSION,
      transferId,
    }));
  }

  private waitForCompleteAck(transferId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.receivedAcks.delete(transferId)) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const existing = this.pendingAcks.get(transferId);
      if (existing) {
        existing.cleanup();
        existing.reject(new Error(`Superseded acknowledgment waiter for ${transferId}`));
      }

      const onAbort = () => {
        cleanup();
        this.pendingAcks.delete(transferId);
        reject(abortError(signal));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      this.pendingAcks.set(transferId, {
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      signal?.addEventListener("abort", onAbort, { once: true });

      // Ack may land between the early-ack check and waiter registration.
      if (this.receivedAcks.delete(transferId)) {
        const pending = this.pendingAcks.get(transferId);
        if (pending) {
          this.pendingAcks.delete(transferId);
          pending.resolve();
        }
      }
    });
  }

  private resolvePendingAck(transferId: string): boolean {
    const pending = this.pendingAcks.get(transferId);
    if (pending) {
      this.pendingAcks.delete(transferId);
      pending.resolve();
      return true;
    }
    this.receivedAcks.add(transferId);
    return true;
  }

  private rejectPendingAck(transferId: string, error: unknown): void {
    this.receivedAcks.delete(transferId);
    const pending = this.pendingAcks.get(transferId);
    if (!pending) return;
    this.pendingAcks.delete(transferId);
    pending.reject(error);
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.disposed) return;
    if (typeof event.data === "string") {
      try {
        this.handleControl(parseControl(event.data));
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    void this.handleBinary(event.data);
  };

  private handleControl(control: TransferControl): void {
    if (control.kind === "fbx-transfer-complete") {
      this.resolvePendingAck(control.transferId);
      return;
    }

    if (control.kind === "fbx-transfer-cancel") {
      this.rejectPendingAck(
        control.transferId,
        new DOMException(control.reason || "Cancelled by peer", "AbortError"),
      );
      if (this.receiver?.offer.transferId === control.transferId) {
        const fileName = this.receiver.offer.name;
        this.receiver = null;
        this.callbacks.onState?.({
          phase: "cancelled",
          fileName,
          transferId: control.transferId,
          reason: control.reason || "Cancelled by peer",
        });
      }
      return;
    }

    if (this.receiver) {
      this.sendCancel(control.offer.transferId, "Receiver is already handling another FBX");
      this.callbacks.onError?.(new Error("Received a second FBX transfer while another transfer is active"));
      return;
    }

    this.receiver = new LanTransferReassembler(control.offer);
    this.callbacks.onState?.({
      phase: "receiving",
      fileName: control.offer.name,
      transferId: control.offer.transferId,
    });
    this.callbacks.onReceiveProgress?.(this.receiver.progress);

    if (control.offer.totalChunks === 0) {
      void this.finishReceive(this.receiver);
    }
  }

  private async handleBinary(data: unknown): Promise<void> {
    const receiver = this.receiver;
    if (!receiver) {
      this.callbacks.onError?.(new Error("Received FBX chunk bytes without an active transfer offer"));
      return;
    }

    let frame: ArrayBuffer | ArrayBufferView;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      frame = data;
    } else if (data instanceof Blob) {
      frame = await data.arrayBuffer();
    } else {
      this.callbacks.onError?.(new Error("Received unsupported FBX chunk payload type"));
      return;
    }

    try {
      const progress = receiver.push(frame);
      this.callbacks.onReceiveProgress?.(progress);
      if (receiver.isComplete()) {
        await this.finishReceive(receiver);
      }
    } catch (error) {
      this.receiver = null;
      this.sendCancel(receiver.offer.transferId, "Receiver rejected transfer data");
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async finishReceive(receiver: LanTransferReassembler): Promise<void> {
    if (this.receiver !== receiver) return;
    this.receiver = null;

    const blob = receiver.toBlob();
    const file = new File([blob], receiver.offer.name, {
      type: receiver.offer.mimeType,
      lastModified: Date.now(),
    });

    // Acknowledge receipt as soon as bytes are reassembled so the sender can complete
    // without waiting for local FBX routing/opening.
    this.sendComplete(receiver.offer.transferId);

    try {
      await this.callbacks.onReceiveFile?.(file);
      this.callbacks.onState?.({
        phase: "completed",
        fileName: receiver.offer.name,
        transferId: receiver.offer.transferId,
        direction: "receive",
      });
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readonly onClose = (): void => {
    const fileName = this.receiver?.offer.name;
    const transferId = this.receiver?.offer.transferId;
    this.receiver = null;
    this.receivedAcks.clear();
    for (const [pendingId, pending] of this.pendingAcks) {
      pending.cleanup();
      pending.reject(new Error(`Peer disconnected while waiting for transfer acknowledgment (${pendingId})`));
    }
    this.pendingAcks.clear();
    this.callbacks.onState?.({
      phase: "peer_closed",
      reason: fileName && transferId
        ? `Peer disconnected while receiving ${fileName} (${transferId})`
        : "Peer connection closed",
    });
  };

  private readonly onChannelError = (): void => {
    this.callbacks.onError?.(new Error("LAN data channel reported an error"));
  };
}
