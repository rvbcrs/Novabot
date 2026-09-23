import { useState, useEffect, useRef } from 'react';
import {
  Leaf, ShieldCheck, Download, CheckCircle, Lock, Mail, User,
  Eye, EyeOff, ChevronDown, ChevronUp, Loader2, ArrowRight,
} from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import type { TFunction } from 'i18next';
import { createFirstUser, checkCertTrusted } from '../../api/client';

/** Translate a numbered list of steps: `${prefix}.s1` … `${prefix}.s${n}`. */
function stepList(t: TFunction, prefix: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => t(`${prefix}.s${i + 1}`));
}

type Step = 'welcome' | 'account' | 'cert' | 'done';

interface Props {
  /** Sla account-stap over als er al een gebruiker bestaat */
  skipAccount?: boolean;
  onComplete: () => void;
}

export function OnboardingWizard({ skipAccount = false, onComplete }: Props) {
  const initialStep: Step = skipAccount ? 'cert' : 'welcome';
  const [step, setStep] = useState<Step>(initialStep);

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center px-4 py-12">
      <ProgressBar step={step} skipAccount={skipAccount} />
      <div className="w-full max-w-md mt-8">
        {step === 'welcome' && <WelcomeStep onNext={() => setStep('account')} />}
        {step === 'account' && <AccountStep onNext={() => setStep('cert')} />}
        {step === 'cert'    && <CertStep onComplete={onComplete} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Stap-indicator
// ─────────────────────────────────────────────

const STEPS_FULL:   Step[] = ['welcome', 'account', 'cert'];
const STEPS_NO_ACC: Step[] = ['welcome', 'cert'];

function ProgressBar({ step, skipAccount }: { step: Step; skipAccount: boolean }) {
  const steps = skipAccount ? STEPS_NO_ACC : STEPS_FULL;
  const current = steps.indexOf(step);

  return (
    <div className="flex items-center gap-2">
      {steps.map((s, i) => (
        <div key={s} className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full transition-colors ${
            i < current  ? 'bg-emerald-500' :
            i === current ? 'bg-emerald-400' :
            'bg-gray-700'
          }`} />
          {i < steps.length - 1 && (
            <div className={`w-8 h-px transition-colors ${i < current ? 'bg-emerald-700' : 'bg-gray-800'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────
// Stap 1 — Welkom
// ─────────────────────────────────────────────

function WelcomeStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="text-center space-y-6">
      <div className="flex justify-center">
        <div className="w-20 h-20 bg-emerald-900/40 rounded-3xl flex items-center justify-center border border-emerald-800/40">
          <Leaf className="w-10 h-10 text-emerald-400" />
        </div>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-white">{t('setup.welcome.title')}</h1>
        <p className="text-gray-400 mt-2 text-sm leading-relaxed">
          {t('setup.welcome.subtitle')}
        </p>
      </div>

      <div className="text-left bg-gray-900/60 border border-gray-800 rounded-xl p-5 space-y-3">
        <Feature
          icon="🌿"
          title={t('setup.welcome.localTitle')}
          desc={t('setup.welcome.localDesc')}
        />
        <Feature
          icon="🔒"
          title={t('setup.welcome.privacyTitle')}
          desc={t('setup.welcome.privacyDesc')}
        />
        <Feature
          icon="📡"
          title={t('setup.welcome.appTitle')}
          desc={t('setup.welcome.appDesc')}
        />
      </div>

      <button
        onClick={onNext}
        className="w-full flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 text-white font-medium py-3 rounded-xl transition-colors text-sm"
      >
        {t('setup.welcome.start')}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

function Feature({ icon, title, desc }: { icon: string; title: string; desc: string }) {
  return (
    <div className="flex gap-3">
      <span className="text-lg leading-none mt-0.5 flex-shrink-0">{icon}</span>
      <div>
        <div className="text-sm font-medium text-gray-200">{title}</div>
        <div className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Stap 2 — Account aanmaken
// ─────────────────────────────────────────────

function AccountStep({ onNext }: { onNext: () => void }) {
  const { t } = useTranslation();
  const [email, setEmail]       = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm]   = useState('');
  const [showPw, setShowPw]     = useState(false);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) { setError(t('setup.account.errRequired')); return; }
    if (password !== confirm)        { setError(t('setup.account.errMismatch')); return; }
    if (password.length < 6)         { setError(t('setup.account.errTooShort')); return; }

    setLoading(true);
    try {
      const result = await createFirstUser(email.trim(), password, username.trim() || undefined);
      if (result.ok) { onNext(); }
      else           { setError(result.error ?? t('setup.account.errGeneric')); }
    } catch {
      setError(t('setup.account.errUnreachable'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">{t('setup.account.title')}</h2>
        <p className="text-sm text-gray-400 mt-1">
          {t('setup.account.intro')}
        </p>
      </div>

      <div className="flex items-start gap-2.5 bg-blue-950/40 border border-blue-800/40 rounded-lg px-3.5 py-3 mb-5">
        <ShieldCheck className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-300 leading-relaxed">
          <Trans i18nKey="setup.account.privacy" components={{ b: <strong /> }} />
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label={t('setup.account.name')} hint={t('setup.account.optional')}>
          <FieldInput icon={User} type="text" value={username} onChange={setUsername} placeholder={t('setup.account.namePlaceholder')} />
        </Field>
        <Field label={t('setup.account.email')}>
          <FieldInput icon={Mail} type="email" value={email} onChange={setEmail} placeholder={t('setup.account.emailPlaceholder')} required />
        </Field>
        <Field label={t('setup.account.password')}>
          <div className="relative">
            <FieldInput icon={Lock} type={showPw ? 'text' : 'password'} value={password} onChange={setPassword} placeholder={t('setup.account.passwordPlaceholder')} required />
            <button type="button" onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </Field>
        <Field label={t('setup.account.confirm')}>
          <FieldInput icon={Lock} type={showPw ? 'text' : 'password'} value={confirm} onChange={setConfirm} placeholder={t('setup.account.confirmPlaceholder')} required />
        </Field>

        {error && (
          <div className="bg-red-950/40 border border-red-800/40 rounded-lg px-3 py-2.5 text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium py-3 rounded-xl transition-colors text-sm mt-2"
        >
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" />{t('setup.account.creating')}</> : <>{t('setup.account.submit')} <ArrowRight className="w-4 h-4" /></>}
        </button>
      </form>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1.5">
        {label} {hint && <span className="text-gray-600">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function FieldInput({ icon: Icon, type, value, onChange, placeholder, required }: {
  icon: React.ComponentType<{ className?: string }>;
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div className="relative">
      <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-600" />
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        className="w-full bg-gray-900 border border-gray-700 rounded-lg pl-9 pr-3 py-2.5 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-600 transition-colors"
      />
    </div>
  );
}

// ─────────────────────────────────────────────
// Stap 3 — Certificaat installeren (auto-detect)
// ─────────────────────────────────────────────

function CertStep({ onComplete }: { onComplete: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'waiting' | 'detected' | 'manual-fail'>('waiting');
  const [openGuide, setOpenGuide] = useState<string | null>('mac');
  const [manualChecking, setManualChecking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedRef = useRef(false);

  // Poll elke 2 seconden automatisch
  useEffect(() => {
    stoppedRef.current = false;

    const advance = () => {
      setStatus('detected');
      if (intervalRef.current) clearInterval(intervalRef.current);
      setTimeout(() => { if (!stoppedRef.current) onComplete(); }, 1200);
    };

    const poll = async () => {
      const trusted = await checkCertTrusted();
      if (!stoppedRef.current && trusted) advance();
    };

    poll();
    intervalRef.current = setInterval(poll, 2000);

    return () => {
      stoppedRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [onComplete]);

  const handleManualCheck = async () => {
    setManualChecking(true);
    const trusted = await checkCertTrusted();
    setManualChecking(false);
    if (trusted) {
      stoppedRef.current = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      setStatus('detected');
      setTimeout(onComplete, 1200);
    } else {
      setStatus('manual-fail');
    }
  };

  const detected = status === 'detected';

  return (
    <div>
      <div className="mb-6 flex flex-col items-center text-center">
        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-4 border transition-colors ${
          detected
            ? 'bg-emerald-900/40 border-emerald-700/40'
            : 'bg-amber-900/30 border-amber-700/40'
        }`}>
          {detected
            ? <CheckCircle className="w-8 h-8 text-emerald-400" />
            : <ShieldCheck className="w-8 h-8 text-amber-400" />
          }
        </div>
        <h2 className="text-xl font-bold text-white">
          {detected ? t('setup.cert.detected') : t('setup.cert.title')}
        </h2>
        <p className="text-sm text-gray-400 mt-1 leading-relaxed">
          {detected
            ? t('setup.cert.redirecting')
            : t('setup.cert.intro')
          }
        </p>
      </div>

      {!detected && (
        <>
          {/* Download */}
          <a
            href="/api/dashboard/setup/ca-cert"
            download="opennova-ca.crt"
            className="flex items-center justify-center gap-2.5 w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-xl transition-colors mb-5 text-sm"
          >
            <Download className="w-4 h-4" />
            {t('setup.cert.download')}
          </a>

          {/* Installatie gidsen */}
          <div className="space-y-2 mb-5">
            <Guide
              title={t('setup.cert.macTitle')}
              open={openGuide === 'mac'}
              onToggle={() => setOpenGuide(g => g === 'mac' ? null : 'mac')}
              steps={stepList(t, 'setup.cert.mac', 6)}
            />
            <Guide
              title="iPhone / iPad"
              open={openGuide === 'iphone'}
              onToggle={() => setOpenGuide(g => g === 'iphone' ? null : 'iphone')}
              steps={stepList(t, 'setup.cert.iphoneStrict', 6)}
            />
            <Guide
              title="Android"
              open={openGuide === 'android'}
              onToggle={() => setOpenGuide(g => g === 'android' ? null : 'android')}
              steps={stepList(t, 'setup.cert.androidSend', 3)}
            />
          </div>

          {/* Auto-detect status + handmatige fallback */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2.5 mb-3">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
              <div>
                <p className="text-xs text-gray-300 font-medium">{t('setup.cert.autoDetect')}</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {t('setup.cert.autoDetectHint')}
                </p>
              </div>
            </div>
            <button
              onClick={handleManualCheck}
              disabled={manualChecking}
              className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 transition-colors"
            >
              <Loader2 className={`w-3.5 h-3.5 ${manualChecking ? 'animate-spin' : 'opacity-0'}`} />
              {manualChecking ? t('setup.cert.checking') : t('setup.cert.checkManual')}
            </button>
          </div>

          {status === 'manual-fail' && (
            <div className="bg-red-950/30 border border-red-800/30 rounded-xl px-4 py-3 text-xs text-red-300 leading-relaxed">
              <Trans i18nKey="setup.cert.notTrustedIphone" components={{ b: <strong /> }} />
            </div>
          )}

          <p className="text-center text-[11px] text-gray-600 mt-4">
            {t('setup.cert.scope')}
          </p>
        </>
      )}
    </div>
  );
}

function Guide({ title, open, onToggle, steps }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  steps: string[];
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between px-3.5 py-2.5 text-left">
        <span className="text-xs font-medium text-gray-300">{title}</span>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        }
      </button>
      {open && (
        <ol className="px-3.5 pb-3 space-y-1.5 border-t border-gray-800 pt-2.5">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-[11px] text-gray-400 leading-relaxed">
              <span className="text-gray-600 font-mono flex-shrink-0">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
