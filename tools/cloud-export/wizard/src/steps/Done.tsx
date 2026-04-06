import { useT } from '../i18n/index.ts';

interface ExportResult {
  sessionId: string;
  totalFiles: number;
  totalSize: number;
  devices: number;
  workRecords: number;
  messages: number;
  hasZip: boolean;
}

interface Props {
  result: ExportResult;
  onRestart: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function Done({ result, onRestart }: Props) {
  const { t } = useT();

  return (
    <div className="glass-card p-8">
      <div className="relative z-10">
        <div className="text-center mb-6">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="text-xl font-bold text-white mb-1">{t('done.title')}</h2>
          <p className="text-gray-400 text-sm">{t('done.subtitle')}</p>
        </div>

        {/* Summary */}
        <div className="bg-white/5 rounded-xl p-5 mb-4 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">{t('done.summary')}</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-gray-400">{t('done.files', { count: result.totalFiles })}</div>
            <div className="text-gray-400">{t('done.size', { size: formatSize(result.totalSize) })}</div>
            <div className="text-gray-400">{t('done.devices', { count: result.devices })}</div>
            <div className="text-gray-400">{t('done.records', { count: result.workRecords })}</div>
            <div className="text-gray-400">{t('done.messages', { count: result.messages })}</div>
          </div>
        </div>

        <div className="flex gap-3">
          {result.hasZip && (
            <a
              href={`/api/export/download?session=${result.sessionId}`}
              download="novabot-export.zip"
              className="flex-1 py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-xl transition-all text-center"
            >
              {t('done.download_zip')}
            </a>
          )}
          <button
            onClick={onRestart}
            className="flex-1 py-3 bg-white/10 hover:bg-white/20 text-gray-300 font-semibold rounded-xl transition-all"
          >
            {t('done.restart')}
          </button>
        </div>
      </div>
    </div>
  );
}
