import { useState } from 'react';
import { Camera, RefreshCw, Loader } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  sn: string;
  online: boolean;
  mowerIp?: string;
}

const CAMERA_PORT = 8000;
const DEFAULT_IP = '192.168.0.244';

const CAMERA_TOPICS = [
  { key: 'front', labelKey: 'camera.front' },
  { key: 'tof_gray', labelKey: 'camera.tofGray' },
  { key: 'tof_depth', labelKey: 'camera.tofDepth' },
] as const;

export function CameraTab({ sn, online, mowerIp }: Props) {
  const { t } = useTranslation();
  const [selectedTopic, setSelectedTopic] = useState('front');
  const [hasError, setHasError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [retryKey, setRetryKey] = useState(0);

  const ip = mowerIp || DEFAULT_IP;
  const streamUrl = `/api/dashboard/camera/${sn}/stream?ip=${ip}&port=${CAMERA_PORT}&topic=${selectedTopic}&_k=${retryKey}`;

  const handleRetry = () => {
    setHasError(false);
    setLoading(true);
    setRetryKey(k => k + 1);
  };

  const handleTopicChange = (key: string) => {
    setSelectedTopic(key);
    setHasError(false);
    setLoading(true);
    setRetryKey(k => k + 1);
  };

  if (!online) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 px-8">
        <Camera className="w-16 h-16 text-gray-700" />
        <p className="text-sm text-gray-500 text-center">{t('camera.offline')}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-black">
      {/* Topic selector */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gray-900/90 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          {CAMERA_TOPICS.map(({ key, labelKey }) => (
            <button
              key={key}
              onClick={() => handleTopicChange(key)}
              className={`px-3 py-1.5 text-xs rounded-full font-medium transition-colors ${
                selectedTopic === key
                  ? 'bg-cyan-600 text-white'
                  : 'text-gray-400 bg-gray-800 active:bg-gray-700'
              }`}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
        <button
          onClick={handleRetry}
          className="p-2 text-gray-400 active:text-white transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Stream */}
      <div className="flex-1 relative flex items-center justify-center min-h-0">
        {hasError ? (
          <div className="flex flex-col items-center gap-4 px-8">
            <Camera className="w-12 h-12 text-gray-600" />
            <p className="text-sm text-gray-500 text-center">{t('camera.unavailable')}</p>
            <button
              onClick={handleRetry}
              className="px-5 py-2.5 rounded-xl bg-gray-800 text-gray-300 text-sm font-medium
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
            <img
              key={retryKey}
              src={streamUrl}
              alt="Mower camera"
              className="w-full h-full object-contain"
              onLoad={() => setLoading(false)}
              onError={() => { setLoading(false); setHasError(true); }}
            />
          </>
        )}
      </div>
    </div>
  );
}
