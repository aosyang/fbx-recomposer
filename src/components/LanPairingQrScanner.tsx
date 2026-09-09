import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  classifyLanQrPayload,
  decodeLanQrFromImageData,
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

function canUseLiveCamera(): boolean {
  return Boolean(
    typeof window !== "undefined"
      && window.isSecureContext
      && navigator.mediaDevices?.getUserMedia,
  );
}

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
  const liveSupported = useMemo(() => canUseLiveCamera(), []);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const modeRef = useRef(mode);
  const onCodeRef = useRef(onCode);
  const onSignalRef = useRef(onSignal);
  const onScanRef = useRef(onScan);
  modeRef.current = mode;
  onCodeRef.current = onCode;
  onSignalRef.current = onSignal;
  onScanRef.current = onScan;

  const stopTracks = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
    }
  };

  useEffect(() => () => stopTracks(), []);

  useEffect(() => {
    if (disabled) {
      stopTracks();
      setActive(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!active) {
      stopTracks();
      return;
    }

    let cancelled = false;
    let found = false;

    const start = async () => {
      setError(null);
      try {
        if (!canUseLiveCamera()) {
          throw new Error("Live camera needs HTTPS. Use photo capture instead.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        streamRef.current = stream;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await video.play();

        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) throw new Error("Could not read camera frames.");

        const tick = () => {
          if (cancelled || !streamRef.current || found) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (width > 0 && height > 0) {
              canvas.width = width;
              canvas.height = height;
              context.drawImage(video, 0, 0, width, height);
              const image = context.getImageData(0, 0, width, height);
              const raw = decodeLanQrFromImageData(image);
              if (raw) {
                const ok = acceptScan(
                  raw,
                  modeRef.current,
                  onCodeRef.current,
                  onSignalRef.current,
                  onScanRef.current,
                );
                if (ok) {
                  found = true;
                  stopTracks();
                  setActive(false);
                  return;
                }
              }
            }
          }
          frameRef.current = requestAnimationFrame(tick);
        };
        frameRef.current = requestAnimationFrame(tick);
      } catch (err) {
        if (cancelled) return;
        stopTracks();
        setActive(false);
        setError(
          err instanceof Error
            ? err.message
            : "Camera permission was denied or unavailable.",
        );
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopTracks();
    };
  }, [active]);

  const onCaptureChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setDecoding(true);
    setError(null);
    try {
      const raw = await decodeLanQrRawFromFile(file);
      if (!raw || !acceptScan(raw, mode, onCode, onSignal, onScan)) {
        setError("No matching QR found. Fill the frame, avoid glare, then try again.");
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

      {!active ? (
        <div className="lan-pairing-scanner-actions">
          <button
            type="button"
            className="primary-button lan-pairing-full"
            disabled={disabled || decoding}
            onClick={() => captureInputRef.current?.click()}
          >
            {decoding ? "Reading QR…" : "Scan QR code"}
          </button>
          {liveSupported ? (
            <button
              type="button"
              className="secondary-button lan-pairing-full"
              disabled={disabled || decoding}
              onClick={() => setActive(true)}
            >
              Live camera
            </button>
          ) : (
            <p className="lan-pairing-hint">
              Opens the camera to scan the other device’s QR code.
            </p>
          )}
        </div>
      ) : (
        <div className="lan-pairing-scanner-live">
          <video
            ref={videoRef}
            className="lan-pairing-scanner-video"
            playsInline
            muted
            autoPlay
          />
          <canvas ref={canvasRef} className="visually-hidden" aria-hidden="true" />
          <p className="lan-pairing-hint">Point the camera at the other device's QR code.</p>
          <button
            type="button"
            className="secondary-button lan-pairing-full"
            onClick={() => {
              stopTracks();
              setActive(false);
            }}
          >
            Stop camera
          </button>
        </div>
      )}
      {error ? <p className="lan-pairing-hint is-error">{error}</p> : null}
    </div>
  );
}
