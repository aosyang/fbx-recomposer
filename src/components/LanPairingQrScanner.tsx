import { useRef, useState, type ChangeEvent } from "react";
import {
  classifyLanQrPayload,
  decodeLanQrRawFromFile,
  type LanScannedPayload,
} from "../lib/lan-pairing-qr.js";

export type { LanScannedPayload };
export { classifyLanQrPayload };

type LanPairingQrScannerProps = {
  disabled?: boolean;
  /**
   * code: short pairing codes only
   * signal: signaling QR only
   * auto: accept either (for unified Scan to join)
   */
  mode?: "code" | "signal" | "auto";
  onCode?: (code: string) => void;
  onSignal?: (payload: string) => void;
  onScan?: (result: LanScannedPayload) => void;
};

function acceptScan(
  raw: string,
  mode: "code" | "signal" | "auto",
  onCode?: (code: string) => void,
  onSignal?: (payload: string) => void,
  onScan?: (result: LanScannedPayload) => void,
): boolean {
  const classified = classifyLanQrPayload(raw);
  if (!classified) return false;
  if (mode === "code" && classified.kind !== "code") return false;
  if (mode === "signal" && classified.kind !== "signal") return false;
  onScan?.(classified);
  if (classified.kind === "code") onCode?.(classified.code);
  else onSignal?.(classified.payload);
  return true;
}

export default function LanPairingQrScanner({
  disabled = false,
  mode = "auto",
  onCode,
  onSignal,
  onScan,
}: LanPairingQrScannerProps) {
  const [error, setError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const captureInputRef = useRef<HTMLInputElement | null>(null);

  const onCaptureChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setDecoding(true);
    setError(null);
    try {
      const raw = await decodeLanQrRawFromFile(file);
      if (!raw || !acceptScan(raw, mode, onCode, onSignal, onScan)) {
        setError("No matching pairing code found. Fill the frame, avoid glare, then try again.");
        return;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that photo.");
    } finally {
      setDecoding(false);
    }
  };

  return (
    <div className="lan-pairing-scanner">
      <input
        ref={captureInputRef}
        className="visually-hidden"
        type="file"
        accept="image/*"
        capture="environment"
        disabled={disabled || decoding}
        onChange={(event) => {
          void onCaptureChange(event);
        }}
      />

      <div className="lan-pairing-scanner-actions">
        <button
          type="button"
          className="primary-button lan-pairing-full"
          disabled={disabled || decoding}
          onClick={() => captureInputRef.current?.click()}
        >
          {decoding ? "Reading QR…" : "Scan QR code"}
        </button>
      </div>
      {error ? <p className="lan-pairing-hint is-error">{error}</p> : null}
    </div>
  );
}
