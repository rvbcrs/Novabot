import { useState, useCallback } from 'react';
import { Bluetooth, X, CheckCircle2, AlertTriangle, Loader2, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { scanBleDevices, registerDeviceMac, type BleDevice } from '../../api/client';

/* ── Server-side BLE scanner ─────────────────────────────────────
   Uses native CoreBluetooth on the server (via @stoprocent/noble)
   to scan for Novabot BLE devices and extract MAC addresses from
   manufacturer data (company ID 0x5566 + 6 bytes MAC).

   This avoids Web Bluetooth limitations (no watchAdvertisements on
   macOS Chrome, MAC address hidden for privacy).
   ─────────────────────────────────────────────────────────────── */

type Phase = 'input' | 'scanning' | 'results' | 'registering' | 'done' | 'error';

interface Props {
  open: boolean;
  onClose: () => void;
}

export function BleScanner({ open, onClose }: Props) {
  const { t } = useTranslation();

  const [sn, setSn] = useState('');
  const [mac, setMac] = useState('');
  const [phase, setPhase] = useState<Phase>('input');
  const [devices, setDevices] = useState<BleDevice[]>([]);
  const [error, setError] = useState('');

  const handleClose = useCallback(() => {
    setPhase('input');
    setMac('');
    setDevices([]);
    setError('');
    setSn('');
    onClose();
  }, [onClose]);

  /* ── Server-side BLE scan ──────────────────────────────────── */
  const startScan = useCallback(async () => {
    if (!sn.trim()) return;
    setPhase('scanning');
    setError('');
    setDevices([]);
    setMac('');

    try {
      const found = await scanBleDevices(5);
      setDevices(found);

      if (found.length === 1) {
        // Single device found → auto-select
        setMac(found[0].mac);
      }
      setPhase('results');
    } catch (err) {
      setPhase('error');
      setError((err as Error).message || t('ble.scanFailed'));
    }
  }, [sn, t]);

  /* ── Register MAC via API ────────────────────────────────────── */
  const doRegister = useCallback(async () => {
    const trimSn = sn.trim().toUpperCase();
    const trimMac = mac.trim().toUpperCase();
    if (!trimSn || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(trimMac)) return;

    setPhase('registering');
    setError('');
    try {
      await registerDeviceMac(trimSn, trimMac);
      setPhase('done');
    } catch (err) {
      setPhase('error');
      setError((err as Error).message || 'Registration failed');
    }
  }, [sn, mac]);

  if (!open) return null;

  const snValid = /^LFI[A-Z]\d+$/.test(sn.trim().toUpperCase());
  const macValid = /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac.trim());

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60">
      <div className="bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-md mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <Bluetooth className="w-5 h-5 text-blue-400" />
            <h2 className="text-white font-semibold">{t('ble.addDevice')}</h2>
          </div>
          <button onClick={handleClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">

          {/* ── Done ─────────────────────────────────────────── */}
          {phase === 'done' && (
            <div className="text-center py-6 space-y-3">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto" />
              <p className="text-emerald-400 font-medium">{t('ble.registered')}</p>
              <p className="text-sm text-gray-400">
                {sn.trim().toUpperCase()} &rarr; {mac}
              </p>
              <button onClick={handleClose} className="mt-2 px-4 py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition-colors">
                {t('ble.close')}
              </button>
            </div>
          )}

          {/* ── Input ────────────────────────────────────────── */}
          {phase === 'input' && (
            <>
              <div>
                <label className="block text-sm text-gray-400 mb-1">{t('ble.serialNumber')}</label>
                <input
                  type="text"
                  value={sn}
                  onChange={e => setSn(e.target.value)}
                  placeholder={t('ble.snPlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              <button
                onClick={startScan}
                disabled={!snValid}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <Radio className="w-4 h-4" />
                {t('ble.scanBle')}
              </button>

              <button
                onClick={() => setPhase('results')}
                className="w-full text-xs text-gray-500 hover:text-gray-300 transition-colors"
              >
                {t('ble.manualEntry')}
              </button>
            </>
          )}

          {/* ── Scanning ─────────────────────────────────────── */}
          {phase === 'scanning' && (
            <div className="text-center py-6 text-blue-400">
              <Loader2 className="w-10 h-10 animate-spin mx-auto mb-3" />
              <p className="text-sm">{t('ble.scanning')}</p>
              <p className="text-xs text-gray-500 mt-1">~5s</p>
            </div>
          )}

          {/* ── Results: device list + MAC entry ─────────────── */}
          {(phase === 'results' || phase === 'registering') && (
            <div className="space-y-3">
              {/* Found devices */}
              {devices.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-gray-400">{t('ble.devicesFound', { count: devices.length })}</p>
                  {devices.map(d => (
                    <button
                      key={d.mac}
                      onClick={() => setMac(d.mac)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                        mac === d.mac
                          ? 'border-emerald-500 bg-emerald-950/30'
                          : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-white text-sm font-medium">{d.name}</span>
                        <span className="text-xs text-gray-500">{d.rssi} dBm</span>
                      </div>
                      <p className="text-emerald-400 font-mono text-xs mt-0.5">{d.mac}</p>
                    </button>
                  ))}
                </div>
              )}

              {/* No devices found message */}
              {devices.length === 0 && phase === 'results' && (
                <p className="text-xs text-gray-500 text-center py-2">{t('ble.noDevicesFound')}</p>
              )}

              {/* Rescan button */}
              {phase === 'results' && (
                <button
                  onClick={startScan}
                  disabled={!snValid}
                  className="w-full py-1.5 text-xs text-blue-400 hover:text-blue-300 transition-colors flex items-center justify-center gap-1"
                >
                  <Radio className="w-3 h-3" />
                  {t('ble.rescan')}
                </button>
              )}

              {/* MAC manual input */}
              <div>
                <label className="block text-sm text-gray-400 mb-1">{t('ble.macAddress')}</label>
                <input
                  type="text"
                  value={mac}
                  onChange={e => setMac(e.target.value)}
                  placeholder={t('ble.macPlaceholder')}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm font-mono placeholder-gray-600 focus:outline-none focus:border-blue-500"
                />
              </div>

              <button
                onClick={doRegister}
                disabled={!snValid || !macValid || phase === 'registering'}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {phase === 'registering' && <Loader2 className="w-4 h-4 animate-spin" />}
                {t('ble.register')}
              </button>
            </div>
          )}

          {/* ── Error ────────────────────────────────────────── */}
          {phase === 'error' && error && (
            <div className="space-y-3">
              <p className="text-xs text-red-400 bg-red-950/30 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3.5 h-3.5 inline mr-1" />
                {error}
              </p>
              <button
                onClick={() => setPhase('input')}
                className="w-full py-2 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition-colors text-sm"
              >
                {t('ble.tryAgain')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
