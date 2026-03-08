import { useState, useEffect, useRef } from 'react';
import {
  Leaf, ShieldCheck, Download, CheckCircle, Lock, Mail, User,
  Eye, EyeOff, ChevronDown, ChevronUp, Loader2, ArrowRight,
} from 'lucide-react';
import { createFirstUser, checkCertTrusted } from '../../api/client';

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
  return (
    <div className="text-center space-y-6">
      <div className="flex justify-center">
        <div className="w-20 h-20 bg-emerald-900/40 rounded-3xl flex items-center justify-center border border-emerald-800/40">
          <Leaf className="w-10 h-10 text-emerald-400" />
        </div>
      </div>

      <div>
        <h1 className="text-3xl font-bold text-white">Welkom bij OpenNova</h1>
        <p className="text-gray-400 mt-2 text-sm leading-relaxed">
          Je persoonlijke cloudvervanging voor je robotmaaier
        </p>
      </div>

      <div className="text-left bg-gray-900/60 border border-gray-800 rounded-xl p-5 space-y-3">
        <Feature
          icon="🌿"
          title="Volledig lokaal"
          desc="Je maaier en laadstation verbinden met deze container in plaats van servers in China."
        />
        <Feature
          icon="🔒"
          title="Geen dataverzameling"
          desc="Al je gegevens blijven op je eigen netwerk. Geen abonnement, geen cloud afhankelijkheid."
        />
        <Feature
          icon="📡"
          title="Zelfde app"
          desc="Gebruik de gewone Novabot app — alleen de verbinding gaat via jouw server."
        />
      </div>

      <button
        onClick={onNext}
        className="w-full flex items-center justify-center gap-2 bg-emerald-700 hover:bg-emerald-600 text-white font-medium py-3 rounded-xl transition-colors text-sm"
      >
        Aan de slag
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
    if (!email.trim() || !password) { setError('Vul je e-mailadres en wachtwoord in.'); return; }
    if (password !== confirm)        { setError('Wachtwoorden komen niet overeen.'); return; }
    if (password.length < 6)         { setError('Wachtwoord moet minimaal 6 tekens bevatten.'); return; }

    setLoading(true);
    try {
      const result = await createFirstUser(email.trim(), password, username.trim() || undefined);
      if (result.ok) { onNext(); }
      else           { setError(result.error ?? 'Er is een fout opgetreden.'); }
    } catch {
      setError('Kan de server niet bereiken.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white">Account aanmaken</h2>
        <p className="text-sm text-gray-400 mt-1">
          Dit account gebruik je ook om in te loggen in de Novabot app.
        </p>
      </div>

      <div className="flex items-start gap-2.5 bg-blue-950/40 border border-blue-800/40 rounded-lg px-3.5 py-3 mb-5">
        <ShieldCheck className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-blue-300 leading-relaxed">
          Je gegevens blijven lokaal in de Docker container en worden <strong>nergens naartoe gestuurd</strong>.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Naam" hint="optioneel">
          <FieldInput icon={User} type="text" value={username} onChange={setUsername} placeholder="Jouw naam" />
        </Field>
        <Field label="E-mailadres">
          <FieldInput icon={Mail} type="email" value={email} onChange={setEmail} placeholder="jij@example.com" required />
        </Field>
        <Field label="Wachtwoord">
          <div className="relative">
            <FieldInput icon={Lock} type={showPw ? 'text' : 'password'} value={password} onChange={setPassword} placeholder="Minimaal 6 tekens" required />
            <button type="button" onClick={() => setShowPw(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400">
              {showPw ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </Field>
        <Field label="Wachtwoord bevestigen">
          <FieldInput icon={Lock} type={showPw ? 'text' : 'password'} value={confirm} onChange={setConfirm} placeholder="Herhaal wachtwoord" required />
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
          {loading ? <><Loader2 className="w-4 h-4 animate-spin" />Aanmaken...</> : <>Account aanmaken <ArrowRight className="w-4 h-4" /></>}
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
          {detected ? 'Certificaat gedetecteerd!' : 'Certificaat installeren'}
        </h2>
        <p className="text-sm text-gray-400 mt-1 leading-relaxed">
          {detected
            ? 'Je wordt doorgestuurd naar het dashboard...'
            : 'De Novabot app gebruikt HTTPS. Installeer het lokale CA-certificaat zodat de app kan verbinden.'
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
            Download opennova-ca.crt
          </a>

          {/* Installatie gidsen */}
          <div className="space-y-2 mb-5">
            <Guide
              title="Mac (inclusief iOS app op Apple Silicon)"
              open={openGuide === 'mac'}
              onToggle={() => setOpenGuide(g => g === 'mac' ? null : 'mac')}
              steps={[
                'Download opennova-ca.crt en dubbelklik → Keychain Access opent',
                'Het cert staat nu in de System keychain maar is nog NIET vertrouwd',
                'Dubbelklik op "OpenNova Local CA" in de lijst',
                'Klap "Trust" open (klik op het driehoekje)',
                'Zet "When using this certificate" op "Always Trust"',
                'Sluit het venster → voer je Mac-wachtwoord in als gevraagd',
              ]}
            />
            <Guide
              title="iPhone / iPad"
              open={openGuide === 'iphone'}
              onToggle={() => setOpenGuide(g => g === 'iphone' ? null : 'iphone')}
              steps={[
                'Stuur het .crt bestand naar je iPhone (AirDrop of mail)',
                'Tik op het bestand → "Profiel gedownload" verschijnt bovenaan',
                'Ga naar Instellingen → bovenaan "Profiel gedownload" → Installeer → Installeer',
                '⚠️ VERPLICHTE EXTRA STAP: Ga naar Instellingen → Algemeen → Info → Certificaatvertrouwen',
                'Zet de schakelaar bij "OpenNova Local CA" aan → Doorgaan',
                'Zonder deze stap werkt het certificaat niet!',
              ]}
            />
            <Guide
              title="Android"
              open={openGuide === 'android'}
              onToggle={() => setOpenGuide(g => g === 'android' ? null : 'android')}
              steps={[
                'Stuur opennova-ca.crt naar je Android toestel',
                'Ga naar Instellingen → Beveiliging → Certificaten installeren',
                'Kies "CA-certificaat" en selecteer het bestand',
              ]}
            />
          </div>

          {/* Auto-detect status + handmatige fallback */}
          <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
            <div className="flex items-center gap-2.5 mb-3">
              <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
              <div>
                <p className="text-xs text-gray-300 font-medium">Automatisch detecteren...</p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  Het dashboard gaat vanzelf verder zodra het certificaat vertrouwd is.
                </p>
              </div>
            </div>
            <button
              onClick={handleManualCheck}
              disabled={manualChecking}
              className="w-full flex items-center justify-center gap-1.5 text-xs py-2 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 transition-colors"
            >
              <Loader2 className={`w-3.5 h-3.5 ${manualChecking ? 'animate-spin' : 'opacity-0'}`} />
              {manualChecking ? 'Controleren...' : 'Controleer handmatig'}
            </button>
          </div>

          {status === 'manual-fail' && (
            <div className="bg-red-950/30 border border-red-800/30 rounded-xl px-4 py-3 text-xs text-red-300 leading-relaxed">
              Certificaat nog niet vertrouwd. Op iPhone: controleer of je de schakelaar bij
              {' '}<strong>Instellingen → Algemeen → Info → Certificaatvertrouwen</strong>{' '}
              hebt aangezet.
            </div>
          )}

          <p className="text-center text-[11px] text-gray-600 mt-4">
            Dit certificaat is alleen geldig voor *.lfibot.com op je lokale netwerk.
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
