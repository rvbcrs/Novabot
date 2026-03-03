import { useState, useEffect } from 'react';
import { Settings, CheckCircle, XCircle, RefreshCw, Wifi, Server, Globe, Copy, Check, ShieldCheck, Download } from 'lucide-react';
import { fetchSetupInfo, testDns, type SetupInfo } from '../../api/client';

type DnsTest = 'idle' | 'testing' | 'ok' | 'fail';

export function SetupWizard() {
  const [info, setInfo] = useState<SetupInfo | null>(null);
  const [dnsTest, setDnsTest] = useState<DnsTest>('idle');
  const [dnsError, setDnsError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetchSetupInfo().then(setInfo).catch(() => {});
  }, []);

  const handleTestDns = async () => {
    if (!info) return;
    setDnsTest('testing');
    setDnsError(null);
    const result = await testDns(info.port);
    if (result.ok) {
      setDnsTest('ok');
    } else {
      setDnsTest('fail');
      setDnsError(result.error ?? 'DNS test failed');
    }
  };

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  const ip = info?.targetIp ?? '...';
  const rewriteRule = `*.lfibot.com → ${ip}`;

  return (
    <div className="flex flex-col h-full bg-gray-900 text-gray-200">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Settings className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-medium">Setup</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">

        {/* Server info */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">Server</div>
          <div className="space-y-1">
            <InfoRow icon={Server} label="IP" value={ip} onCopy={() => copyText(ip, 'ip')} copied={copied === 'ip'} />
            <InfoRow icon={Wifi} label="HTTP" value={`poort ${info?.port ?? 3000}`} />
            <InfoRow icon={Wifi} label="MQTT" value="poort 1883" />
            <InfoRow icon={Globe} label="DNS" value={info?.dnsEnabled ? 'Ingebouwd (dnsmasq)' : 'Uitgeschakeld — eigen DNS'} />
          </div>
        </div>

        {/* DNS Test */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">DNS Test</div>
          <p className="text-[11px] text-gray-400 mb-2">
            Test of <code className="text-blue-300">app.lfibot.com</code> correct naar je server verwijst.
          </p>
          <button
            onClick={handleTestDns}
            disabled={dnsTest === 'testing' || !info}
            className={`w-full flex items-center justify-center gap-2 text-xs py-2 rounded transition-colors ${
              dnsTest === 'ok' ? 'bg-emerald-900/60 text-emerald-300' :
              dnsTest === 'fail' ? 'bg-red-900/60 text-red-300' :
              'bg-blue-700/80 text-white hover:bg-blue-600 disabled:opacity-40'
            }`}
          >
            {dnsTest === 'testing' ? (
              <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Testen...</>
            ) : dnsTest === 'ok' ? (
              <><CheckCircle className="w-3.5 h-3.5" />DNS werkt!</>
            ) : dnsTest === 'fail' ? (
              <><XCircle className="w-3.5 h-3.5" />DNS niet bereikbaar</>
            ) : (
              <><Globe className="w-3.5 h-3.5" />Test DNS</>
            )}
          </button>
          {dnsTest === 'fail' && dnsError && (
            <p className="text-[10px] text-red-400 mt-1">{dnsError}</p>
          )}
          {dnsTest === 'ok' && (
            <p className="text-[10px] text-emerald-400 mt-1">
              app.lfibot.com verwijst naar {ip}
            </p>
          )}
        </div>

        {/* TLS Certificaat */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">TLS Certificaat (Novabot App)</div>
          <p className="text-[11px] text-gray-400 mb-2">
            De Novabot app gebruikt HTTPS. Installeer het lokale CA-certificaat eenmalig op je apparaat zodat de app kan verbinden.
          </p>
          <a
            href="/api/dashboard/setup/ca-cert"
            download="novabot-ca.crt"
            className="w-full flex items-center justify-center gap-2 text-xs py-2 rounded bg-blue-700/80 text-white hover:bg-blue-600 transition-colors mb-3"
          >
            <Download className="w-3.5 h-3.5" />
            Download novabot-ca.crt
          </a>

          <DnsGuide
            title="Mac (inclusief iOS Simulator)"
            steps={[
              'Download novabot-ca.crt via de knop hierboven',
              'Dubbelklik op het bestand → Keychain Access opent',
              'Kies "System" keychain → voeg toe',
              'Zoek "Novabot Local CA" → dubbelklik → Trust → "Always Trust"',
              'iOS Simulator erft automatisch het vertrouwen van macOS',
            ]}
          />
          <DnsGuide
            title="iPhone / iPad"
            steps={[
              'Stuur het .crt bestand naar je iPhone (AirDrop of mail)',
              'Open het bestand → "Profiel gedownload" verschijnt',
              'Ga naar Instellingen → Profiel gedownload → Installeer',
              'Ga naar Instellingen → Algemeen → Info → Vertrouwde certificaten',
              'Zet "Novabot Local CA" aan',
            ]}
          />
          <DnsGuide
            title="Android"
            steps={[
              'Download novabot-ca.crt op je Android toestel',
              'Ga naar Instellingen → Beveiliging → Certificaten installeren',
              'Kies "CA-certificaat" en selecteer het bestand',
            ]}
          />
          <div className="flex items-start gap-2 mt-2 bg-amber-950/30 border border-amber-800/30 rounded px-2.5 py-2">
            <ShieldCheck className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-amber-300/80">
              Dit certificaat is alleen geldig voor <code className="text-amber-200">*.lfibot.com</code> op je lokale netwerk. Het wordt nergens voor gebruikt buiten de Novabot server.
            </p>
          </div>
        </div>

        {/* DNS Instructions */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">DNS Instellen</div>
          <p className="text-[11px] text-gray-400 mb-3">
            De Novabot app en apparaten moeten <code className="text-blue-300">*.lfibot.com</code> kunnen
            bereiken op je lokale server. Kies hieronder je DNS oplossing.
          </p>

          {/* AdGuard */}
          <DnsGuide
            title="AdGuard Home"
            steps={[
              'Open AdGuard Home (meestal op poort 3000 van je DNS server)',
              'Ga naar Filters → DNS Rewrites',
              `Voeg toe: domein = *.lfibot.com, antwoord = ${ip}`,
              'Klik "Opslaan"',
            ]}
            copyValue={rewriteRule}
            onCopy={() => copyText(`*.lfibot.com\t${ip}`, 'adguard')}
            copied={copied === 'adguard'}
          />

          {/* Pi-hole */}
          <DnsGuide
            title="Pi-hole"
            steps={[
              'SSH naar je Pi-hole server',
              `Voeg toe aan /etc/dnsmasq.d/99-novabot.conf:`,
              `address=/lfibot.com/${ip}`,
              'Herstart: pihole restartdns',
            ]}
            copyValue={`address=/lfibot.com/${ip}`}
            onCopy={() => copyText(`address=/lfibot.com/${ip}`, 'pihole')}
            copied={copied === 'pihole'}
          />

          {/* Router */}
          <DnsGuide
            title="Router DNS"
            steps={[
              'Open je router admin pagina (meestal 192.168.0.1 of 192.168.1.1)',
              'Ga naar DHCP / LAN instellingen',
              `Stel de DNS server in op: ${ip}`,
              'Sla op en herstart je router',
              'De ingebouwde dnsmasq in de container handelt de rewrite af',
            ]}
            note="Hiervoor moet DISABLE_DNS=false staan in je .env"
          />

          {/* Manual phone */}
          <DnsGuide
            title="Handmatig per apparaat"
            steps={[
              `iOS: Instellingen → WiFi → [netwerk] → DNS → Handmatig → ${ip}`,
              `Android: WiFi → [netwerk] → Geavanceerd → DNS → ${ip}`,
            ]}
            note="Hiervoor moet DISABLE_DNS=false staan in je .env"
          />
        </div>

      </div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, onCopy, copied }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  onCopy?: () => void;
  copied?: boolean;
}) {
  return (
    <div className="flex items-center justify-between bg-gray-800 rounded px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3 text-gray-500" />
        <span className="text-[10px] text-gray-400">{label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-mono text-gray-200">{value}</span>
        {onCopy && (
          <button onClick={onCopy} className="text-gray-600 hover:text-gray-300 p-0.5" title="Kopieer">
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
        )}
      </div>
    </div>
  );
}

function DnsGuide({ title, steps, copyValue, onCopy, copied, note }: {
  title: string;
  steps: string[];
  copyValue?: string;
  onCopy?: () => void;
  copied?: boolean;
  note?: string;
}) {
  return (
    <details className="group mb-2">
      <summary className="cursor-pointer text-xs font-medium text-gray-300 hover:text-white py-1.5 px-2 rounded hover:bg-gray-800 transition-colors">
        {title}
      </summary>
      <div className="mt-1 ml-2 pl-2 border-l border-gray-700 space-y-1">
        <ol className="list-decimal list-inside space-y-0.5">
          {steps.map((step, i) => (
            <li key={i} className="text-[11px] text-gray-400 leading-relaxed">
              {step.includes('address=') || step.includes('*.lfibot') ? (
                <code className="text-blue-300 bg-gray-800 px-1 py-0.5 rounded text-[10px]">{step}</code>
              ) : (
                step
              )}
            </li>
          ))}
        </ol>
        {onCopy && copyValue && (
          <button
            onClick={onCopy}
            className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-gray-300 mt-1"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Gekopieerd!' : 'Kopieer regel'}
          </button>
        )}
        {note && (
          <p className="text-[10px] text-amber-500/70 mt-1">{note}</p>
        )}
      </div>
    </details>
  );
}
