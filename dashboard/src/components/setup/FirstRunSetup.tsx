import { useState } from 'react';
import { Leaf, Lock, Mail, User, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { createFirstUser } from '../../api/client';

interface Props {
  onComplete: () => void;
}

export function FirstRunSetup({ onComplete }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError(t('setup.account.errRequired'));
      return;
    }
    if (password !== confirm) {
      setError(t('setup.account.errMismatch'));
      return;
    }
    if (password.length < 6) {
      setError(t('setup.account.errTooShort'));
      return;
    }

    setLoading(true);
    try {
      const result = await createFirstUser(email.trim(), password, username.trim() || undefined);
      if (result.ok) {
        onComplete();
      } else {
        setError(result.error ?? t('setup.account.errGeneric'));
      }
    } catch {
      setError(t('setup.account.errUnreachable'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Logo + titel */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-emerald-900/40 rounded-2xl flex items-center justify-center mb-4 border border-emerald-800/40">
            <Leaf className="w-8 h-8 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-white">{t('setup.welcome.title')}</h1>
          <p className="text-sm text-gray-400 mt-1 text-center">{t('setup.account.subtitle')}</p>
        </div>

        {/* Privacy melding */}
        <div className="flex items-start gap-2.5 bg-blue-950/40 border border-blue-800/40 rounded-lg px-3.5 py-3 mb-6">
          <ShieldCheck className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-blue-300 leading-relaxed">
            <Trans i18nKey="setup.account.privacy" components={{ b: <strong /> }} />{' '}
            {t('setup.account.privacyScope')}
          </p>
        </div>

        {/* Formulier */}
        <form onSubmit={handleSubmit} className="space-y-4">

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('setup.account.name')} <span className="text-gray-600">({t('setup.account.optional')})</span></label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder={t('setup.account.namePlaceholder')}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('setup.account.email')}</label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder={t('setup.account.emailPlaceholder')}
                required
                className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('setup.account.password')}</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder={t('setup.account.passwordPlaceholder')}
                required
                className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-10 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
              />
              <button
                type="button"
                onClick={() => setShowPassword(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-400 mb-1.5">{t('setup.account.confirm')}</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={t('setup.account.confirmPlaceholder')}
                required
                className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
              />
            </div>
          </div>

          {error && (
            <div className="bg-red-950/40 border border-red-800/40 rounded-lg px-3 py-2.5 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm py-2.5 rounded-lg transition-colors mt-2"
          >
            {loading ? t('setup.account.creating') : t('setup.account.submit')}
          </button>
        </form>

        <p className="text-center text-xs text-gray-600 mt-6">
          {t('setup.account.useInApp')}
        </p>
      </div>
    </div>
  );
}
