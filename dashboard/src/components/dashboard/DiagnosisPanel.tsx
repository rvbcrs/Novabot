/**
 * DiagnosisPanel — where is this device stuck in coming online.
 *
 * Novabot is bankrupt and there is no support, so someone whose mower or
 * charger will not connect has nowhere to ask. The server already holds the
 * evidence; this shows the chain, stops at the first broken link, and gives one
 * next action instead of a wall of logs.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, XCircle, AlertTriangle, MinusCircle, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchDiagnosis, type Diagnosis, type DiagnosisStep } from '../../api/client';

const STEP_LABEL: Record<string, [string, string]> = {
  dns: ['diagnose.dns', 'Naam wijst hierheen'],
  network: ['diagnose.network', 'Netwerk'],
  wifi: ['diagnose.wifi', 'Wifi'],
  seen: ['diagnose.seen', 'Ooit verbonden'],
  attempts: ['diagnose.attempts', 'Verbindingspogingen'],
  binding: ['diagnose.binding', 'Koppeling'],
  ble_mac: ['diagnose.bleMac', 'BLE MAC'],
  counterpart: ['diagnose.counterpart', 'Tegenhanger'],
  lora: ['diagnose.lora', 'LoRa-paar'],
  client_conflict: ['diagnose.clientConflict', 'Dubbel client_id'],
  encryption: ['diagnose.encryption', 'Leesbare berichten'],
  firmware: ['diagnose.firmware', 'Firmware'],
  zone_limit: ['diagnose.zoneLimit', 'Aantal zones'],
  maps: ['diagnose.maps', 'Werkgebieden'],
  rtk: ['diagnose.rtk', 'RTK-positie'],
  fault: ['diagnose.fault', 'Storing'],
  frame: ['diagnose.frame', 'Kaartframe'],
  disk: ['diagnose.disk', 'Schijfruimte'],
  mdns_reach: ['diagnose.mdnsReach', 'Vindbaar over mDNS'],
  rival_broker: ['diagnose.rivalBroker', 'Tweede MQTT-broker'],
  charger_crypto: ['diagnose.chargerCrypto', 'Laderfirmware'],
  mapping_mode: ['diagnose.mappingMode', 'Karteermodus'],
  parked_task: ['diagnose.parkedTask', 'Geparkeerde taak'],
  mower_login: ['diagnose.mowerLogin', 'Toegang tot de maaier'],
  mqtt_node: ['diagnose.mqttNode', 'mqtt_node'],
  mower_config: ['diagnose.mowerConfig', 'Serveradres op de maaier'],
  server_ip_file: ['diagnose.serverIpFile', 'Bewaard serveradres'],
  helpers: ['diagnose.helpers', 'OpenNova-scripts'],
};

const GROUP_LABEL: Record<string, [string, string]> = {
  server: ['diagnose.groupServer', 'Server'],
  reach: ['diagnose.groupReach', 'Bereikbaarheid'],
  connect: ['diagnose.groupConnect', 'Verbinding'],
  identity: ['diagnose.groupIdentity', 'Identiteit'],
  pair: ['diagnose.groupPair', 'Lader en LoRa'],
  firmware: ['diagnose.groupFirmware', 'Firmware'],
  ready: ['diagnose.groupReady', 'Klaar om te maaien'],
  mower: ['diagnose.groupMower', 'Op de maaier zelf'],
};

const GROUP_ORDER = ['server', 'reach', 'connect', 'identity', 'pair', 'firmware', 'mower', 'ready'];

function Icon({ status }: { status: DiagnosisStep['status'] }) {
  if (status === 'ok') return <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />;
  if (status === 'fail') return <XCircle className="w-4 h-4 text-red-400 shrink-0" />;
  if (status === 'warn') return <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />;
  return <MinusCircle className="w-4 h-4 text-zinc-600 shrink-0" />;
}

export function DiagnosisPanel({ sn, onClose }: { sn: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [data, setData] = useState<Diagnosis | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    setError('');
    fetchDiagnosis(sn)
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, [sn]);

  return createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-900 border border-gray-700/50 rounded-2xl shadow-2xl
                      max-w-lg w-full p-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-white font-medium">
            {t('diagnose.title', 'Waarom komt hij niet online?')}
          </h2>
          <button onClick={load} disabled={loading}
                  title={t('diagnose.refresh', 'Opnieuw nakijken')}
                  className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 disabled:opacity-40">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {loading && !data && (
          <div className="flex items-center gap-2 text-sm text-zinc-400 py-6 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" /> {t('diagnose.checking', 'Nakijken…')}
          </div>
        )}
        {error && <div className="text-sm text-red-400 py-4">{error}</div>}

        {data && (
          <>
            <div className={`text-sm rounded-lg px-3 py-2 mb-3 ${
              data.stuckAt ? 'bg-red-500/10 text-red-300' : 'bg-emerald-500/10 text-emerald-300'}`}>
              {data.summary}
            </div>
            {GROUP_ORDER.filter(g => data.steps.some(s => s.group === g)).map(g => (
              <div key={g} className="mb-3 last:mb-0">
                <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1.5">
                  {t(GROUP_LABEL[g][0], GROUP_LABEL[g][1])}
                </div>
                <ol className="space-y-2">
                  {data.steps.filter(s => s.group === g).map(s => (
                    <li key={s.id} className="flex gap-2.5">
                      <Icon status={s.status} />
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-zinc-200">
                          {t(STEP_LABEL[s.id]?.[0] ?? s.id, STEP_LABEL[s.id]?.[1] ?? s.id)}
                        </div>
                        <div className="text-[11px] text-zinc-400 break-words">{s.evidence}</div>
                        {s.action && (
                          <div className="text-[11px] text-amber-300/90 mt-0.5 break-words">
                            → {s.action}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </>
        )}

        <button onClick={onClose}
                className="w-full mt-4 py-2 bg-white/10 hover:bg-white/15 text-gray-300 text-sm rounded-xl">
          {t('common.close', 'Sluiten')}
        </button>
      </div>
    </div>,
    document.body,
  );
}
