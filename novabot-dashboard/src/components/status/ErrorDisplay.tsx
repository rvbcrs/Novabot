import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface Props {
  errorCode?: string;
  errorMsg?: string;
  errorStatus?: string;
}

export function ErrorDisplay({ errorCode, errorMsg, errorStatus }: Props) {
  const { t } = useTranslation();
  const hasError = (errorStatus && errorStatus !== 'OK') ||
                   (errorCode && errorCode !== 'None' && errorCode !== '0');

  if (!hasError) return null;

  return (
    <div className="bg-red-900/30 border border-red-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-4 h-4 text-red-400" />
        <span className="text-red-400 text-sm font-semibold">{t('status.error')}</span>
        {errorCode && errorCode !== 'None' && (
          <span className="text-xs bg-red-800/50 text-red-300 px-2 py-0.5 rounded">
            {t('status.errorCode', { code: errorCode })}
          </span>
        )}
      </div>
      {errorMsg && <p className="text-sm text-red-300">{errorMsg}</p>}
      {errorStatus && errorStatus !== 'OK' && (
        <p className="text-xs text-red-400 mt-1">{errorStatus}</p>
      )}
    </div>
  );
}
