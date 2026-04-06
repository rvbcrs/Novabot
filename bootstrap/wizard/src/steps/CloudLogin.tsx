import { useEffect, useState } from 'react';
import { useT } from '../i18n/index.ts';

interface Props {
  onDone: (imported: boolean) => void;   // true = import geslaagd, false = overgeslagen
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

interface FetchResult {
  email: string;
  appUserId: number;
  chargers: CloudDevice[];
  mowers: CloudDevice[];
  rawList: CloudDevice[];
}

interface ExistingAccount {
  email: string;
  username?: string;
  devices: { type: string; sn: string; version?: string }[];
}

type Phase = 'checking' | 'existing' | 'form' | 'fetching' | 'preview' | 'applying' | 'done' | 'error';

export default function CloudLogin({ onDone }: Props) {
  const { t } = useT();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState('');
  const [result, setResult] = useState<FetchResult | null>(null);
  const [existingAccount, setExistingAccount] = useState<ExistingAccount | null>(null);

  // On mount: check for existing account in Docker DB
  useEffect(() => {
    (async () => {
      try {
        const resp = await fetch('/api/existing-account');
        const data = await resp.json() as { hasAccount?: boolean; email?: string; username?: string; devices?: { type: string; sn: string; version?: string }[] };
        if (data.hasAccount && data.email) {
          setExistingAccount({ email: data.email, username: data.username ?? undefined, devices: data.devices ?? [] });
          setPhase('existing');
        } else {
          setPhase('form');
        }
      } catch {
        setPhase('form');
      }
    })();
  }, []);

  async function handleFetch() {
    if (!email || !password) return;
    setPhase('fetching');
    setError('');

    try {
      const resp = await fetch('/api/cloud-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await resp.json() as { ok?: boolean; error?: string } & FetchResult;

      if (!resp.ok || !data.ok) {
        setError(data.error ?? t('cloudLogin.errorLogin'));
        setPhase('error');
        return;
      }

      setResult(data);
      setPhase('preview');
    } catch {
      setError(t('cloudLogin.errorNetwork'));
      setPhase('error');
    }
  }

  async function handleApply() {
    if (!result) return;
    setPhase('applying');
    setError('');

    const chargerEntry = result.chargers[0] ?? result.rawList.find(e => {
      const sn = String(e.chargerSn ?? e.sn ?? '');
      return sn.startsWith('LFIC');
    });

    const mowerEntry = result.mowers[0] ?? result.rawList.find(e => {
      const sn = String(e.mowerSn ?? e.sn ?? '');
      return sn.startsWith('LFIN');
    });

    const chargerSn = String(chargerEntry?.chargerSn ?? chargerEntry?.sn ?? '');
    const mowerSn = String(mowerEntry?.mowerSn ?? mowerEntry?.sn ?? '');

    if (!chargerSn) {
      setError('Geen laadstation gevonden in cloud account.');
      setPhase('error');
      return;
    }

    try {
      const resp = await fetch('/api/cloud-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
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
        setError(data.error ?? t('cloudLogin.errorApply'));
        setPhase('error');
        return;
      }

      setPhase('done');
    } catch {
      setError(t('cloudLogin.errorApply'));
      setPhase('error');
    }
  }

  function getDevices() {
    if (!result) return [];
    const items: Array<{ type: 'charger' | 'mower'; sn: string; version?: string; address?: number; channel?: number }> = [];
    for (const e of result.rawList) {
      const rawSn = String(e.sn ?? '');
      const chargerSn = String(e.chargerSn ?? (rawSn.startsWith('LFIC') ? rawSn : ''));
      const mowerSn = String(e.mowerSn ?? (rawSn.startsWith('LFIN') ? rawSn : ''));
      if (chargerSn.startsWith('LFIC') && !items.some(i => i.sn === chargerSn)) {
        items.push({ type: 'charger', sn: chargerSn, version: e.chargerVersion as string | undefined, address: e.chargerAddress as number | undefined, channel: e.chargerChannel as number | undefined });
      }
      if (mowerSn.startsWith('LFIN') && !items.some(i => i.sn === mowerSn)) {
        items.push({ type: 'mower', sn: mowerSn, version: e.mowerVersion as string | undefined });
      }
    }
    return items;
  }

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('cloudLogin.title')}</h2>
      <p className="text-gray-400 mb-8 text-sm">{t('cloudLogin.description')}</p>

      {/* ── Checking for existing account ── */}
      {phase === 'checking' && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">{t('cloudLogin.existingLoading')}</p>
        </div>
      )}

      {/* ── Existing account found ── */}
      {phase === 'existing' && existingAccount && (
        <div className="space-y-4">
          <div className="p-5 bg-emerald-900/20 border border-emerald-700/40 rounded-xl">
            <p className="text-emerald-400 font-semibold text-sm mb-1">{t('cloudLogin.existingTitle')}</p>
            <p className="text-gray-400 text-xs mb-4">{t('cloudLogin.existingDesc')}</p>

            <div className="space-y-3">
              {/* Email */}
              <div className="flex items-center gap-3">
                <span className="text-gray-500 text-xs w-12 flex-shrink-0">{t('cloudLogin.existingEmail')}</span>
                <span className="text-white text-sm font-mono">{existingAccount.email}</span>
              </div>

              {/* Devices */}
              {existingAccount.devices.length > 0 && (
                <div>
                  <span className="text-gray-500 text-xs">{t('cloudLogin.existingDevices')}</span>
                  <div className="mt-1.5 space-y-1.5">
                    {existingAccount.devices.map((d, i) => (
                      <div key={i} className="flex items-center gap-2 p-2.5 bg-gray-800/50 rounded-lg">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${d.type === 'charger' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                        <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${d.type === 'charger' ? 'bg-amber-900/40 text-amber-300' : 'bg-emerald-900/40 text-emerald-300'}`}>
                          {d.type === 'charger' ? t('cloudLogin.charger') : t('cloudLogin.mower')}
                        </span>
                        <span className="text-gray-200 text-sm font-mono">{d.sn}</span>
                        {d.version && <span className="text-gray-600 text-xs ml-auto">{d.version}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={() => onDone(true)}
            className="w-full py-3 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('cloudLogin.existingUseBtn')}
          </button>

          <div className="text-center">
            <button
              onClick={() => setPhase('form')}
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              {t('cloudLogin.existingChangeBtn')}
            </button>
          </div>
        </div>
      )}

      {/* ── Form ── */}
      {(phase === 'form' || phase === 'error') && (
        <div className="space-y-4">
          <div className="space-y-3">
            <input
              type="email"
              placeholder={t('cloudLogin.email')}
              value={email}
              autoFocus
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-gray-900/60 border border-gray-700 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
            <input
              type="password"
              placeholder={t('cloudLogin.password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleFetch()}
              className="w-full bg-gray-900/60 border border-gray-700 rounded-lg px-4 py-3 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          {error && (
            <div className="p-3 bg-red-900/20 border border-red-800/40 rounded-lg">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          <button
            onClick={handleFetch}
            disabled={!email || !password}
            className="w-full py-3 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
          >
            {t('cloudLogin.importBtn')}
          </button>

          <div className="text-center pt-2">
            <button
              onClick={() => onDone(false)}
              className="text-gray-500 hover:text-gray-300 text-sm transition-colors"
            >
              {t('cloudLogin.skipBtn')}
            </button>
            <p className="text-gray-600 text-xs mt-1">{t('cloudLogin.skipHint')}</p>
          </div>
        </div>
      )}

      {/* ── Loading ── */}
      {(phase === 'fetching' || phase === 'applying') && (
        <div className="flex flex-col items-center gap-4 py-8">
          <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400 text-sm">
            {phase === 'fetching' ? t('cloudLogin.fetching') : t('cloudLogin.applying')}
          </p>
        </div>
      )}

      {/* ── Preview ── */}
      {phase === 'preview' && (
        <div className="space-y-4">
          <p className="text-gray-300 text-sm font-semibold">{t('cloudLogin.previewTitle')}</p>

          {getDevices().length === 0 ? (
            <p className="text-gray-400 text-sm">{t('cloudLogin.noDevices')}</p>
          ) : (
            <div className="space-y-2">
              {getDevices().map((d, i) => (
                <div key={i} className="flex items-center gap-3 p-4 bg-gray-800/50 border border-gray-700/40 rounded-xl">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${d.type === 'charger' ? 'bg-amber-400' : 'bg-emerald-400'}`} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${d.type === 'charger' ? 'bg-amber-900/40 text-amber-300' : 'bg-emerald-900/40 text-emerald-300'}`}>
                        {d.type === 'charger' ? t('cloudLogin.charger') : t('cloudLogin.mower')}
                      </span>
                      <span className="text-gray-200 text-sm font-mono">{d.sn}</span>
                    </div>
                    {d.version && <p className="text-gray-500 text-xs mt-0.5">{d.version}</p>}
                    {d.type === 'charger' && d.address != null && (
                      <p className="text-gray-600 text-xs">LoRa addr={d.address} ch={d.channel}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={() => { setPhase('form'); setResult(null); }}
              className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm font-semibold rounded-xl transition-colors"
            >
              {t('cloudLogin.backBtn')}
            </button>
            <button
              onClick={handleApply}
              disabled={getDevices().length === 0}
              className="flex-2 px-6 py-3 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              {t('cloudLogin.confirmBtn')}
            </button>
          </div>

          <div className="text-center">
            <button onClick={() => onDone(false)} className="text-gray-600 hover:text-gray-400 text-xs transition-colors">
              {t('cloudLogin.skipBtn')}
            </button>
          </div>
        </div>
      )}

      {/* ── Success ── */}
      {phase === 'done' && (
        <div className="space-y-6">
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="w-16 h-16 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center">
              <span className="text-3xl">&#10003;</span>
            </div>
            <div className="text-center">
              <p className="text-emerald-400 font-semibold text-lg">{t('cloudLogin.successTitle')}</p>
              <p className="text-gray-400 text-sm mt-1">{t('cloudLogin.successDesc')}</p>
              <p className="text-gray-500 text-xs font-mono mt-2">{email}</p>
            </div>
          </div>

          {/* Imported devices summary */}
          <div className="space-y-2">
            {getDevices().map((d, i) => (
              <div key={i} className="flex items-center gap-2 p-3 bg-gray-800/40 rounded-lg">
                <span className="text-emerald-400 text-sm">&#10003;</span>
                <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${d.type === 'charger' ? 'bg-amber-900/40 text-amber-300' : 'bg-emerald-900/40 text-emerald-300'}`}>
                  {d.type === 'charger' ? t('cloudLogin.charger') : t('cloudLogin.mower')}
                </span>
                <span className="text-gray-300 text-sm font-mono">{d.sn}</span>
              </div>
            ))}
          </div>

          <button
            onClick={() => onDone(true)}
            className="w-full py-3 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
          >
            {t('cloudLogin.nextBtn')}
          </button>
        </div>
      )}
    </div>
  );
}
