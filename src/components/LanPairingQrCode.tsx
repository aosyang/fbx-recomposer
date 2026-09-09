import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { encodeLanPairingQrPayload } from "../lib/lan-pairing-qr.js";

type LanPairingQrCodeProps = {
  /** Short pairing code (default helper QR). */
  code?: string;
  /** Raw QR payload (signaling fallback). Overrides code when set. */
  payload?: string;
  /** Fallback CSS size before the wrap is measured. Display always fills wrap width. */
  size?: number;
  /** Lower ECC for large signaling payloads. */
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  alt?: string;
};

const QR_BORDER_PX = 8;

function devicePixelRatioSafe(): number {
  if (typeof window === "undefined") return 1;
  return Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
}

async function paintQr(
  canvas: HTMLCanvasElement,
  value: string,
  displayCssSize: number,
  ecc: "L" | "M" | "Q" | "H",
): Promise<number> {
  const created = QRCode.create(value, { errorCorrectionLevel: ecc });
  const modules = created.modules.size;
  const margin = 2;
  const moduleSpan = modules + margin * 2;
  // Fill the available width so dense offline QRs stay large enough to scan.
  const cssSize = Math.max(120, Math.floor(displayCssSize));
  const dpr = devicePixelRatioSafe();
  // Integer module pixels in the bitmap; CSS may scale this box down/up with pixelated rendering.
  const genScale = Math.max(2, Math.ceil((cssSize * dpr) / moduleSpan));

  await QRCode.toCanvas(canvas, value, {
    errorCorrectionLevel: ecc,
    margin,
    scale: genScale,
    color: {
      dark: "#000000",
      light: "#ffffff",
    },
  });

  return cssSize;
}

export default function LanPairingQrCode({
  code,
  payload,
  size = 240,
  errorCorrectionLevel,
  alt,
}: LanPairingQrCodeProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [fitSize, setFitSize] = useState(size);
  const [cssSize, setCssSize] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = payload ?? (code ? encodeLanPairingQrPayload(code) : "");
  const ecc = errorCorrectionLevel ?? (payload ? "L" : "H");

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") {
      setFitSize(size);
      return;
    }

    const update = () => {
      const inner = Math.floor(wrap.clientWidth - QR_BORDER_PX * 2);
      // Use the full wrap width — do not cap down to the size prop (that made dense QRs tiny).
      setFitSize(Math.max(160, inner > 0 ? inner : size));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [size]);

  useEffect(() => {
    let cancelled = false;
    setCssSize(null);
    setError(null);
    if (!value) {
      setError("QR payload is empty");
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;

    void paintQr(canvas, value, fitSize, ecc)
      .then((px) => {
        if (!cancelled) setCssSize(px);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [value, ecc, fitSize]);

  if (error) {
    return <p className="lan-pairing-hint">Could not generate QR code.</p>;
  }

  return (
    <div ref={wrapRef} className="lan-pairing-qr-wrap">
      <canvas
        ref={canvasRef}
        className={`lan-pairing-qr${cssSize ? "" : " is-loading"}`}
        role="img"
        aria-label={alt ?? (code ? `QR code for pairing code ${code}` : "LAN signaling QR code")}
        style={
          cssSize
            ? { width: cssSize, height: cssSize }
            : { width: fitSize, height: fitSize }
        }
      />
    </div>
  );
}
