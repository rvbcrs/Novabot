/**
 * CameraTile — floating live MJPEG camera card for the map.
 *
 * Renders an `<img>` pointed at the dashboard's camera proxy
 * (`/api/dashboard/camera/:sn/stream?topic=…`). The browser renders
 * multipart/x-mixed-replace (MJPEG) natively, so no player is needed.
 *
 * The stream holds an open HTTP connection for as long as the `<img>` is
 * mounted, so the `<img>` is only mounted while the tile is EXPANDED —
 * collapsing it unmounts the image and closes the connection.
 *
 * Mirrors the OpenNova app's CameraScreen topic list. Custom-firmware only
 * (the proxy 404s on stock firmware); the parent gates rendering on that.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, ChevronDown, ChevronUp, X, RefreshCw, CameraOff, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TopicOption {
  key: string;
  /** i18n key under `camera.*`, falls back to the raw label. */
  label: string;
}

// Mirrors CAMERA_TOPICS in app/src/screens/CameraScreen.tsx.
const DEFAULT_TOPICS: TopicOption[] = [
  { key: 'front', label: 'front' },
  { key: 'tof_gray', label: 'tofGray' },
  { key: 'tof_depth', label: 'tofDepth' },
  { key: 'aruco', label: 'aruco' },
];

/** Snapshot poll cadence (ms). ~2 fps is plenty for a map overview tile. */
const CAMERA_POLL_MS = 500;
/** Consecutive snapshot failures before we surface the "unavailable" screen. */
const FAIL_THRESHOLD = 4;

interface Props {
  sn: string;
  topics?: TopicOption[];
  /** Close the whole tile (parent toggles `showCamera`). */
  onClose?: () => void;
}

export function CameraTile({ sn, topics = DEFAULT_TOPICS, onClose }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(true);
  const [topic, setTopic] = useState(topics[0]?.key ?? 'front');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const activeRef = useRef(true);
  const blobUrlRef = useRef<string | null>(null);
  const failRef = useRef(0);

  // Poll short-lived JPEG snapshots instead of holding one permanent MJPEG
  // stream open in an <img>. A long-lived stream connection fills the
  // browser's per-host connection cap, and every retry / re-mount leaves a
  // half-open connection behind, so the tile wedges on "unavailable" after a
  // few opens (the camera bug reported alongside #93). Short snapshot requests
  // free the socket immediately and self-heal after a transient hiccup, exactly
  // like the OpenNova app and the mobile CameraTab.
  const snapshotUrl =
    `/api/dashboard/camera/${encodeURIComponent(sn)}/snapshot` +
    `?topic=${encodeURIComponent(topic)}`;

  const fetchSnapshot = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const res = await fetch(`${snapshotUrl}&_t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      // Een 200 met lege of niet-JPEG-body (camera bezet door een andere
      // kijker, stream nog niet klaar) toonde een kapot <img>-icoon; dat is
      // gewoon een gemiste frame → error-pad met retry.
      if (blob.size < 100 || (blob.type && !blob.type.startsWith('image/'))) {
        throw new Error('lege/ongeldige snapshot');
      }
      if (!activeRef.current) return;
      const oud = blobUrlRef.current;
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setImageSrc(url);
      // oude blob pas ná de render vrijgeven — direct revoken liet het
      // nog-getoonde plaatje een frame lang op een dode URL wijzen
      if (oud) setTimeout(() => URL.revokeObjectURL(oud), 1000);
      setLoading(false);
      setError(false);
      failRef.current = 0;
    } catch {
      if (!activeRef.current) return;
      // Tolerate the odd dropped frame; only show the error screen after a few
      // consecutive failures so a single hiccup does not wedge the tile.
      failRef.current += 1;
      setLoading(false);
      if (failRef.current >= FAIL_THRESHOLD) setError(true);
    }
  }, [snapshotUrl]);

  useEffect(() => {
    if (!expanded) return;
    activeRef.current = true;
    failRef.current = 0;
    setLoading(true);
    setError(false);
    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, CAMERA_POLL_MS);
    return () => {
      activeRef.current = false;
      clearInterval(interval);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [expanded, fetchSnapshot]);

  const retry = () => {
    failRef.current = 0;
    setError(false);
    setLoading(true);
    fetchSnapshot();
  };

  const selectTopic = (key: string) => {
    if (key === topic) return;
    failRef.current = 0;
    setTopic(key);
    setError(false);
    setLoading(true);
    setImageSrc(null);
  };

  // Resizable kaart-tile: herstel opgeslagen grootte + bewaar bij elke resize.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const el = boxRef.current;
    if (!el) return;
    try {
      const saved = localStorage.getItem('novabot.cameraTileSize');
      if (saved) {
        const { w, h } = JSON.parse(saved) as { w?: number; h?: number };
        if (w) el.style.width = `${w}px`;
        if (h) el.style.height = `${h}px`;
      }
    } catch { /* ignore */ }
    const ro = new ResizeObserver(() => {
      try {
        localStorage.setItem('novabot.cameraTileSize', JSON.stringify({ w: el.offsetWidth, h: el.offsetHeight }));
      } catch { /* ignore */ }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [expanded]);

  // Verplaatsbaar (sleep aan de header) zodat je 'm van de schermrand kunt halen
  // en daarna rechtsonder kunt resizen. Positie = translate-offset, persistent.
  const [pos, setPos] = useState<{ dx: number; dy: number }>(() => {
    try {
      const s = localStorage.getItem('novabot.cameraTilePos');
      if (s) return JSON.parse(s) as { dx: number; dy: number };
    } catch { /* ignore */ }
    return { dx: 0, dy: 0 };
  });
  useEffect(() => {
    try { localStorage.setItem('novabot.cameraTilePos', JSON.stringify(pos)); } catch { /* ignore */ }
  }, [pos]);
  const dragRef = useRef<{ startX: number; startY: number; baseDx: number; baseDy: number } | null>(null);
  const onHeaderMouseDown = (e: React.MouseEvent) => {
    // Niet slepen vanaf de knoppen/select in de header.
    if ((e.target as HTMLElement).closest('button,select')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, baseDx: pos.dx, baseDy: pos.dy };
    e.preventDefault();
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ dx: d.baseDx + (e.clientX - d.startX), dy: d.baseDy + (e.clientY - d.startY) });
    };
    const up = () => { dragRef.current = null; };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, []);

  const transform = `translate(${pos.dx}px, ${pos.dy}px)`;

  return (
    <div
      ref={boxRef}
      className="bg-gray-900/95 backdrop-blur border border-gray-700 rounded-2xl shadow-xl overflow-hidden flex flex-col"
      style={expanded
        ? { resize: 'both', overflow: 'hidden', width: 300, height: 210, minWidth: 220, minHeight: 150, maxWidth: '92vw', maxHeight: '82vh', transform }
        : { transform }}
    >
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-move select-none"
        onMouseDown={onHeaderMouseDown}
        title={t('camera.dragHint', 'Sleep om te verplaatsen')}
      >
        <Camera className="w-4 h-4 text-emerald-400 shrink-0" />
        <span className="text-xs font-semibold text-gray-200">
          {t('camera.camera', 'Camera')}
        </span>
        {expanded && topics.length > 1 && (
          <select
            value={topic}
            onChange={(e) => selectTopic(e.target.value)}
            className="ml-1 bg-gray-800 border border-gray-600 rounded text-[11px] text-gray-200 px-1.5 py-0.5 focus:outline-none focus:border-emerald-500"
            title={t('camera.camera', 'Camera')}
          >
            {topics.map((opt) => (
              <option key={opt.key} value={opt.key}>
                {t(`camera.${opt.label}`, opt.label)}
              </option>
            ))}
          </select>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="p-1 rounded text-gray-400 hover:text-gray-200 hover:bg-gray-700/60 transition-colors"
            title={expanded ? t('common.collapse', 'Collapse') : t('common.expand', 'Expand')}
          >
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="p-1 rounded text-gray-400 hover:text-red-400 hover:bg-gray-700/60 transition-colors"
              title={t('common.close', 'Close')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Poll short-lived snapshots while expanded (see note above). */}
      {expanded && (
        <div className="relative bg-black flex-1 min-h-0">
          {error ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-3">
              <CameraOff className="w-7 h-7 text-gray-500" />
              <span className="text-xs text-gray-400">
                {t('camera.unavailable', 'Camera unavailable')}
              </span>
              <button
                onClick={retry}
                className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-gray-700/60 text-gray-200 hover:bg-gray-600/60 transition-colors"
              >
                <RefreshCw className="w-3 h-3" />
                {t('camera.retry', 'Retry')}
              </button>
            </div>
          ) : (
            <>
              {loading && !imageSrc && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="flex items-center gap-2 text-xs text-gray-400">
                    <Loader className="w-4 h-4 animate-spin" />
                    {t('camera.connecting', 'Connecting...')}
                  </span>
                </div>
              )}
              {imageSrc && (
                <img
                  src={imageSrc}
                  alt="Camera"
                  className="w-full h-full object-contain"
                />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
