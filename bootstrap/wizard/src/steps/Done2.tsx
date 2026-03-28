import { useState, useEffect } from 'react';
import confetti from 'canvas-confetti';
import type { DeviceMode, FirmwareInfo } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  chargerConnected: boolean;
  mowerConnected: boolean;
  chargerFirmware: FirmwareInfo | null;
  mowerFirmware: FirmwareInfo | null;
  mqttAddr: string;
  onAddAnother: () => void;
}

type AppTab = 'ios' | 'android' | 'router';

export default function Done2({ deviceMode, chargerConnected, mowerConnected, chargerFirmware, mowerFirmware, mqttAddr, onAddAnother }: Props) {
  const expectsCharger = deviceMode === 'charger' || deviceMode === 'both';
  const expectsMower = deviceMode === 'mower' || deviceMode === 'both';
  const [appTab, setAppTab] = useState<AppTab>('ios');
  const [showAppSetup, setShowAppSetup] = useState(false);

  const serverIp = mqttAddr || '192.168.0.177';

  // Confetti on mount
  useEffect(() => {
    const duration = 3000;
    const end = Date.now() + duration;

    const frame = () => {
      confetti({
        particleCount: 3,
        angle: 60,
        spread: 55,
        origin: { x: 0, y: 0.7 },
        colors: ['#00d4aa', '#7c3aed', '#22c55e', '#3b82f6'],
      });
      confetti({
        particleCount: 3,
        angle: 120,
        spread: 55,
        origin: { x: 1, y: 0.7 },
        colors: ['#00d4aa', '#7c3aed', '#22c55e', '#3b82f6'],
      });
      if (Date.now() < end) requestAnimationFrame(frame);
    };

    // Initial burst
    confetti({
      particleCount: 100,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#00d4aa', '#7c3aed', '#22c55e', '#3b82f6', '#f59e0b'],
    });

    // Continuous side cannons
    frame();
  }, []);

  return (
    <div className="glass-card p-8">
      {/* Success header */}
      <div className="flex flex-col items-center gap-4 mb-8">
        <div className="w-20 h-20 rounded-full bg-emerald-900/40 border-2 border-emerald-500 flex items-center justify-center overflow-hidden">
          <img src="/OpenNova.png" alt="OpenNova" className="w-16 h-16 object-contain" />
        </div>
        <h2 className="text-2xl font-bold text-white">Setup Complete</h2>
        <p className="text-gray-400 text-sm text-center">
          Your device(s) have been provisioned to connect to <span className="text-emerald-400 font-mono">{serverIp}</span>
        </p>
      </div>

      {/* Summary */}
      <div className="space-y-3 mb-8">
        <h3 className="text-gray-400 text-xs font-medium uppercase tracking-wide">Device Status</h3>
        {expectsCharger && (
          <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700/50">
            <div className="flex items-center gap-3">
              <span className="text-xl">{'\u26A1'}</span>
              <div>
                <p className="text-white text-sm font-medium">Charger</p>
                <p className="text-gray-500 text-xs">
                  {chargerConnected ? 'Connected via MQTT' : 'Provisioned'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {chargerFirmware && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">v{chargerFirmware.version}</span>
              )}
              <div className={`w-3 h-3 rounded-full ${chargerConnected ? 'bg-emerald-500' : 'bg-gray-600'}`} />
            </div>
          </div>
        )}
        {expectsMower && (
          <div className="flex items-center justify-between p-4 bg-gray-800/40 rounded-xl border border-gray-700/50">
            <div className="flex items-center gap-3">
              <span className="text-xl">{'\uD83E\uDD16'}</span>
              <div>
                <p className="text-white text-sm font-medium">Mower</p>
                <p className="text-gray-500 text-xs">
                  {mowerConnected ? 'Connected via MQTT' : 'Provisioned'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {mowerFirmware && (
                <span className="text-xs px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400">v{mowerFirmware.version}</span>
              )}
              <div className={`w-3 h-3 rounded-full ${mowerConnected ? 'bg-emerald-500' : 'bg-gray-600'}`} />
            </div>
          </div>
        )}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════ */}
      {/* Novabot App Configuration — the critical last step                   */}
      {/* ══════════════════════════════════════════════════════════════════════ */}

      <div className="mb-8">
        <button
          onClick={() => setShowAppSetup(!showAppSetup)}
          className="w-full flex items-center justify-between p-4 bg-amber-900/20 border border-amber-700/40 rounded-xl hover:bg-amber-900/30 transition-colors"
        >
          <div className="flex items-center gap-3">
            <span className="text-xl">{'\uD83D\uDCF1'}</span>
            <div className="text-left">
              <p className="text-amber-300 text-sm font-semibold">Configure the Novabot App</p>
              <p className="text-amber-400/60 text-xs">Required to control your mower from your phone</p>
            </div>
          </div>
          <span className={`text-amber-400 transition-transform ${showAppSetup ? 'rotate-180' : ''}`}>{'\u25BC'}</span>
        </button>

        {showAppSetup && (
          <div className="mt-3 p-5 bg-gray-800/40 rounded-xl border border-gray-700/50">
            <div className="mb-4">
              <p className="text-gray-300 text-sm mb-3">
                The Novabot app connects to <span className="text-amber-300 font-mono">app.lfibot.com</span> and{' '}
                <span className="text-amber-300 font-mono">mqtt.lfibot.com</span> (the official cloud).
                To use the app with your own server, these domains must resolve to{' '}
                <span className="text-emerald-400 font-mono">{serverIp}</span>.
              </p>
              <p className="text-gray-500 text-xs">
                Choose the method that works best for your setup:
              </p>
            </div>

            {/* Tab selector */}
            <div className="flex gap-1 mb-4 p-1 bg-gray-900/60 rounded-lg">
              {[
                { id: 'ios' as AppTab, label: 'iOS (iPhone/iPad)' },
                { id: 'android' as AppTab, label: 'Android' },
                { id: 'router' as AppTab, label: 'Router / DNS' },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setAppTab(tab.id)}
                  className={`flex-1 py-2 px-3 text-xs font-medium rounded-md transition-colors ${
                    appTab === tab.id
                      ? 'bg-emerald-700 text-white'
                      : 'text-gray-400 hover:text-gray-300'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* iOS instructions */}
            {appTab === 'ios' && (
              <div className="space-y-4">
                <div className="p-4 bg-blue-900/20 border border-blue-700/30 rounded-xl">
                  <p className="text-blue-300 text-sm font-medium mb-1">Recommended: DNS Profile</p>
                  <p className="text-blue-400/70 text-xs">Install a configuration profile that redirects Novabot domains to your server. No jailbreak needed.</p>
                </div>

                <div className="space-y-3">
                  <Step n={1} title="Download the DNS profile">
                    <p>Click the button below to download a <span className="text-white">.mobileconfig</span> file customized for your server.</p>
                    <a
                      href={`/api/generate-mobileconfig?ip=${serverIp}`}
                      download="OpenNova-DNS.mobileconfig"
                      className="inline-block mt-2 px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm font-medium rounded-lg transition-colors"
                    >
                      Download DNS Profile
                    </a>
                  </Step>

                  <Step n={2} title="Transfer to your iPhone">
                    <p>AirDrop the file to your iPhone, or email it to yourself and open it on your phone.</p>
                  </Step>

                  <Step n={3} title="Install the profile">
                    <p>On your iPhone: go to <span className="text-white">Settings → General → VPN & Device Management</span>. You'll see the "OpenNova DNS" profile. Tap it and choose <span className="text-white">Install</span>.</p>
                  </Step>

                  <Step n={4} title="Verify it works">
                    <p>Open the Novabot app. It should now connect to your local server instead of the cloud. If you see your mower, it's working!</p>
                  </Step>

                  <Step n={5} title="To remove later">
                    <p>Go to <span className="text-white">Settings → General → VPN & Device Management → OpenNova DNS</span> and tap <span className="text-white">Remove Profile</span> to revert to the official cloud.</p>
                  </Step>
                </div>

                <div className="p-3 bg-gray-800/40 rounded-lg">
                  <p className="text-gray-500 text-xs">
                    <span className="text-amber-400">Note:</span> The profile only affects <code className="text-gray-400">*.lfibot.com</code> domains.
                    All other internet traffic is unaffected. The profile works on your home WiFi network only —
                    when you're on mobile data, the app will try to reach the cloud (which is fine).
                  </p>
                </div>
              </div>
            )}

            {/* Android instructions */}
            {appTab === 'android' && (
              <div className="space-y-4">
                <div className="p-4 bg-green-900/20 border border-green-700/30 rounded-xl">
                  <p className="text-green-300 text-sm font-medium mb-1">Option A: Change WiFi DNS (easiest)</p>
                  <p className="text-green-400/70 text-xs">Point your phone's DNS to a local server that redirects Novabot domains.</p>
                </div>

                <div className="space-y-3">
                  <Step n={1} title="Open WiFi settings">
                    <p>Go to <span className="text-white">Settings → Network & internet → WiFi</span>. Long-press your home WiFi network and choose <span className="text-white">Modify network</span>.</p>
                  </Step>

                  <Step n={2} title="Set custom DNS">
                    <p>Enable <span className="text-white">Advanced options</span>. Change <span className="text-white">IP settings</span> to <span className="text-white">Static</span>. Set DNS 1 to your OpenNova server or a DNS server that redirects <code className="text-gray-400">*.lfibot.com</code>:</p>
                    <code className="block mt-1 p-2 bg-gray-900/60 rounded text-emerald-400 text-sm font-mono">{serverIp}</code>
                    <p className="mt-1 text-amber-400/70 text-xs">This requires a DNS server (like AdGuard Home or Pi-hole) running on {serverIp} with DNS rewrites for *.lfibot.com → {serverIp}.</p>
                  </Step>

                  <Step n={3} title="Alternative: local hosts file (rooted only)">
                    <p>If your phone is rooted, edit <code className="text-gray-400">/etc/hosts</code>:</p>
                    <code className="block mt-1 p-2 bg-gray-900/60 rounded text-emerald-400 text-sm font-mono whitespace-pre">{`${serverIp}  app.lfibot.com\n${serverIp}  mqtt.lfibot.com`}</code>
                  </Step>
                </div>

                <div className="p-4 bg-green-900/20 border border-green-700/30 rounded-xl">
                  <p className="text-green-300 text-sm font-medium mb-1">Option B: Use the Router method instead</p>
                  <p className="text-green-400/70 text-xs">This works for all devices on your network, including Android. See the "Router / DNS" tab.</p>
                </div>
              </div>
            )}

            {/* Router / DNS instructions */}
            {appTab === 'router' && (
              <div className="space-y-4">
                <div className="p-4 bg-purple-900/20 border border-purple-700/30 rounded-xl">
                  <p className="text-purple-300 text-sm font-medium mb-1">Best method: works for ALL devices</p>
                  <p className="text-purple-400/70 text-xs">Configure DNS on your router so every device on your network can use the Novabot app with your server.</p>
                </div>

                <div className="space-y-3">
                  <Step n={1} title="Option A: AdGuard Home / Pi-hole (recommended)">
                    <p>If you run AdGuard Home or Pi-hole as your network DNS:</p>
                    <div className="mt-2 p-3 bg-gray-900/60 rounded-lg space-y-1">
                      <p className="text-gray-300 text-xs font-medium">AdGuard Home → Filters → DNS Rewrites:</p>
                      <code className="block text-emerald-400 text-sm font-mono">app.lfibot.com → {serverIp}</code>
                      <code className="block text-emerald-400 text-sm font-mono">mqtt.lfibot.com → {serverIp}</code>
                    </div>
                    <div className="mt-2 p-3 bg-gray-900/60 rounded-lg space-y-1">
                      <p className="text-gray-300 text-xs font-medium">Pi-hole → Local DNS → DNS Records:</p>
                      <code className="block text-emerald-400 text-sm font-mono">app.lfibot.com → {serverIp}</code>
                      <code className="block text-emerald-400 text-sm font-mono">mqtt.lfibot.com → {serverIp}</code>
                    </div>
                  </Step>

                  <Step n={2} title="Option B: Router custom DNS (dnsmasq)">
                    <p>Many routers (OpenWrt, Unifi, Mikrotik) support custom DNS entries. Add:</p>
                    <code className="block mt-1 p-2 bg-gray-900/60 rounded text-emerald-400 text-sm font-mono whitespace-pre">{`address=/app.lfibot.com/${serverIp}\naddress=/mqtt.lfibot.com/${serverIp}`}</code>
                  </Step>

                  <Step n={3} title="Option C: NGINX Proxy Manager">
                    <p>If you use NGINX Proxy Manager, create proxy hosts for <code className="text-gray-400">app.lfibot.com</code> → <code className="text-gray-400">http://{serverIp}:3000</code>. This also enables HTTPS/TLS for iOS (which requires TLS for the API).</p>
                  </Step>
                </div>

                <div className="p-3 bg-gray-800/40 rounded-lg">
                  <p className="text-gray-500 text-xs">
                    <span className="text-amber-400">iOS note:</span> The Novabot iOS app requires HTTPS for <code className="text-gray-400">app.lfibot.com</code>.
                    If you use the Router/DNS method, you also need a TLS reverse proxy (NGINX Proxy Manager with Let's Encrypt)
                    or the iOS mobileconfig profile method which bypasses this requirement.
                  </p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex gap-4">
        <button
          onClick={onAddAnother}
          className="flex-1 py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
        >
          Add Another Device
        </button>
      </div>
    </div>
  );
}

/* ── Helper: numbered step ─────────────────────────────────────────────────── */
function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-6 h-6 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0 mt-0.5">
        <span className="text-gray-300 text-xs font-bold">{n}</span>
      </div>
      <div>
        <p className="text-white text-sm font-medium mb-1">{title}</p>
        <div className="text-gray-400 text-sm space-y-1">{children}</div>
      </div>
    </div>
  );
}
