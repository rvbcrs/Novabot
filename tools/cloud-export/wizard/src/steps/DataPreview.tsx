import { useState, useEffect, useRef } from 'react';
import { useT } from '../i18n/index.ts';

interface LoginData {
  accessToken: string;
  appUserId: number;
  email: string;
  password: string;
  devices: Record<string, unknown>[];
  chargerCount: number;
  mowerCount: number;
}

interface ExportStep {
  name: string;
  status: 'pending' | 'running' | 'done' | 'error';
  count?: number;
}

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
  loginData: LoginData;
  onDone: (result: ExportResult) => void;
}

export default function DataPreview({ loginData, onDone }: Props) {
  const { t } = useT();
  const [workRecordCount, setWorkRecordCount] = useState<number | null>(null);
  const [messageCount, setMessageCount] = useState<number | null>(null);
  const [includeFirmware, setIncludeFirmware] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [steps, setSteps] = useState<ExportStep[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch preview counts
  useEffect(() => {
    const mowerSns = loginData.devices
      .map(d => String(d.mowerSn ?? d.sn ?? ''))
      .filter(sn => sn.startsWith('LFIN'));

    fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: loginData.accessToken,
        appUserId: loginData.appUserId,
        mowerSns,
      }),
    })
      .then(r => r.json())
      .then(data => {
        if (data.ok) {
          setWorkRecordCount(data.workRecordCount ?? 0);
          setMessageCount(data.messageCount ?? 0);
        }
      })
      .catch(() => {});
  }, [loginData]);

  const deviceCount = loginData.devices.length;

  const handleExport = async () => {
    setExporting(true);

    const resp = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: loginData.accessToken,
        appUserId: loginData.appUserId,
        email: loginData.email,
        password: loginData.password,
        devices: loginData.devices,
        includeFirmware,
      }),
    });

    const data = await resp.json();
    const sessionId = data.sessionId as string;

    // Poll for progress using session ID
    pollRef.current = setInterval(async () => {
      try {
        const statusResp = await fetch(`/api/export/status?session=${sessionId}`);
        const status = await statusResp.json();
        setSteps(status.steps || []);

        if (status.status === 'done' || status.status === 'error') {
          if (pollRef.current) clearInterval(pollRef.current);

          onDone({
            sessionId,
            totalFiles: status.summary?.totalFiles ?? 0,
            totalSize: status.summary?.totalSize ?? 0,
            devices: status.summary?.devices ?? 0,
            workRecords: status.summary?.workRecords ?? 0,
            messages: status.summary?.messages ?? 0,
            hasZip: !!status.zipFile,
          });
        }
      } catch { /* retry on next interval */ }
    }, 500);
  };

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const stepIcon = (status: string) => {
    switch (status) {
      case 'done': return <span className="text-emerald-400">✓</span>;
      case 'running': return (
        <svg className="animate-spin h-4 w-4 text-sky-400" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      );
      case 'error': return <span className="text-red-400">✗</span>;
      default: return <span className="text-gray-600">○</span>;
    }
  };

  const stepLabel = (name: string) => {
    const labelMap: Record<string, string> = {
      account: t('export.categories.account'),
      devices: t('export.categories.devices', { count: deviceCount }),
      maps: t('export.categories.maps'),
      workRecords: t('export.categories.workRecords', { count: workRecordCount ?? '?' }),
      messages: t('export.categories.messages', { count: messageCount ?? '?' }),
      schedules: t('export.categories.schedules'),
      firmware: t('export.categories.firmware'),
    };
    return labelMap[name] || name;
  };

  return (
    <div className="glass-card p-8">
      <div className="relative z-10">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">📦</div>
          <h2 className="text-xl font-bold text-white mb-1">{t('export.title')}</h2>
          <p className="text-gray-400 text-sm">{t('export.subtitle')}</p>
        </div>

        {!exporting ? (
          <div className="space-y-4">
            {/* Data categories */}
            <div className="space-y-2">
              {['account', 'devices', 'maps', 'workRecords', 'messages', 'schedules', 'firmware'].map(cat => (
                <div key={cat} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                  <span className="text-emerald-400">✓</span>
                  <span className="text-sm text-gray-300">{stepLabel(cat)}</span>
                </div>
              ))}
            </div>

            {/* Firmware download option */}
            <label className="flex items-start gap-3 bg-white/5 rounded-xl p-4 cursor-pointer">
              <input
                type="checkbox"
                checked={includeFirmware}
                onChange={e => setIncludeFirmware(e.target.checked)}
                className="mt-0.5 rounded"
              />
              <div>
                <p className="text-sm text-gray-300">{t('export.include_firmware_files')}</p>
                <p className="text-xs text-gray-500 mt-1">{t('export.firmware_warning')}</p>
              </div>
            </label>

            <button
              onClick={handleExport}
              className="w-full py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-xl transition-all"
            >
              {t('export.export_button')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sky-300 text-sm font-medium text-center mb-4">{t('export.exporting')}</p>
            {steps.map(step => (
              <div key={step.name} className="flex items-center gap-3 bg-white/5 rounded-lg p-3">
                {stepIcon(step.status)}
                <span className="text-sm text-gray-300 flex-1">{stepLabel(step.name)}</span>
                {step.count !== undefined && step.status === 'done' && (
                  <span className="text-xs text-gray-500">{step.count}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
