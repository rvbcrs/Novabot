import { useState, useEffect } from 'react';
import { DashboardShell } from './shell/DashboardShell';
import { OnboardingWizard } from './components/setup/OnboardingWizard';
import { LoginScreen } from './components/auth/LoginScreen';
import { ToastProvider } from './components/common/Toast';
import { DialogProvider } from './components/common/Dialog';
import { useDevices } from './hooks/useDevices';
import { checkSetupStatus, checkCertTrusted, UnauthorizedError } from './api/client';
import { MobilePage } from './mobile/MobilePage';

type AppState = 'loading' | 'onboarding' | 'onboarding-cert-only' | 'login' | 'ready';

/**
 * Mobile view wrapper. useDevices() opens the dashboard socket, so it must only
 * mount once we're authenticated/ready — never on the loading/login screens.
 */
function MobileApp() {
  const { devices, loading, connected, liveOutlines, coveredLanes } = useDevices();
  return (
    <MobilePage
      devices={devices}
      loading={loading}
      connected={connected}
      liveOutlines={liveOutlines}
      coveredLanes={coveredLanes}
    />
  );
}

export default function App() {
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
      } catch (e) {
        // External client without a valid token — the server gates the API by
        // origin (see externalAuthGate). Show the login screen. Any other error
        // (server unreachable) falls back to showing the dashboard, matching the
        // previous behaviour for local users.
        if (e instanceof UnauthorizedError) setAppState('login');
        else setAppState('ready');
      }
    }
    init();
  }, []);

  // A 401 anywhere (expired token mid-session) bounces back to the login screen.
  useEffect(() => {
    const onUnauthorized = () => setAppState('login');
    window.addEventListener('novabot:unauthorized', onUnauthorized);
    return () => window.removeEventListener('novabot:unauthorized', onUnauthorized);
  }, []);

  if (appState === 'loading') {
    return <div className="min-h-screen bg-gray-950" />;
  }

  if (appState === 'login') {
    return (
      <ToastProvider><DialogProvider>
        <LoginScreen onSuccess={() => setAppState('ready')} />
      </DialogProvider></ToastProvider>
    );
  }

  if (appState === 'onboarding') {
    return (
      <ToastProvider><DialogProvider>
        <OnboardingWizard onComplete={() => setAppState('ready')} />
      </DialogProvider></ToastProvider>
    );
  }

  if (appState === 'onboarding-cert-only') {
    return (
      <ToastProvider><DialogProvider>
        <OnboardingWizard skipAccount onComplete={() => setAppState('ready')} />
      </DialogProvider></ToastProvider>
    );
  }

  const isMobile = window.location.pathname.startsWith('/mobile');

  return (
    <ToastProvider><DialogProvider>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div className="dark min-h-screen bg-gray-950 text-white overflow-x-hidden">
          <DashboardShell />
        </div>
      )}
    </DialogProvider></ToastProvider>
  );
}
