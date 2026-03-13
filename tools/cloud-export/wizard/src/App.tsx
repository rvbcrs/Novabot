import { useState, useMemo, useEffect } from 'react';
import Welcome from './steps/Welcome.tsx';
import CloudLogin from './steps/CloudLogin.tsx';
import DataPreview from './steps/DataPreview.tsx';
import Done from './steps/Done.tsx';
import { I18nContext, createT, detectLocale, LOCALE_LABELS, type Locale } from './i18n/index.ts';

type Step = 0 | 1 | 2 | 3;

interface LoginData {
  accessToken: string;
  appUserId: number;
  email: string;
  password: string;
  userInfo: { firstName: string; lastName: string; country: string; city: string; registerTime: string };
  devices: Record<string, unknown>[];
  chargerCount: number;
  mowerCount: number;
}

interface ExportResult {
  outputDir: string;
  totalFiles: number;
  totalSize: number;
  devices: number;
  workRecords: number;
  messages: number;
  hasZip: boolean;
}

const STEP_KEYS = ['steps.welcome', 'steps.login', 'steps.export', 'steps.done'];

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const [loginData, setLoginData] = useState<LoginData | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);
  const [version, setVersion] = useState('');

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(d => setVersion(d.version ?? '')).catch(() => {});
  }, []);

  const t = useMemo(() => createT(locale), [locale]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    localStorage.setItem('novabot-export-locale', l);
  };

  const handleLogin = (data: LoginData) => {
    setLoginData(data);
    setStep(2);
  };

  const handleExportDone = (result: ExportResult) => {
    setExportResult(result);
    setStep(3);
  };

  const handleRestart = () => {
    setLoginData(null);
    setExportResult(null);
    setStep(0);
  };

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      <div className="min-h-screen flex flex-col items-center justify-center p-6">
        {/* Background glow */}
        <div className="fixed inset-0 -z-10">
          <div className="absolute top-1/4 left-1/3 w-96 h-96 bg-sky-500/10 rounded-full blur-3xl" />
          <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-indigo-500/10 rounded-full blur-3xl" />
        </div>

        {/* Language selector */}
        <div className="fixed top-4 right-4 flex gap-1 z-50">
          {(Object.keys(LOCALE_LABELS) as Locale[]).map(l => (
            <button
              key={l}
              onClick={() => setLocale(l)}
              className={`px-2 py-1 text-xs rounded transition-all ${
                locale === l
                  ? 'bg-sky-600 text-white'
                  : 'bg-white/10 text-gray-400 hover:text-white hover:bg-white/20'
              }`}
            >
              {LOCALE_LABELS[l]}
            </button>
          ))}
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-3 mb-8">
          {STEP_KEYS.map((key, i) => (
            <div key={key} className="flex items-center gap-3">
              {i > 0 && <div className={`w-8 h-px ${i <= step ? 'bg-sky-500' : 'bg-gray-700'}`} />}
              <div className="flex items-center gap-2">
                <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  i < step ? 'bg-sky-600 text-white' :
                  i === step ? 'bg-sky-500/20 text-sky-400 ring-2 ring-sky-500' :
                  'bg-gray-800 text-gray-500'
                }`}>
                  {i < step ? '✓' : i + 1}
                </div>
                <span className={`text-xs hidden sm:inline ${i <= step ? 'text-gray-300' : 'text-gray-600'}`}>
                  {t(key)}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="w-full max-w-xl">
          {step === 0 && <Welcome onNext={() => setStep(1)} />}
          {step === 1 && <CloudLogin onLogin={handleLogin} />}
          {step === 2 && loginData && <DataPreview loginData={loginData} onDone={handleExportDone} />}
          {step === 3 && exportResult && <Done result={exportResult} onRestart={handleRestart} />}
        </div>

        {/* Version footer */}
        {version && (
          <p className="mt-8 text-xs text-gray-600">Novabot Cloud Export v{version}</p>
        )}
      </div>
    </I18nContext.Provider>
  );
}
