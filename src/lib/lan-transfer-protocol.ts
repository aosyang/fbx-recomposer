export const LAN_TRANSFER_PROTOCOL_VERSION = 1;
export const DEFAULT_LAN_CHUNK_SIZE = 64 * 1024;

const FRAME_MAGIC = 0x4642584c; // "FBXL"
const FIXED_HEADER_BYTES = 16;

export type LanTransferOffer = {
  kind: "offer";
  version: typeof LAN_TRANSFER_PROTOCOL_VERSION;
  transferId: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
};

export type LanTransferProgress = {
  receivedBytes: number;
  receivedChunks: number;
  totalBytes: number;
  totalChunks: number;
};

export type DecodedLanChunk = {
  transferId: string;
  index: number;
  payload: Uint8Array;
};

export function createLanTransferOffer(
  file: Pick<File, "name" | "size" | "type">,
  transferId: string,
  chunkSize = DEFAULT_LAN_CHUNK_SIZE,
): LanTransferOffer {
  if (!transferId) throw new Error("transferId is required");
  if (!file.name.toLowerCase().endsWith(".fbx")) throw new Error("LAN transfer only accepts .fbx files");
  if (!Number.isSafeInteger(file.size) || file.size < 0) throw new Error("file size is invalid");
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("chunkSize must be a positive integer");

  return {
    kind: "offer",
    version: LAN_TRANSFER_PROTOCOL_VERSION,
    transferId,
    name: file.name,
    size: file.size,
    mimeType: file.type || "application/octet-stream",
    chunkSize,
    totalChunks: Math.ceil(file.size / chunkSize),
  };
}

export function encodeLanChunkFrame(transferId: string, index: number, payload: Uint8Array): ArrayBuffer {
  if (!transferId) throw new Error("transferId is required");
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("chunk index must be a non-negative integer");

  const idBytes = new TextEncoder().encode(transferId);
  if (idBytes.byteLength > 0xffff) throw new Error("transferId is too long");
  const output = new Uint8Array(FIXED_HEADER_BYTES + idBytes.byteLength + payload.byteLength);
  const view = new DataView(output.buffer);
  view.setUint32(0, FRAME_MAGIC);
  view.setUint8(4, LAN_TRANSFER_PROTOCOL_VERSION);
  view.setUint8(5, 0);
  view.setUint16(6, idBytes.byteLength);
  view.setUint32(8, index);
  view.setUint32(12, payload.byteLength);
  output.set(idBytes, FIXED_HEADER_BYTES);
  output.set(payload, FIXED_HEADER_BYTES + idBytes.byteLength);
  return output.buffer;
}

export function decodeLanChunkFrame(frame: ArrayBuffer | ArrayBufferView): DecodedLanChunk {
  const bytes = frame instanceof ArrayBuffer
    ? new Uint8Array(frame)
    : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);

  if (bytes.byteLength < FIXED_HEADER_BYTES) throw new Error("chunk frame is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== FRAME_MAGIC) throw new Error("chunk frame magic is invalid");
  if (view.getUint8(4) !== LAN_TRANSFER_PROTOCOL_VERSION) throw new Error("chunk frame version is unsupported");

  const idLength = view.getUint16(6);
  const index = view.getUint32(8);
  const payloadLength = view.getUint32(12);
  const expectedLength = FIXED_HEADER_BYTES + idLength + payloadLength;
  if (bytes.byteLength !== expectedLength) throw new Error("chunk frame length does not match its header");

  const transferId = new TextDecoder().decode(bytes.subarray(FIXED_HEADER_BYTES, FIXED_HEADER_BYTES + idLength));
  if (!transferId) throw new Error("chunk frame transferId is empty");

  return {
    transferId,
    index,
    payload: bytes.slice(FIXED_HEADER_BYTES + idLength),
  };
}

export class LanTransferReassembler {
  private readonly chunks = new Map<number, Uint8Array>();
  private receivedBytes = 0;

  constructor(readonly offer: LanTransferOffer) {
    if (offer.version !== LAN_TRANSFER_PROTOCOL_VERSION) throw new Error("offer version is unsupported");
    if (!offer.name.toLowerCase().endsWith(".fbx")) throw new Error("offer name must end with .fbx");
    if (!Number.isSafeInteger(offer.size) || offer.size < 0) throw new Error("offer size is invalid");
    if (!Number.isSafeInteger(offer.chunkSize) || offer.chunkSize <= 0) throw new Error("offer chunkSize is invalid");
    if (offer.totalChunks !== Math.ceil(offer.size / offer.chunkSize)) throw new Error("offer totalChunks is inconsistent");
  }

  get progress(): LanTransferProgress {
    return {
      receivedBytes: this.receivedBytes,
      receivedChunks: this.chunks.size,
      totalBytes: this.offer.size,
      totalChunks: this.offer.totalChunks,
    };
  }

  push(frame: ArrayBuffer | ArrayBufferView): LanTransferProgress {
    const chunk = decodeLanChunkFrame(frame);
    if (chunk.transferId !== this.offer.transferId) throw new Error("chunk belongs to a different transfer");
    if (chunk.index >= this.offer.totalChunks) throw new Error("chunk index is outside the offer");
    if (this.chunks.has(chunk.index)) throw new Error("duplicate chunk");

    const expectedSize = chunk.index === this.offer.totalChunks - 1
      ? this.offer.size - chunk.index * this.offer.chunkSize
      : this.offer.chunkSize;
    if (chunk.payload.byteLength !== expectedSize) throw new Error("chunk payload size is inconsistent with the offer");

    this.chunks.set(chunk.index, chunk.payload);
    this.receivedBytes += chunk.payload.byteLength;
    return this.progress;
  }

  isComplete(): boolean {
    return this.chunks.size === this.offer.totalChunks && this.receivedBytes === this.offer.size;
  }

  toBlob(): Blob {
    if (!this.isComplete()) throw new Error("transfer is incomplete");
    const parts: ArrayBuffer[] = [];
    for (let index = 0; index < this.offer.totalChunks; index += 1) {
      const chunk = this.chunks.get(index);
      if (!chunk) throw new Error(`missing chunk ${index}`);
      const copy = new Uint8Array(chunk.byteLength);
      copy.set(chunk);
      parts.push(copy.buffer);
    }
    return new Blob(parts, { type: this.offer.mimeType });
  }
}

export async function* chunkBlob(
  blob: Blob,
  chunkSize = DEFAULT_LAN_CHUNK_SIZE,
): AsyncGenerator<{ index: number; bytes: Uint8Array }> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new Error("chunkSize must be a positive integer");
  let index = 0;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
    yield { index, bytes };
    index += 1;
  }
}

export async function waitForLanBackpressure(
  channel: RTCDataChannel,
  maxBufferedAmount = 1024 * 1024,
  signal?: AbortSignal,
): Promise<void> {
  if (channel.readyState !== "open") throw new Error(`data channel is ${channel.readyState}`);
  if (channel.bufferedAmount <= maxBufferedAmount) return;
  channel.bufferedAmountLowThreshold = Math.max(0, Math.floor(maxBufferedAmount / 2));

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      channel.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    };
    const onLow = () => settle(resolve);
    const onClose = () => settle(() => reject(new Error("data channel closed while waiting for backpressure")));
    const onError = () => settle(() => reject(new Error("data channel errored while waiting for backpressure")));
    const onAbort = () => settle(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));

    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose, { once: true });
    channel.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });

    // Buffer may drain between the initial check and listener registration.
    if (channel.bufferedAmount <= maxBufferedAmount) settle(resolve);
  });
}
