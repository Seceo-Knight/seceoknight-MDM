import { useEffect, useState } from 'react';
import QRCodeLib from 'qrcode';

// Renders a QR code entirely in-browser (no third-party service), so payloads
// that contain secrets (enrollment token, WiFi password) never leave the page.
// Always black-on-white so it scans regardless of the app theme.
//
// Android provisioning payloads are large (~1KB, because the PROVISIONING_*
// keys are verbose), which forces a high QR version (120+ modules). To stay
// scannable we use error-correction level 'L' (fewest modules for a given
// payload), a full 4-module quiet zone, and render the bitmap at 2x the
// displayed size so each module lands on several crisp device pixels.
export function QRCodeImage({ value, size = 460, className }: { value: string; size?: number; className?: string }) {
  const [src, setSrc] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    let cancelled = false;
    QRCodeLib.toDataURL(value, {
      errorCorrectionLevel: 'L',
      margin: 4,            // required quiet zone — scanners need it to lock on
      width: size * 2,      // hi-res bitmap; CSS downscales to `size` → sharp edges
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then(url => { if (!cancelled) { setSrc(url); setErr(''); } })
      .catch(e => { if (!cancelled) setErr(e?.message ?? 'Could not render QR'); });
    return () => { cancelled = true; };
  }, [value, size]);

  if (err) return <div className="text-xs text-danger" style={{ width: size }}>{err}</div>;
  return (
    <div className="inline-flex flex-col items-center gap-2">
      <div className="inline-flex rounded-xl bg-white p-3 shadow-sm ring-1 ring-line">
        {src
          ? <img src={src} width={size} height={size} alt="Enrollment QR code" className={className} />
          : <div className="animate-pulse rounded-lg bg-surface-2" style={{ width: size, height: size }} />}
      </div>
      {src && (
        <a href={src} download="enrollment-qr.png" className="text-xs text-accent hover:underline">
          Download QR (open full-size to scan)
        </a>
      )}
    </div>
  );
}
