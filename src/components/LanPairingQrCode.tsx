import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { encodeLanPairingQrPayload } from "../lib/lan-pairing-qr.js";

type LanPairingQrCodeProps = {
  code: string;
};

export default function LanPairingQrCode({ code }: LanPairingQrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    setError(null);

    void QRCode.toDataURL(encodeLanPairingQrPayload(code), {
      errorCorrectionLevel: "H",
      margin: 2,
      width: 240,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return <p className="lan-pairing-hint">Could not generate QR code.</p>;
  }

  if (!dataUrl) {
    return <div className="lan-pairing-qr is-loading" aria-hidden="true" />;
  }

  return (
    <img
      className="lan-pairing-qr"
      src={dataUrl}
      alt={`QR code for pairing code ${code}`}
      width={240}
      height={240}
    />
  );
}
