import { useState } from 'react';
import { useT } from '../i18n/index.ts';

interface LoginResult {
  accessToken: string;
  appUserId: number;
  email: string;
  password: string;
  userInfo: { firstName: string; lastName: string; country: string; city: string; registerTime: string };
  devices: Record<string, unknown>[];
  chargerCount: number;
  mowerCount: number;
}

interface Props {
  onLogin: (data: LoginResult) => void;
}

export default function CloudLogin({ onLogin }: Props) {
  const { t } = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LoginResult | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const resp = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await resp.json();

      if (!resp.ok) {
        if (resp.status === 503) {
          setError(t('login.error_unreachable'));
        } else if (resp.status === 401) {
          setError(t('login.error_credentials'));
        } else {
          setError(t('login.error_generic', { error: data.error || 'Unknown error' }));
        }
        return;
      }

      const loginResult: LoginResult = {
        accessToken: data.accessToken,
        appUserId: data.appUserId,
        email,
        password,
        userInfo: data.userInfo,
        devices: data.devices,
        chargerCount: data.chargerCount,
        mowerCount: data.mowerCount,
      };
      setResult(loginResult);
    } catch (err) {
      setError(t('login.error_generic', { error: err instanceof Error ? err.message : 'Network error' }));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="glass-card p-8">
      <div className="relative z-10">
        <div className="text-center mb-6">
          <div className="text-4xl mb-3">🔑</div>
          <h2 className="text-xl font-bold text-white mb-1">{t('login.title')}</h2>
          <p className="text-gray-400 text-sm">{t('login.subtitle')}</p>
        </div>

        {!result ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">{t('login.email')}</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">{t('login.password')}</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-sky-500/50"
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-3">
                <p className="text-red-300 text-sm">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !email || !password}
              className="w-full py-3 bg-sky-600 hover:bg-sky-500 disabled:bg-gray-700 disabled:text-gray-500 text-white font-semibold rounded-xl transition-all"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  {t('login.logging_in')}
                </span>
              ) : t('login.login')}
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4">
              <p className="text-emerald-300 font-semibold mb-2">✓ {t('login.success')}</p>
              <p className="text-gray-300 text-sm">
                {t('login.account_info', {
                  name: `${result.userInfo.firstName} ${result.userInfo.lastName}`.trim() || result.email,
                })}
              </p>
              {result.userInfo.registerTime && (
                <p className="text-gray-400 text-sm">
                  {t('login.registered', { date: result.userInfo.registerTime })}
                </p>
              )}
            </div>

            <div className="bg-white/5 rounded-xl p-4">
              <p className="text-sky-300 text-sm font-medium">
                {t('login.found_devices', {
                  chargers: result.chargerCount,
                  mowers: result.mowerCount,
                })}
              </p>
              <div className="mt-2 space-y-1">
                {result.devices.map((d, i) => {
                  const sn = String(d.sn ?? d.chargerSn ?? d.mowerSn ?? '');
                  const type = sn.startsWith('LFIC') ? '🔌' : sn.startsWith('LFIN') ? '🤖' : '❓';
                  const version = String(d.sysVersion ?? d.mowerVersion ?? d.chargerVersion ?? '');
                  return (
                    <div key={i} className="flex items-center justify-between text-xs text-gray-400">
                      <span>{type} {sn}</span>
                      {version && <span className="text-gray-500">{version}</span>}
                    </div>
                  );
                })}
              </div>
            </div>

            <button
              onClick={() => onLogin(result)}
              className="w-full py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-xl transition-all"
            >
              {t('login.next')} →
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
