import { useState, useEffect, useCallback } from 'react';
import { HardDrive, Zap, Trash2, RefreshCw, Plus, Check, AlertCircle } from 'lucide-react';
import type { DeviceState } from '../../types';
import type { OtaProgress } from '../../hooks/useDevices';
import {
  fetchOtaVersions, fetchFirmwareFiles, addOtaVersion, deleteOtaVersion, triggerOta,
  type OtaVersion, type FirmwareFile,
} from '../../api/client';

interface Props {
  devices: Map<string, DeviceState>;
  otaProgress: Map<string, OtaProgress>;
}

type TriggerState = 'idle' | 'sending' | 'done' | 'error';

/** Auto-detect server address reachable by devices (not localhost/127.0.0.1). */
function defaultServerBase(): string {
  const { hostname, port } = window.location;
  // Devices can't reach localhost — use actual hostname/IP
  const deviceHost = (hostname === 'localhost' || hostname === '127.0.0.1')
    ? 'nova-dash.ramonvanbruggen.nl'
    : hostname;
  // Dev ports (Vite) → local API port; reverse proxy (80/443) → no port suffix
  const portSuffix = (port === '5173' || port === '5174') ? ':3000'
    : port ? `:${port}` : '';
  return `http://${deviceHost}${portSuffix}`;
}

export function OtaManager({ devices, otaProgress }: Props) {
  const [versions, setVersions] = useState<OtaVersion[]>([]);
  const [files, setFiles] = useState<FirmwareFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [serverBase, setServerBase] = useState(defaultServerBase);
  const [addForm, setAddForm] = useState({
    file: '', version: '', device_type: 'charger',
    urlMode: 'local' as 'local' | 'custom',
    customUrl: '',
  });
  const [triggerState, setTriggerState] = useState<Record<string, TriggerState>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [v, f] = await Promise.all([fetchOtaVersions(), fetchFirmwareFiles()]);
      setVersions(v);
      setFiles(f);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAddVersion = async () => {
    if (!addForm.version) return;
    const downloadUrl = addForm.urlMode === 'custom'
      ? addForm.customUrl.trim()
      : `${serverBase}/api/dashboard/firmware/${encodeURIComponent(addForm.file)}`;
    if (!downloadUrl) return;
    try {
      await addOtaVersion({ version: addForm.version, device_type: addForm.device_type, download_url: downloadUrl });
      setShowAdd(false);
      setAddForm({ file: '', version: '', device_type: 'charger', urlMode: 'local', customUrl: '' });
      await load();
    } catch { /* ignore */ }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Versie verwijderen?')) return;
    await deleteOtaVersion(id);
    await load();
  };

  const handleTrigger = async (sn: string, versionId: number) => {
    const key = `${sn}-${versionId}`;
    setTriggerState(s => ({ ...s, [key]: 'sending' }));
    try {
      await triggerOta(sn, versionId, true);
      setTriggerState(s => ({ ...s, [key]: 'done' }));
      setTimeout(() => setTriggerState(s => ({ ...s, [key]: 'idle' })), 5000);
    } catch {
      setTriggerState(s => ({ ...s, [key]: 'error' }));
    }
  };

  const sortedDevices = Array.from(devices.values()).sort((a, b) =>
    a.deviceType === 'charger' ? -1 : b.deviceType === 'charger' ? 1 : 0,
  );

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <HardDrive className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-medium">Firmware Update</span>
        </div>
        <button onClick={load} className="text-gray-500 hover:text-gray-300 p-1 rounded">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">

        {/* Current device firmware versions */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">Huidige versies</div>
          <div className="space-y-1">
            {sortedDevices.length === 0 && (
              <p className="text-xs text-gray-600 italic">Geen apparaten verbonden</p>
            )}
            {sortedDevices.map(d => {
              const version = d.sensors.sw_version ?? d.sensors.version ?? null;
              const progress = otaProgress.get(d.sn);
              const isCharger = d.deviceType === 'charger';
              return (
                <div key={d.sn} className="flex flex-col gap-0.5 bg-gray-800 rounded px-2.5 py-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-[9px] px-1 rounded font-medium ${isCharger ? 'bg-yellow-900/50 text-yellow-400' : 'bg-emerald-900/50 text-emerald-400'}`}>
                        {isCharger ? 'Charger' : 'Maaier'}
                      </span>
                      <span className="text-[10px] text-gray-400 font-mono">{d.nickname ?? d.sn}</span>
                    </div>
                    <span className="text-[10px] font-mono text-gray-300">{version ?? '—'}</span>
                  </div>
                  {/* OTA progress bar */}
                  {progress && (Date.now() - progress.timestamp < 120_000) && (() => {
                    const isDone = progress.status === 'success';
                    const isFail = progress.status === 'failed' || progress.status === 'error';
                    return (
                      <div className="mt-0.5">
                        <div className="flex items-center justify-between text-[9px] mb-0.5">
                          <span className={isDone ? 'text-emerald-400' : isFail ? 'text-red-400' : 'text-orange-300'}>
                            {progress.status === 'upgrade' ? 'Downloading…' : isDone ? 'Update voltooid' : isFail ? 'Update mislukt' : progress.status}
                          </span>
                          {progress.percentage != null && <span className={isDone ? 'text-emerald-400' : 'text-orange-300'}>{progress.percentage.toFixed(0)}%</span>}
                        </div>
                        {progress.percentage != null && (
                          <div className="w-full bg-gray-700 rounded-full h-1.5">
                            <div
                              className={`h-1.5 rounded-full transition-all duration-500 ${isDone ? 'bg-emerald-500' : isFail ? 'bg-red-500' : 'bg-orange-500'}`}
                              style={{ width: `${Math.min(100, progress.percentage)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>

        {/* Firmware files in firmware/ directory */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">
            Bestanden in <code className="text-gray-400">firmware/</code>
          </div>
          {files.length === 0 ? (
            <p className="text-xs text-gray-600 italic leading-snug">
              Kopieer <code className="text-gray-500">.bin</code> / <code className="text-gray-500">.deb</code> naar{' '}
              <code className="text-gray-500">novabot-server/firmware/</code> en herlaad.
            </p>
          ) : (
            <div className="space-y-1">
              {files.map(f => (
                <div key={f.name} className="flex items-center justify-between bg-gray-800 rounded px-2.5 py-1.5">
                  <span className="text-xs font-mono text-gray-200 truncate">{f.name}</span>
                  <span className="text-[10px] text-gray-500 font-mono ml-2 flex-shrink-0">
                    {(f.size / 1024 / 1024).toFixed(1)} MB
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Registered OTA versions */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] text-gray-500 uppercase tracking-wide">Geregistreerde versies</div>
            <button
              onClick={() => setShowAdd(v => !v)}
              className="flex items-center gap-0.5 text-[10px] text-orange-400 hover:text-orange-300"
            >
              <Plus className="w-3 h-3" />
              Registreer
            </button>
          </div>

          {/* Add version form */}
          {showAdd && (
            <div className="bg-gray-800 rounded p-2.5 mb-3 space-y-2 border border-gray-700">

              {/* URL source toggle */}
              <div className="flex rounded overflow-hidden border border-gray-700 text-[10px]">
                {(['local', 'custom'] as const).map(mode => (
                  <button
                    key={mode}
                    onClick={() => setAddForm(f => ({ ...f, urlMode: mode }))}
                    className={`flex-1 py-1 transition-colors ${addForm.urlMode === mode ? 'bg-orange-700 text-white' : 'bg-gray-900 text-gray-400 hover:text-gray-200'}`}
                  >
                    {mode === 'local' ? 'Lokaal bestand' : 'Eigen URL'}
                  </button>
                ))}
              </div>

              {addForm.urlMode === 'local' ? (
                <>
                  {/* Server address */}
                  <div>
                    <label className="text-[9px] text-gray-500 uppercase tracking-wide">
                      Server adres (bereikbaar door apparaten)
                    </label>
                    <input
                      type="text"
                      value={serverBase}
                      onChange={e => setServerBase(e.target.value.replace(/\/$/, ''))}
                      className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200 font-mono focus:outline-none focus:border-orange-500"
                      placeholder="http://192.168.x.x:3000"
                    />
                  </div>
                  <div>
                    <label className="text-[9px] text-gray-500 uppercase tracking-wide">Bestand</label>
                    {files.length === 0 ? (
                      <p className="mt-0.5 text-[10px] text-amber-500/80 leading-snug">
                        Geen bestanden in <code className="text-amber-400/80">novabot-server/firmware/</code>.
                        Kopieer er bestanden naartoe of gebruik "Eigen URL".
                      </p>
                    ) : (
                      <select
                        value={addForm.file}
                        onChange={e => setAddForm(f => ({ ...f, file: e.target.value }))}
                        className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200"
                      >
                        <option value="">-- selecteer --</option>
                        {files.map(f => (
                          <option key={f.name} value={f.name}>{f.name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  {addForm.file && (
                    <p className="text-[9px] text-gray-500 font-mono leading-tight break-all">
                      URL: {serverBase}/api/dashboard/firmware/{addForm.file}
                    </p>
                  )}
                </>
              ) : (
                <div>
                  <label className="text-[9px] text-gray-500 uppercase tracking-wide">Download URL</label>
                  <input
                    type="text"
                    value={addForm.customUrl}
                    onChange={e => setAddForm(f => ({ ...f, customUrl: e.target.value }))}
                    placeholder="http://192.168.x.x:8080/firmware.bin"
                    className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200 placeholder-gray-600 font-mono focus:outline-none focus:border-orange-500"
                  />
                  <p className="mt-0.5 text-[9px] text-gray-600 leading-tight">
                    Bijv. een bestand geserveerd via <code>python3 -m http.server 8080</code> in <code>research/firmware/</code>
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] text-gray-500 uppercase tracking-wide">Versie label</label>
                  <input
                    type="text"
                    value={addForm.version}
                    onChange={e => setAddForm(f => ({ ...f, version: e.target.value }))}
                    placeholder="bijv. v0.4.0-patched"
                    className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div>
                  <label className="text-[9px] text-gray-500 uppercase tracking-wide">Apparaat type</label>
                  <select
                    value={addForm.device_type}
                    onChange={e => setAddForm(f => ({ ...f, device_type: e.target.value }))}
                    className="mt-0.5 w-full text-xs bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-gray-200"
                  >
                    <option value="charger">Laadstation</option>
                    <option value="mower">Maaier</option>
                  </select>
                </div>
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  onClick={() => setShowAdd(false)}
                  className="flex-1 text-xs py-1 rounded bg-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
                >
                  Annuleren
                </button>
                <button
                  onClick={handleAddVersion}
                  disabled={
                    !addForm.version ||
                    (addForm.urlMode === 'local' && !addForm.file) ||
                    (addForm.urlMode === 'custom' && !addForm.customUrl.trim())
                  }
                  className="flex-1 text-xs py-1 rounded bg-orange-700 text-white hover:bg-orange-600 disabled:opacity-40 transition-colors"
                >
                  Registreren
                </button>
              </div>
            </div>
          )}

          {versions.length === 0 && !showAdd && (
            <p className="text-xs text-gray-600 italic">Geen versies geregistreerd</p>
          )}

          <div className="space-y-2">
            {versions.map(v => {
              const relevantDevices = sortedDevices.filter(d =>
                v.device_type === 'charger' ? d.deviceType === 'charger' : d.deviceType === 'mower',
              );
              return (
                <div key={v.id} className="bg-gray-800 rounded p-2.5 border border-gray-700/50">
                  <div className="flex items-start justify-between mb-1.5">
                    <div>
                      <span className="text-xs font-medium text-orange-300">{v.version}</span>
                      <span className={`ml-1.5 text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        v.device_type === 'charger'
                          ? 'bg-yellow-900/50 text-yellow-400'
                          : 'bg-emerald-900/50 text-emerald-400'
                      }`}>
                        {v.device_type === 'charger' ? 'Laadstation' : 'Maaier'}
                      </span>
                    </div>
                    <button
                      onClick={() => handleDelete(v.id)}
                      className="text-gray-600 hover:text-red-400 p-0.5 transition-colors"
                      title="Verwijder versie"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {v.md5 && (
                    <div className="text-[9px] text-gray-600 font-mono mb-1.5">MD5: {v.md5.slice(0, 16)}…</div>
                  )}

                  {/* Trigger buttons per device */}
                  {relevantDevices.length === 0 ? (
                    <p className="text-[10px] text-gray-600">
                      Geen {v.device_type === 'charger' ? 'laadstation' : 'maaier'} verbonden
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {relevantDevices.map(d => {
                        const key = `${d.sn}-${v.id}`;
                        const state = triggerState[key] ?? 'idle';
                        const deviceVersion = d.sensors.sw_version ?? d.sensors.version;
                        const isCurrent = deviceVersion === v.version;
                        return (
                          <button
                            key={d.sn}
                            onClick={() => handleTrigger(d.sn, v.id)}
                            disabled={state === 'sending'}
                            className={`w-full flex items-center justify-center gap-1.5 text-xs py-1.5 rounded transition-colors ${
                              state === 'done'
                                ? 'bg-green-900/60 text-green-300'
                                : state === 'error'
                                ? 'bg-red-900/60 text-red-400'
                                : d.online
                                ? 'bg-orange-700/80 text-white hover:bg-orange-600 disabled:opacity-40'
                                : 'bg-gray-700/50 text-gray-500 cursor-not-allowed'
                            }`}
                            title={!d.online ? 'Apparaat offline' : isCurrent ? 'Al actieve versie' : undefined}
                          >
                            {state === 'done' ? (
                              <><Check className="w-3 h-3" />Commando verstuurd</>
                            ) : state === 'error' ? (
                              <><AlertCircle className="w-3 h-3" />Fout bij versturen</>
                            ) : (
                              <><Zap className="w-3 h-3" />
                              {state === 'sending' ? 'Bezig…' : `Flash → ${d.nickname ?? d.sn}`}
                              {isCurrent && <span className="ml-1 opacity-60">(huidig)</span>}
                              </>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* How the official app gets the update */}
        <div className="text-[10px] text-gray-600 leading-relaxed border-t border-gray-800 pt-3 space-y-1.5">
          <p className="text-gray-500 font-medium">Officiële app flow</p>
          <p>Als een versie geregistreerd is en de app belt <code className="text-gray-400">checkOtaNewVersion</code>, krijgt die automatisch de update aangeboden — ook in de officiële Novabot app.</p>
          <p className="text-orange-400/70">
            Let op: de charger gebruikt <code>esp_https_ota</code> — als HTTP niet werkt, is HTTPS nodig.
          </p>
        </div>
      </div>
    </div>
  );
}
