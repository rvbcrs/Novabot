import { useEffect, useState } from 'react';
import type { DetectResult, FirmwareInfo, MowerInfo } from '../App.tsx';
import { useT } from '../i18n/index.ts';

interface Props {
  mower: MowerInfo | null;
  firmware: FirmwareInfo | null;
  detect: DetectResult | null;
  ip: string;
  onConnected: () => void;
}

interface CloudDevice {
  sn?: string;
  chargerSn?: string;
  mowerSn?: string;
  chargerAddress?: number;
  chargerChannel?: number;
  macAddress?: string;
  mowerVersion?: string;
  chargerVersion?: string;
  sysVersion?: string;
  equipmentNickName?: string;
  [key: string]: unknown;
}

interface ImportResult {
  email: string;
  chargers: CloudDevice[];
  mowers: CloudDevice[];
  rawList: CloudDevice[];
}

type ImportPhase = 'idle' | 'fetching' | 'preview' | 'applying' | 'done' | 'error';

export default function WaitForMower({ mower, firmware, detect, ip, onConnected }: Props) {
  const { t } = useT();
  const existingBroker = detect?.mqtt.clientMode ?? false;
  const [dots, setDots] = useState('');

  // Cloud import state
  const [importEmail, setImportEmail] = useState('');
  const [importPassword, setImportPassword] = useState('');
  const [importPhase, setImportPhase] = useState<ImportPhase>('idle');
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setDots(d => d.length >= 3 ? '' : d + '.');
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Auto-advance if mower already connected when this step mounts
  useEffect(() => {
    if (mower) {
      const timer = setTimeout(onConnected, 800);
      return () => clearTimeout(timer);
    }
  }, [mower, onConnected]);

  async function handleCloudFetch() {
    if (!importEmail || !importPassword) return;
    setImportPhase('fetching');
    setImportError('');

    try {
      const resp = await fetch('/api/cloud-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: importEmail, password: importPassword }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string } & ImportResult;

      if (!resp.ok || !data.ok) {
        setImportError(data.error ?? t('wait.importErrorLogin'));
        setImportPhase('error');
        return;
      }

      setImportResult(data);
      setImportPhase('preview');
    } catch {
      setImportError(t('wait.importErrorNetwork'));
      setImportPhase('error');
    }
  }

  async function handleCloudApply() {
    if (!importResult) return;
    setImportPhase('applying');
    setImportError('');

    // Vind de eerste charger entry
    const chargerEntry = importResult.chargers[0] ?? importResult.rawList.find(e => {
      const sn = String(e.chargerSn ?? e.sn ?? '');
      return sn.startsWith('LFIC');
    });

    const mowerEntry = importResult.mowers[0] ?? importResult.rawList.find(e => {
      const sn = String(e.mowerSn ?? e.sn ?? '');
      return sn.startsWith('LFIN');
    });

    const chargerSn = String(chargerEntry?.chargerSn ?? chargerEntry?.sn ?? '');
    const mowerSn = String(mowerEntry?.mowerSn ?? mowerEntry?.sn ?? '');

    if (!chargerSn) {
      setImportError('Geen laadstation gevonden in cloud account.');
      setImportPhase('error');
      return;
    }

    try {
      const resp = await fetch('/api/cloud-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: importEmail,
          password: importPassword,
          deviceName: chargerEntry?.equipmentNickName ?? 'Novabot',
          charger: {
            sn: chargerSn,
            address: chargerEntry?.chargerAddress,
            channel: chargerEntry?.chargerChannel,
            mac: chargerEntry?.macAddress,
          },
          mower: mowerSn ? {
            sn: mowerSn,
            version: mowerEntry?.mowerVersion ?? mowerEntry?.sysVersion,
          } : undefined,
        }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string };

      if (!resp.ok || !data.ok) {
        setImportError(data.error ?? t('wait.importErrorApply'));
        setImportPhase('error');
        return;
      }

      setImportPhase('done');
    } catch {
      setImportError(t('wait.importErrorApply'));
      setImportPhase('error');
    }
  }

  function getKnownDevices() {
    if (!importResult) return [];
    const items: Array<{ type: 'charger' | 'mower'; sn: string; version?: string; address?: number; channel?: number }> = [];

    for (const e of importResult.rawList) {
      const rawSn = String(e.sn ?? '');
      const chargerSn = String(e.chargerSn ?? (rawSn.startsWith('LFIC') ? rawSn : ''));
      const mowerSn = String(e.mowerSn ?? (rawSn.startsWith('LFIN') ? rawSn : ''));

      if (chargerSn.startsWith('LFIC')) {
        if (!items.some(i => i.sn === chargerSn)) {
          items.push({ type: 'charger', sn: chargerSn, version: e.chargerVersion as string | undefined, address: e.chargerAddress as number | undefined, channel: e.chargerChannel as number | undefined });
        }
      }
      if (mowerSn.startsWith('LFIN')) {
        if (!items.some(i => i.sn === mowerSn)) {
          items.push({ type: 'mower', sn: mowerSn, version: e.mowerVersion as string | undefined });
        }
      }
    }
    return items;
  }

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('wait.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm">
        {t('wait.description')}
      </p>

      {/* ── Cloud import panel ── */}
      <div className="mb-6">
        <button
          onClick={() => setShowImport(v => !v)}
          className="w-full flex items-center justify-between px-4 py-3 bg-blue-900/20 border border-blue-800/40 rounded-xl text-sm text-blue-300 hover:bg-blue-900/30 transition-colors"
        >
          <span className="font-semibold">{t('wait.importTitle')}</span>
          <span className="text-blue-400 text-xs">{showImport ? '▲' : '▼'}</span>
        </button>

        {showImport && (
          <div className="mt-2 bg-gray-800/50 border border-gray-700/40 rounded-xl p-5">
            <p className="text-gray-400 text-xs mb-4">{t('wait.importDesc')}</p>

            {(importPhase === 'idle' || importPhase === 'error') && (
              <>
                <div className="space-y-3 mb-4">
                  <input
                    type="email"
                    placeholder={t('wait.importEmail')}
                    value={importEmail}
                    onChange={e => setImportEmail(e.target.value)}
                    className="w-full bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                  <input
                    type="password"
                    placeholder={t('wait.importPassword')}
                    value={importPassword}
                    onChange={e => setImportPassword(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleCloudFetch()}
                    className="w-full bg-gray-900/60 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                  />
                </div>
                {importError && (
                  <p className="text-red-400 text-xs mb-3">{importError}</p>
                )}
                <button
                  onClick={handleCloudFetch}
                  disabled={!importEmail || !importPassword}
                  className="w-full py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  {t('wait.importBtn')}
                </button>
              </>
            )}

            {importPhase === 'fetching' && (
              <div className="flex items-center gap-2 text-blue-400 text-sm">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span>{t('wait.importing')}</span>
              </div>
            )}

            {importPhase === 'preview' && (
              <div className="space-y-3">
                {getKnownDevices().length === 0 ? (
                  <p className="text-gray-400 text-sm">{t('wait.importNoDevices')}</p>
                ) : (
                  <div className="space-y-2">
                    {getKnownDevices().map((d, i) => (
                      <div key={i} className="flex items-center gap-3 p-3 bg-gray-900/50 rounded-lg">
                        <span className={`text-xs px-2 py-0.5 rounded font-mono ${d.type === 'charger' ? 'bg-amber-900/40 text-amber-300' : 'bg-emerald-900/40 text-emerald-300'}`}>
                          {d.type === 'charger' ? t('wait.importCharger') : t('wait.importMower')}
                        </span>
                        <div className="flex-1">
                          <p className="text-gray-200 text-sm font-mono">{d.sn}</p>
                          {d.version && <p className="text-gray-500 text-xs">{d.version}</p>}
                          {d.type === 'charger' && d.address != null && (
                            <p className="text-gray-500 text-xs">LoRa addr={d.address} ch={d.channel}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => { setImportPhase('idle'); setImportResult(null); }}
                    className="flex-1 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors"
                  >
                    ←
                  </button>
                  <button
                    onClick={handleCloudApply}
                    disabled={getKnownDevices().length === 0}
                    className="flex-1 py-2 bg-blue-700 hover:bg-blue-600 disabled:opacity-40 text-white text-sm font-semibold rounded-lg transition-colors"
                  >
                    {t('wait.importBtn')} →
                  </button>
                </div>
              </div>
            )}

            {importPhase === 'applying' && (
              <div className="flex items-center gap-2 text-blue-400 text-sm">
                <div className="w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
                <span>{t('wait.importing')}</span>
              </div>
            )}

            {importPhase === 'done' && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-emerald-400">
                  <span className="text-lg">✓</span>
                  <p className="font-semibold text-sm">{t('wait.importSuccess')}</p>
                </div>
                <p className="text-gray-400 text-xs">{t('wait.importSuccessDesc')}</p>
                <p className="text-gray-500 text-xs font-mono">{importEmail}</p>
              </div>
            )}
          </div>
        )}
      </div>

      {!mower ? (
        <div className="flex flex-col gap-6">
          {/* Animated waiting indicator */}
          <div className="flex flex-col items-center gap-4 py-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-emerald-900/30 flex items-center justify-center overflow-hidden">
                <img src="/OpenNova.png" alt="OpenNova" className="w-12 h-12 object-contain" />
              </div>
              <div className="absolute inset-0 rounded-full border-2 border-emerald-500/50 animate-ping" />
            </div>
            <p className="text-gray-400 font-mono">{t('wait.waiting')}{dots}</p>
          </div>

          {/* Path A: already cloud-paired */}
          <div className="bg-emerald-900/20 border border-emerald-800/40 rounded-xl p-4">
            <p className="text-emerald-300 text-sm font-semibold mb-1">{t('wait.pathAutoTitle')}</p>
            <p className="text-gray-400 text-sm">{t('wait.pathAutoDesc')}</p>
          </div>

          {/* Path B: new mower via app */}
          <div className="bg-gray-800/40 rounded-xl p-5">
            <p className="text-gray-300 text-sm font-semibold mb-4">{t('wait.pathNewTitle')} — {t('wait.stepsTitle')}</p>
            <div className="space-y-4">
              {(([
                { num: 1, label: t('wait.step1'), sub: t('wait.step1Sub', { ip: ip || '...' }) },
                { num: 2, label: t('wait.step2'), sub: t('wait.step2Sub') },
                { num: 3, label: t('wait.step3'), sub: t('wait.step3Sub') },
                { num: 4, label: t('wait.step4'), sub: null },
              ]) as const).map(({ num, label, sub }) => (
                <div key={num} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-gray-700/60 border border-gray-600/60 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-gray-400 text-xs font-bold">{num}</span>
                  </div>
                  <div>
                    <p className="text-gray-200 text-sm">{label}</p>
                    {sub && <p className="text-gray-500 text-xs mt-0.5">{sub}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
            <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
          </div>
          <div className="text-center">
            <p className="text-emerald-400 font-semibold text-lg">{t('wait.found')}</p>
            <p className="text-gray-300 font-mono text-sm mt-1">{mower.sn}</p>
            <p className="text-gray-500 text-xs">{mower.ip}</p>
          </div>
        </div>
      )}

      <div className="mt-6 p-4 bg-gray-800/40 rounded-xl">
        <p className="text-gray-500 text-xs font-medium uppercase tracking-wide mb-2">{t('wait.statusTitle')}</p>
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">
              MQTT {existingBroker
                ? <span className="text-blue-400">({t('wait.mqttSubscriber').replace('MQTT ', '')})</span>
                : `(${t('wait.mqttBroker').replace('MQTT ', '')})`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">✓</span>
            <span className="text-gray-300">{t('wait.httpServer')}</span>
          </div>
          <div className="flex items-center gap-2">
            {firmware ? <span className="text-emerald-400">✓</span> : <span className="text-yellow-400">○</span>}
            <span className="text-gray-300">
              {firmware ? t('wait.firmwareLoaded', { version: firmware.version }) : t('wait.firmwareNone')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {mower ? <span className="text-emerald-400">✓</span> : <span className="text-gray-600">○</span>}
            <span className="text-gray-300">
              {mower ? t('wait.mowerConnected', { sn: mower.sn }) : <span className="text-gray-600">{t('wait.mowerNone').replace('Mower: ', '').replace('Maaier: ', '').replace('Tondeuse : ', '')}</span>}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
