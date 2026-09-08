import jsQR from "jsqr";

const PAIRING_QR_PREFIX = "fbx-lan-pair:";

export function encodeLanPairingQrPayload(code: string): string {
  const normalized = code.trim().toUpperCase();
  if (!normalized) throw new Error("pairing code is required");
  // Keep the payload short so phone photos of a screen decode reliably.
  return normalized;
}

export function parseLanPairingQrPayload(raw: string): string | null {
  const text = raw.trim().replace(/\s+/g, "");
  if (!text) return null;

  const prefixed = new RegExp(`^${PAIRING_QR_PREFIX}([A-Z0-9]{4,32})$`, "i").exec(text);
  if (prefixed?.[1]) return prefixed[1].toUpperCase();

  if (/^[A-Z0-9]{4,12}$/i.test(text)) return text.toUpperCase();
  return null;
}

function tryDecodeImageData(image: ImageData): string | null {
  if (!image.width || !image.height || image.data.length !== image.width * image.height * 4) {
    return null;
  }

  // Do not use "onlyInvert": jsQR can call scan(null) and crash on matrix.height.
  const attempts = ["attemptBoth", "dontInvert"] as const;
  for (const inversionAttempts of attempts) {
    try {
      const result = jsQR(image.data, image.width, image.height, { inversionAttempts });
      if (!result?.data) continue;
      const code = parseLanPairingQrPayload(result.data);
      if (code) return code;
    } catch {
      // jsQR can throw on malformed/partial detections; try the next strategy.
    }
  }
  return null;
}

function decodeBitmapRegion(
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
  return tryDecodeImageData(context.getImageData(0, 0, width, height));
}

export async function decodeLanPairingQrFromFile(file: File): Promise<string | null> {
  const bitmap = await createImageBitmap(file);
  try {
    const crops = [1, 0.75, 0.55, 0.4];
    const targets = [1200, 900, 700, 500, 360];
    for (const crop of crops) {
      for (const target of targets) {
        const code = decodeBitmapRegion(bitmap, crop, target);
        if (code) return code;
      }
    }
    return null;
  } finally {
    bitmap.close();
  }
}
