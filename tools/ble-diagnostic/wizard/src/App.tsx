import { useState, useCallback } from 'react';
import { I18nContext, createT, detectLocale, LOCALE_LABELS, type Locale } from './i18n';
import DeviceScanner from './components/DeviceScanner';
import RadioDashboard from './components/RadioDashboard';

interface ConnectedDevice {
  mac: string;
  name: string;
  type: 'charger' | 'mower' | 'unknown';
}

export default function App() {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);
  const [t, setT] = useState(() => createT(detectLocale()));
  const [selectedDevice, setSelectedDevice] = useState<ConnectedDevice | null>(null);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    setT(() => createT(l));
    localStorage.setItem('novabot-ble-locale', l);
  }, []);

  const handleDeviceSelect = useCallback((device: ConnectedDevice) => {
    setSelectedDevice(device);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedDevice(null);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, t, setLocale }}>
      <div className="min-h-screen p-4 md:p-8">
        {/* Header */}
        <div className="max-w-5xl mx-auto mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white/90">
            {t('title')}
          </h1>
          <div className="flex items-center gap-2">
            {(Object.entries(LOCALE_LABELS) as [Locale, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setLocale(key)}
                className={`px-3 py-1 rounded text-sm transition-colors ${
                  locale === key
                    ? 'bg-white/20 text-white'
                    : 'text-white/50 hover:text-white/80'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Main content */}
        <div className="max-w-5xl mx-auto">
          {selectedDevice ? (
            <RadioDashboard device={selectedDevice} onBack={handleBack} />
          ) : (
            <DeviceScanner onDeviceSelect={handleDeviceSelect} />
          )}
        </div>
      </div>
    </I18nContext.Provider>
  );
}
