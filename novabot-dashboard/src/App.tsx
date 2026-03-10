import { useState, useEffect } from 'react';
import { Header } from './components/layout/Header';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { OnboardingWizard } from './components/setup/OnboardingWizard';
import { ToastProvider } from './components/common/Toast';
import { useDevices } from './hooks/useDevices';
import { checkSetupStatus, checkCertTrusted } from './api/client';

type AppState = 'loading' | 'onboarding' | 'onboarding-cert-only' | 'ready';

export default function App() {
  const { devices, loading, connected, logs, bleLogs, otaProgress, liveOutlines } = useDevices();
  const [appState, setAppState] = useState<AppState>('loading');

  useEffect(() => {
    async function init() {
      try {
        const [{ hasUsers }, certOk] = await Promise.all([
          checkSetupStatus(),
          checkCertTrusted(),
        ]);

        if (!hasUsers) {
          setAppState('onboarding');          // Volledige wizard (welkom + account + cert)
        } else if (!certOk) {
          setAppState('onboarding-cert-only'); // Alleen de cert-stap
        } else {
          setAppState('ready');
        }
      } catch {
        // Server niet bereikbaar — toch tonen
        setAppState('ready');
      }
    }
    init();
  }, []);

  if (appState === 'loading') {
    return <div className="min-h-screen bg-gray-950" />;
  }

  if (appState === 'onboarding') {
    return (
      <ToastProvider>
        <OnboardingWizard onComplete={() => setAppState('ready')} />
      </ToastProvider>
    );
  }

  if (appState === 'onboarding-cert-only') {
    return (
      <ToastProvider>
        <OnboardingWizard skipAccount onComplete={() => setAppState('ready')} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="min-h-screen bg-gray-950 text-white overflow-x-hidden">
        <Header connected={connected} />
        <DashboardPage devices={devices} loading={loading} logs={logs} bleLogs={bleLogs} otaProgress={otaProgress} liveOutlines={liveOutlines} />
      </div>
    </ToastProvider>
  );
}
