import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Camera, X, Maximize2, Minimize2, RefreshCw, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  sn: string;
  online: boolean;
  mowerIp?: string;
  onClose: () => void;
}

const DEFAULT_IP = '192.168.0.244';
const CAMERA_PORT = 8000;
const SNAPSHOT_INTERVAL = 500;
const STREAM_TIMEOUT = 5000;

const CAMERA_TOPICS = [
  { key: 'front', labelKey: 'camera.front' },
  { key: 'front_hd', labelKey: 'camera.frontHd' },
  { key: 'tof_gray', labelKey: 'camera.tofGray' },
  { key: 'tof_depth', labelKey: 'camera.tofDepth' },
  { key: 'aruco', labelKey: 'camera.aruco' },
] as const;

type Mode = 'stream' | 'snapshot';

export function CameraStream({ sn, online, mowerIp, onClose }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const [selectedTopic, setSelectedTopic] = useState('front');
  const [mode, setMode] = useState<Mode>('stream');

  const ip = mowerIp || DEFAULT_IP;
  const streamUrl = `/api/dashboard/camera/${sn}/stream?ip=${ip}&port=${CAMERA_PORT}&topic=${selectedTopic}&_k=${retryKey}`;
  const snapshotBaseUrl = `/api/dashboard/camera/${sn}/snapshot?ip=${ip}&port=${CAMERA_PORT}&topic=${selectedTopic}`;

  // Snapshot polling
  const snapshotRef = useRef<HTMLImageElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pollSnapshot = useCallback(() => {
    if (!snapshotRef.current) return;
    snapshotRef.current.src = `${snapshotBaseUrl}&_t=${Date.now()}`;
  }, [snapshotBaseUrl]);

  useEffect(() => {
    if (mode !== 'snapshot' || hasError) return;
    pollSnapshot();
    timerRef.current = setInterval(pollSnapshot, SNAPSHOT_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mode, hasError, pollSnapshot, retryKey]);

  // Stream timeout → auto-fallback to snapshot
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'stream' || !loading) return;
    streamTimeoutRef.current = setTimeout(() => {
      setMode('snapshot');
      setLoading(true);
    }, STREAM_TIMEOUT);
    return () => { if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current); };
  }, [mode, loading, retryKey]);

  const handleRetry = () => {
    setHasError(false);
    setLoading(true);
    setMode('stream');
    setRetryKey(k => k + 1);
  };

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setHasError(false);
    setLoading(true);
    setMode('stream');
    setRetryKey(k => k + 1);
  };

  if (!online) {
    return (
      <div className="bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-3 py-2 bg-gray-900/80 border-b border-gray-700">
          <span className="flex items-center gap-1.5 text-xs text-gray-400">
            <Camera className="w-3.5 h-3.5" />
            {t('camera.title')}
          </span>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center justify-center h-40 text-xs text-gray-500">
          {t('camera.offline')}
        </div>
      </div>
    );
  }

  const content = (
    <div className={`bg-gray-800 shadow-xl overflow-hidden ${
      expanded
        ? 'fixed inset-0 z-[99999] flex flex-col'
        : 'rounded-lg border border-gray-700'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-900 border-b border-gray-700">
        <span className="flex items-center gap-1.5 text-xs text-gray-300 font-medium">
          <Camera className="w-3.5 h-3.5 text-cyan-400" />
          {t('camera.title')}
          {mode === 'snapshot' && !loading && (
            <span className="text-[9px] text-gray-500 ml-1">(snapshot)</span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRetry}
            className="text-gray-500 hover:text-gray-300 transition-colors p-0.5"
            title={t('camera.retry')}
          >
            <RefreshCw className="w-3 h-3" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-gray-500 hover:text-gray-300 transition-colors p-0.5"
          >
            {expanded ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-0.5">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Topic selector */}
      <div className="flex items-center gap-1 px-3 py-1.5 bg-gray-900/60 border-b border-gray-700/50 overflow-x-auto">
        {CAMERA_TOPICS.map(({ key, labelKey }) => (
          <button
            key={key}
            onClick={() => handleTopicChange(key)}
            className={`px-2 py-0.5 text-[10px] rounded whitespace-nowrap transition-colors ${
              selectedTopic === key
                ? 'bg-cyan-600 text-white font-medium'
                : 'text-gray-500 hover:text-gray-300 hover:bg-gray-700'
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Stream / Snapshot */}
      <div className={`relative bg-black ${expanded ? 'flex-1 min-h-0' : 'h-[280px]'}`}>
        {hasError ? (
          <div className="flex flex-col items-center justify-center gap-2 text-xs text-gray-500 h-full">
            <span>{t('camera.unavailable')}</span>
            <button
              onClick={handleRetry}
              className="px-3 py-1 rounded bg-gray-700 text-gray-300 hover:bg-gray-600 transition-colors"
            >
              {t('camera.retry')}
            </button>
          </div>
        ) : (
          <>
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/80 z-10">
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader className="w-4 h-4 animate-spin" />
                  {t('camera.connecting')}
                </span>
              </div>
            )}

            {mode === 'stream' ? (
              <img
                key={`stream-${retryKey}`}
                src={streamUrl}
                alt="Mower camera"
                className={`w-full ${expanded ? 'h-full object-contain' : ''}`}
                onLoad={() => setLoading(false)}
                onError={() => {
                  setMode('snapshot');
                  setLoading(true);
                }}
              />
            ) : (
              <img
                ref={snapshotRef}
                key={`snap-${retryKey}`}
                alt="Mower camera"
                className={`w-full ${expanded ? 'h-full object-contain' : ''}`}
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setHasError(true); }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );

  if (expanded) {
    return createPortal(content, document.body);
  }

  return content;
}
