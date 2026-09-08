import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import jsQR from "jsqr";
import {
  decodeLanPairingQrFromFile,
  parseLanPairingQrPayload,
} from "../lib/lan-pairing-qr.js";

type LanPairingQrScannerProps = {
  disabled?: boolean;
  onCode: (code: string) => void;
};

function canUseLiveCamera(): boolean {
  return Boolean(
    typeof window !== "undefined"
      && window.isSecureContext
      && navigator.mediaDevices?.getUserMedia,
  );
}

async function decodeQrFromImageFile(file: File): Promise<string | null> {
  return decodeLanPairingQrFromFile(file);
}

export default function LanPairingQrScanner({ disabled = false, onCode }: LanPairingQrScannerProps) {
  const liveSupported = useMemo(() => canUseLiveCamera(), []);
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const captureInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number | null>(null);
  const onCodeRef = useRef(onCode);
  onCodeRef.current = onCode;

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
    let foundCode: string | null = null;

    const start = async () => {
      setError(null);
      try {
        if (!canUseLiveCamera()) {
          throw new Error(
            "Live camera needs HTTPS. Use “Take photo of QR” instead on this network address.",
          );
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
          if (cancelled || !streamRef.current || foundCode) return;
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            const width = video.videoWidth;
            const height = video.videoHeight;
            if (width > 0 && height > 0) {
              canvas.width = width;
              canvas.height = height;
              context.drawImage(video, 0, 0, width, height);
              const image = context.getImageData(0, 0, width, height);
              const result = (() => {
                try {
                  return jsQR(image.data, image.width, image.height, {
                    inversionAttempts: "dontInvert",
                  });
                } catch {
                  return null;
                }
              })();
              if (result?.data) {
                const code = parseLanPairingQrPayload(result.data);
                if (code) {
                  foundCode = code;
                  stopTracks();
                  setActive(false);
                  onCodeRef.current(code);
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
      const code = await decodeQrFromImageFile(file);
      if (!code) {
        setError("No pairing QR found. Fill the frame with the QR, avoid glare, then try again.");
        return;
      }
      onCodeRef.current(code);
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
