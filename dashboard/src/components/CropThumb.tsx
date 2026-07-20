import { useEffect, useState } from 'react';
import { apiFetch } from '../api/client';

/**
 * Toont een cluster-crop-foto. Nodig omdat de crop-route achter de auth-gate
 * zit en een gewone <img src> geen Authorization-header kan meesturen — een
 * ingelogde (externe) gebruiker kreeg daardoor alleen kapotte thumbnails. We
 * halen de foto op via apiFetch (mét token) en tonen hem als blob-URL.
 */
export function CropThumb({ url, className }: { url: string | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) { setSrc(null); return; }
    let objectUrl: string | null = null;
    let cancelled = false;
    apiFetch(url)
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { /* foto ontbreekt of auth faalde — toon niets */ });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (!src) return <span className={className} style={{ display: 'inline-block', background: 'rgba(255,255,255,0.1)' }} />;
  return <img src={src} alt="" className={className} />;
}
