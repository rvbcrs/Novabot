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
const POLL_INTERVAL_MS = 500;

const CAMERA_TOPICS = [
  { key: 'front', labelKey: 'camera.front' },
  { key: 'front_hd', labelKey: 'camera.frontHd' },
  { key: 'tof_gray', labelKey: 'camera.tofGray' },
  { key: 'tof_depth', labelKey: 'camera.tofDepth' },
  { key: 'aruco', labelKey: 'camera.aruco' },
] as const;

export function CameraTab({ sn, online, mowerIp, headlightOn = false }: Props) {
  const { t } = useTranslation();
  const [selectedTopic, setSelectedTopic] = useState('front');
  const [hasError, setHasError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lightOn, setLightOn] = useState(headlightOn);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const activeRef = useRef(true);
  const blobUrlRef = useRef<string | null>(null);

  const snapshotUrl = `/api/dashboard/camera/${sn}/snapshot?ip=${mowerIp ?? ''}&port=${CAMERA_PORT}&topic=${selectedTopic}`;

  const fetchSnapshot = useCallback(async () => {
    if (!activeRef.current) return;
    try {
      const res = await fetch(`${snapshotUrl}&_t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!activeRef.current) return;
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
      const url = URL.createObjectURL(blob);
      blobUrlRef.current = url;
      setImageSrc(url);
      setLoading(false);
      setHasError(false);
    } catch {
      if (!activeRef.current) return;
      setLoading(false);
      setHasError(true);
    }
  }, [snapshotUrl]);

  // Poll snapshots
  useEffect(() => {
    if (!online) return;
    activeRef.current = true;
    setLoading(true);
    setHasError(false);

    fetchSnapshot();
    const interval = setInterval(fetchSnapshot, POLL_INTERVAL_MS);
    return () => {
      activeRef.current = false;
      clearInterval(interval);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [online, fetchSnapshot]);

  const handleRetry = () => {
    setHasError(false);
    setLoading(true);
    fetchSnapshot();
  };

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setHasError(false);
    setLoading(true);
    setImageSrc(null);
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

      {/* Snapshot view */}
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
            {loading && !imageSrc && (
              <div className="absolute inset-0 flex items-center justify-center bg-black z-10">
                <span className="flex items-center gap-2 text-xs text-gray-400">
                  <Loader className="w-5 h-5 animate-spin" />
                  {t('camera.connecting')}
                </span>
              </div>
            )}
            {imageSrc && (
              <img
                src={imageSrc}
                alt="Mower camera"
                className="w-full h-full object-contain"
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
