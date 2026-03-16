import { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, RefreshCw, Loader, Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { sendCommand } from '../../api/client';

interface Props {
  sn: string;
  online: boolean;
  mowerIp?: string;
  headlightOn?: boolean;
}

const CAMERA_PORT = 8000;
const DEFAULT_IP = '192.168.0.244';
const SNAPSHOT_INTERVAL = 500; // ms between snapshot polls
const STREAM_TIMEOUT = 5000;  // ms to wait for stream before fallback

const CAMERA_TOPICS = [
  { key: 'front', labelKey: 'camera.front' },
  { key: 'front_hd', labelKey: 'camera.frontHd' },
  { key: 'tof_gray', labelKey: 'camera.tofGray' },
  { key: 'tof_depth', labelKey: 'camera.tofDepth' },
  { key: 'aruco', labelKey: 'camera.aruco' },
] as const;

type Mode = 'stream' | 'snapshot';

export function CameraTab({ sn, online, mowerIp, headlightOn = false }: Props) {
  const { t } = useTranslation();
  const [selectedTopic, setSelectedTopic] = useState('front');
  const [hasError, setHasError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);
  const [lightOn, setLightOn] = useState(headlightOn);
  const [mode, setMode] = useState<Mode>('stream');

  const ip = mowerIp || DEFAULT_IP;
  const streamUrl = `/api/dashboard/camera/${sn}/stream?ip=${ip}&port=${CAMERA_PORT}&topic=${selectedTopic}&_k=${retryKey}`;
  const snapshotBaseUrl = `/api/dashboard/camera/${sn}/snapshot?ip=${ip}&port=${CAMERA_PORT}&topic=${selectedTopic}`;

  // Snapshot polling
  const snapshotRef = useRef<HTMLImageElement>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seqRef = useRef(0);

  const pollSnapshot = useCallback(() => {
    if (!snapshotRef.current) return;
    seqRef.current++;
    snapshotRef.current.src = `${snapshotBaseUrl}&_t=${Date.now()}`;
  }, [snapshotBaseUrl]);

  useEffect(() => {
    if (mode !== 'snapshot' || hasError) return;
    // Start polling
    pollSnapshot();
    timerRef.current = setInterval(pollSnapshot, SNAPSHOT_INTERVAL);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [mode, hasError, pollSnapshot, retryKey]);

  // Stream timeout → auto-fallback to snapshot mode
  const streamTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (mode !== 'stream' || !loading) return;
    streamTimeoutRef.current = setTimeout(() => {
      // Stream didn't load in time, switch to snapshot polling
      setMode('snapshot');
      setLoading(true);
    }, STREAM_TIMEOUT);
    return () => { if (streamTimeoutRef.current) clearTimeout(streamTimeoutRef.current); };
  }, [mode, loading, retryKey]);

  const handleRetry = () => {
    setHasError(false);
    setLoading(true);
    setMode('stream'); // retry stream first
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
      <div className="h-full flex flex-col items-center justify-center gap-3 px-8">
        <Camera className="w-16 h-16 text-gray-300 dark:text-gray-700" />
        <p className="text-sm text-gray-400 dark:text-gray-500 text-center">{t('camera.offline')}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-black">
      {/* Topic selector */}
      <div className="flex items-center justify-between px-4 py-2.5
                       bg-white/90 dark:bg-gray-900/90 backdrop-blur-sm">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {CAMERA_TOPICS.map(({ key, labelKey }) => (
            <button
              key={key}
              onClick={() => handleTopicChange(key)}
              className={`px-3 py-1.5 text-xs rounded-full font-medium transition-colors whitespace-nowrap ${
                selectedTopic === key
                  ? 'bg-cyan-600 text-white'
                  : 'text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 active:bg-gray-200 dark:active:bg-gray-700'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => {
              const next = !lightOn;
              setLightOn(next);
              sendCommand(sn, { headlight: next ? 2 : 0 });
            }}
            className={`p-2 rounded-full transition-colors ${
              lightOn
                ? 'text-yellow-400 bg-yellow-400/15'
                : 'text-gray-400 active:text-gray-700 dark:active:text-white'
            }`}
            title={t('controls.headlight')}
          >
            <Lightbulb className="w-4 h-4" />
          </button>
          <button
            onClick={handleRetry}
            className="p-2 text-gray-400 active:text-gray-700 dark:active:text-white transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Stream / Snapshot */}
      <div className="flex-1 relative flex items-center justify-center min-h-0">
        {hasError ? (
          <div className="flex flex-col items-center gap-4 px-8">
            <Camera className="w-12 h-12 text-gray-600" />
            <p className="text-sm text-gray-500 text-center">{t('camera.unavailable')}</p>
            <button
              onClick={handleRetry}
              className="px-5 py-2.5 rounded-xl bg-gray-200 dark:bg-gray-800
                         text-gray-700 dark:text-gray-300 text-sm font-medium
                         active:scale-[0.97] transition-transform"
            >
              {t('camera.retry')}
            </button>
          </div>
        ) : (
          <>
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader className="w-5 h-5 animate-spin" />
                  {t('camera.connecting')}
                </span>
              </div>
            )}

            {mode === 'stream' ? (
              <img
                key={`stream-${retryKey}`}
                src={streamUrl}
                alt="Mower camera"
                className="w-full h-full object-contain"
                onLoad={() => setLoading(false)}
                onError={() => {
                  // Stream failed, try snapshot polling
                  setMode('snapshot');
                  setLoading(true);
                }}
              />
            ) : (
              <img
                ref={snapshotRef}
                key={`snap-${retryKey}`}
                alt="Mower camera"
                className="w-full h-full object-contain"
                onLoad={() => setLoading(false)}
                onError={() => { setLoading(false); setHasError(true); }}
              />
            )}
          </>
        )}
      </div>

      {/* Mode indicator */}
      {!hasError && !loading && mode === 'snapshot' && (
        <div className="absolute bottom-2 left-1/2 -translate-x-1/2 z-20">
          <span className="text-[10px] text-gray-500 bg-black/60 px-2 py-0.5 rounded-full">
            snapshot
          </span>
        </div>
      )}
    </div>
  );
}
