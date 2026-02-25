import { Header } from './components/layout/Header';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { useDevices } from './hooks/useDevices';

export default function App() {
  const { devices, loading, connected, logs } = useDevices();

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <Header connected={connected} />
      <DashboardPage devices={devices} loading={loading} logs={logs} />
    </div>
  );
}
