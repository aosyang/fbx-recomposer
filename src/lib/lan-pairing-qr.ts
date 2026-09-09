import jsQR from "jsqr";
import { isLanSignalQrPayload } from "./lan-qr-signaling.js";

const PAIRING_QR_PREFIX = "fbx-lan-pair:";

export type LanScannedPayload =
  | { kind: "code"; code: string }
  | { kind: "signal"; payload: string };

export function encodeLanPairingQrPayload(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error("pairing code is required");
  // Keep the payload short so phone photos of a screen decode reliably.
  return normalized;
}

export function parseLanPairingQrPayload(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return null;
  if (isLanSignalQrPayload(text)) return null;

  const prefixed = new RegExp(`^${PAIRING_QR_PREFIX}([A-Z0-9]{4,32})$`, "i").exec(text);
  if (prefixed?.[1]) return prefixed[1].toUpperCase();

  if (/^[A-Z0-9]{4,16}$/i.test(text)) return text.toUpperCase();
  return null;
}

/** Classify pasted/scanned text as a short pairing code or offline signaling QR. */
export function classifyLanQrPayload(raw: string): LanScannedPayload | null {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return null;
  if (isLanSignalQrPayload(text)) return { kind: "signal", payload: text };
  const code = parseLanPairingQrPayload(text);
  if (code) return { kind: "code", code };
  return null;
}

export function decodeLanQrFromImageData(image: ImageData): string | null {
  if (!image.width || !image.height || image.data.length !== image.width * image.height * 4) {
    return null;
  }

  const attempts = ["attemptBoth", "dontInvert"] as const;
  for (const inversionAttempts of attempts) {
    try {
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts });
      if (result?.data) return result.data;
    } catch {
      // jsQR can throw on malformed/partial detections; try the next strategy.
    }
  }
  return null;
}

function decodeBitmapRegionRaw(
  bitmap: ImageBitmap,
  crop: number,
  targetLongSide: number,
): string | null {
  const sourceWidth = bitmap.width;
  const sourceHeight = bitmap.height;
  if (!sourceWidth || !sourceHeight) return null;

  const cropWidth = Math.max(1, Math.floor(sourceWidth * crop));
  const cropHeight = Math.max(1, Math.floor(sourceHeight * crop));
  const sx = Math.floor((sourceWidth - cropWidth) / 2);
  const sy = Math.floor((sourceHeight - cropHeight) / 2);

  const longest = Math.max(cropWidth, cropHeight);
  const scale = Math.min(1, targetLongSide / longest);
  const width = Math.max(1, Math.round(cropWidth * scale));
  const height = Math.max(1, Math.round(cropHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, sx, sy, cropWidth, cropHeight, 0, 0, width, height);
  return decodeLanQrFromImageData(context.getImageData(0, 0, width, height));
}

export async function decodeLanQrRawFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const crops = [1, 0.75, 0.55, 0.4];
    const targets = [1200, 900, 700, 500, 360];
    for (const crop of crops) {
      for (const target of targets) {
        const raw = decodeBitmapRegionRaw(bitmap, crop, target);
        if (raw) return raw;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}

export async function decodeLanPairingQrFromFile(file: File): Promise<string | null> {
  const raw = await decodeLanQrRawFromFile(file);
  if (!raw) return null;
  return parseLanPairingQrPayload(raw);
}
