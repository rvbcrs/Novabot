import { useEffect, useState } from 'react';
import { getToken } from '../api/client';

/**
 * Toont een cluster-crop-foto. Nodig omdat de crop-route achter de auth-gate
 * zit en een gewone <img src> geen Authorization-header kan meesturen — een
 * ingelogde (externe) gebruiker kreeg daardoor alleen kapotte thumbnails.
 *
 * BELANGRIJK: gebruikt NIET `apiFetch`. Die behandelt elke 401/403 als
 * "sessie dood" en logt de gebruiker wereldwijd uit — een enkele mislukte
 * thumbnail zou dan de hele terrain-tab naar de inlogpagina sturen. Een
 * ontbrekende foto mag nooit de sessie beëindigen, dus hier een kale fetch
 * die bij élke fout gewoon niets toont.
 */
export function CropThumb({ url, className }: { url: string | null; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) { setSrc(null); return; }
    let objectUrl: string | null = null;
    let cancelled = false;
    const headers: Record<string, string> = {};
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    fetch(url, { headers })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => { /* foto ontbreekt of auth faalde — toon niets, nooit uitloggen */ });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (!src) return <span className={className} style={{ display: 'inline-block', background: 'rgba(255,255,255,0.1)' }} />;
  return <img src={src} alt="" className={className} />;
}
