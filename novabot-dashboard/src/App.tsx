import { Header } from './components/layout/Header';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { ToastProvider } from './components/common/Toast';
import { useDevices } from './hooks/useDevices';

export default function App() {
  const { devices, loading, connected, logs, bleLogs } = useDevices();

  return (
    <ToastProvider>
      <div className="min-h-screen bg-gray-950 text-white">
        <Header connected={connected} />
        <DashboardPage devices={devices} loading={loading} logs={logs} bleLogs={bleLogs} />
      </div>
    </ToastProvider>
  );
}
