import { useState, useEffect } from 'react';
import { Settings, CheckCircle, XCircle, RefreshCw, Wifi, Server, Globe, Copy, Check, ShieldCheck, Download } from 'lucide-react';
import { useTranslation, Trans } from 'react-i18next';
import { fetchSetupInfo, testDns, type SetupInfo } from '../../api/client';

type DnsTest = 'idle' | 'testing' | 'ok' | 'fail';

export function SetupWizard() {
  const { t } = useTranslation();
  const steps = (prefix: string, n: number, vars?: Record<string, string>) =>
    Array.from({ length: n }, (_, i) => t(`${prefix}.s${i + 1}`, vars));
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
      setDnsError(result.error ?? t('setup.wizard.dnsTestFailed'));
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
          <span className="text-sm font-medium">{t('setup.wizard.title')}</span>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 space-y-4">

        {/* Server info */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">{t('header.server')}</div>
          <div className="space-y-1">
            <InfoRow icon={Server} label="IP" value={ip} onCopy={() => copyText(ip, 'ip')} copied={copied === 'ip'} />
            <InfoRow icon={Wifi} label="HTTP" value={t('setup.wizard.port', { port: info?.port ?? 3000 })} />
            <InfoRow icon={Wifi} label="MQTT" value={t('setup.wizard.port', { port: 1883 })} />
            <InfoRow icon={Globe} label="DNS" value={info?.dnsEnabled ? t('setup.wizard.dnsBuiltin') : t('setup.wizard.dnsDisabled')} />
          </div>
        </div>

        {/* DNS Test */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">{t('setup.wizard.dnsTest')}</div>
          <p className="text-[11px] text-gray-400 mb-2">
            <Trans i18nKey="setup.wizard.dnsTestHint" components={{ c: <code className="text-blue-300" /> }} />
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
              <><RefreshCw className="w-3.5 h-3.5 animate-spin" />{t('setup.wizard.testing')}</>
            ) : dnsTest === 'ok' ? (
              <><CheckCircle className="w-3.5 h-3.5" />{t('setup.wizard.dnsOk')}</>
            ) : dnsTest === 'fail' ? (
              <><XCircle className="w-3.5 h-3.5" />{t('setup.wizard.dnsFail')}</>
            ) : (
              <><Globe className="w-3.5 h-3.5" />{t('setup.wizard.testDns')}</>
            )}
          </button>
          {dnsTest === 'fail' && dnsError && (
            <p className="text-[10px] text-red-400 mt-1">{dnsError}</p>
          )}
          {dnsTest === 'ok' && (
            <p className="text-[10px] text-emerald-400 mt-1">
              {t('setup.wizard.dnsPointsTo', { ip })}
            </p>
          )}
        </div>

        {/* TLS Certificaat */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">{t('setup.wizard.tlsTitle')}</div>
          <p className="text-[11px] text-gray-400 mb-2">
            {t('setup.wizard.tlsIntro')}
          </p>
          <a
            href="/api/dashboard/setup/ca-cert"
            download="opennova-ca.crt"
            className="w-full flex items-center justify-center gap-2 text-xs py-2 rounded bg-blue-700/80 text-white hover:bg-blue-600 transition-colors mb-3"
          >
            <Download className="w-3.5 h-3.5" />
            {t('setup.cert.download')}
          </a>

          <DnsGuide
            title={t('setup.wizard.macSimTitle')}
            steps={steps('setup.wizard.macSim', 5)}
          />
          <DnsGuide
            title="iPhone / iPad"
            steps={steps('setup.cert.iphone', 5)}
          />
          <DnsGuide
            title="Android"
            steps={steps('setup.cert.androidDownload', 3)}
          />
          <div className="flex items-start gap-2 mt-2 bg-amber-950/30 border border-amber-800/30 rounded px-2.5 py-2">
            <ShieldCheck className="w-3 h-3 text-amber-400 flex-shrink-0 mt-0.5" />
            <p className="text-[10px] text-amber-300/80">
              <Trans i18nKey="setup.wizard.certScope" components={{ c: <code className="text-amber-200" /> }} />
            </p>
          </div>
        </div>

        {/* DNS Instructions */}
        <div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wide mb-1.5">{t('setup.wizard.dnsSetupTitle')}</div>
          <p className="text-[11px] text-gray-400 mb-3">
            <Trans i18nKey="setup.wizard.dnsSetupIntro" components={{ c: <code className="text-blue-300" /> }} />
          </p>

          {/* AdGuard */}
          <DnsGuide
            title="AdGuard Home"
            steps={steps('setup.wizard.adguard', 4, { ip })}
            copyValue={rewriteRule}
            onCopy={() => copyText(`*.lfibot.com\t${ip}`, 'adguard')}
            copied={copied === 'adguard'}
          />

          {/* Pi-hole */}
          <DnsGuide
            title="Pi-hole"
            steps={[t('setup.wizard.pihole.s1'), t('setup.wizard.pihole.s2'), `address=/lfibot.com/${ip}`, t('setup.wizard.pihole.s4')]}
            copyValue={`address=/lfibot.com/${ip}`}
            onCopy={() => copyText(`address=/lfibot.com/${ip}`, 'pihole')}
            copied={copied === 'pihole'}
          />

          {/* Router */}
          <DnsGuide
            title="Router DNS"
            steps={steps('setup.wizard.router', 5, { ip })}
            note={t('setup.wizard.dnsNote')}
          />

          {/* Manual phone */}
          <DnsGuide
            title={t('setup.wizard.manualTitle')}
            steps={steps('setup.wizard.manual', 2, { ip })}
            note={t('setup.wizard.dnsNote')}
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
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between bg-gray-800 rounded px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <Icon className="w-3 h-3 text-gray-500" />
        <span className="text-[10px] text-gray-400">{label}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] font-mono text-gray-200">{value}</span>
        {onCopy && (
          <button onClick={onCopy} className="text-gray-600 hover:text-gray-300 p-0.5" title={t('setup.wizard.copy')}>
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
  const { t } = useTranslation();
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
            {copied ? t('setup.wizard.copied') : t('setup.wizard.copyLine')}
          </button>
        )}
        {note && (
          <p className="text-[10px] text-amber-500/70 mt-1">{note}</p>
        )}
      </div>
    </details>
  );
}
