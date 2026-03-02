import { useState } from 'react';
import { Camera, X, Maximize2, Minimize2, RefreshCw, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  sn: string;
  online: boolean;
  onClose: () => void;
}

const MOWER_IP = '192.168.0.244';
const CAMERA_PORT = 8000;

export function CameraStream({ sn, online, onClose }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  const streamUrl = `/api/dashboard/camera/${sn}/stream?ip=${MOWER_IP}&port=${CAMERA_PORT}&_k=${retryKey}`;

  const handleRetry = () => {
    setHasError(false);
    setLoading(true);
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

  return (
    <div className={`bg-gray-800 rounded-lg border border-gray-700 shadow-xl overflow-hidden ${
      expanded ? 'fixed inset-4 z-[9999]' : ''
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-gray-900/80 border-b border-gray-700">
        <span className="flex items-center gap-1.5 text-xs text-gray-300 font-medium">
          <Camera className="w-3.5 h-3.5 text-cyan-400" />
          {t('camera.title')}
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

      {/* Stream */}
      <div className={`relative bg-black ${expanded ? 'flex-1' : ''}`}>
        {hasError ? (
          <div className="flex flex-col items-center justify-center gap-2 h-40 text-xs text-gray-500">
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
            <img
              key={retryKey}
              src={streamUrl}
              alt="Mower camera"
              className={`w-full ${expanded ? 'h-full object-contain' : ''}`}
              onLoad={() => setLoading(false)}
              onError={() => { setLoading(false); setHasError(true); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
