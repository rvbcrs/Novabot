import { useState } from 'react';
import { ShieldCheck, Download, RefreshCw, ChevronDown, ChevronUp } from 'lucide-react';
import { checkCertTrusted } from '../../api/client';

interface Props {
  onCertTrusted: () => void;
}

export function CertInstallScreen({ onCertTrusted }: Props) {
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState(false);
  const [openGuide, setOpenGuide] = useState<string | null>('mac');

  const handleCheck = async () => {
    setChecking(true);
    setFailed(false);
    const trusted = await checkCertTrusted();
    setChecking(false);
    if (trusted) {
      onCertTrusted();
    } else {
      setFailed(true);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">

        {/* Icon + titel */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 bg-amber-900/30 rounded-2xl flex items-center justify-center mb-4 border border-amber-700/40">
            <ShieldCheck className="w-8 h-8 text-amber-400" />
          </div>
          <h1 className="text-xl font-bold text-white">Certificaat installeren</h1>
          <p className="text-sm text-gray-400 mt-1 text-center">
            De Novabot app gebruikt HTTPS. Installeer het lokale CA-certificaat zodat de app kan verbinden.
          </p>
        </div>

        {/* Download knop */}
        <a
          href="/api/dashboard/setup/ca-cert"
          download="opennova-ca.crt"
          className="flex items-center justify-center gap-2.5 w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-xl transition-colors mb-6 text-sm"
        >
          <Download className="w-4 h-4" />
          Download opennova-ca.crt
        </a>

        {/* Installatie handleidingen */}
        <div className="space-y-2 mb-6">
          <Guide
            title="Mac (inclusief iOS app op Apple Silicon)"
            open={openGuide === 'mac'}
            onToggle={() => setOpenGuide(g => g === 'mac' ? null : 'mac')}
            steps={[
              'Download opennova-ca.crt en dubbelklik → Keychain Access opent',
              'Het cert staat nu in de System keychain maar is nog NIET vertrouwd',
              'Dubbelklik op "OpenNova Local CA" in de lijst',
              'Klap "Trust" open (klik op het driehoekje)',
              'Zet "When using this certificate" op "Always Trust"',
              'Sluit het venster → voer je Mac-wachtwoord in als gevraagd',
              'Klik hieronder op "Controleer opnieuw"',
            ]}
          />
          <Guide
                        title="iPhone / iPad"
            open={openGuide === 'iphone'}
            onToggle={() => setOpenGuide(g => g === 'iphone' ? null : 'iphone')}
            steps={[
              'Stuur het .crt bestand naar je iPhone (AirDrop of mail)',
              'Open het bestand → "Profiel gedownload" verschijnt',
              'Ga naar Instellingen → Profiel gedownload → Installeer',
              'Ga naar Instellingen → Algemeen → Info → Vertrouwde certificaten',
              'Zet "OpenNova Local CA" aan',
            ]}
          />
        </div>

        {/* Check knop */}
        <button
          onClick={handleCheck}
          disabled={checking}
          className="flex items-center justify-center gap-2 w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 text-white font-medium py-2.5 rounded-xl transition-colors text-sm"
        >
          <RefreshCw className={`w-4 h-4 ${checking ? 'animate-spin' : ''}`} />
          {checking ? 'Controleren...' : 'Controleer opnieuw'}
        </button>

        {failed && (
          <p className="text-center text-xs text-red-400 mt-3">
            Certificaat nog niet vertrouwd. Installeer het en probeer opnieuw.
          </p>
        )}

        <p className="text-center text-[11px] text-gray-600 mt-4">
          Dit certificaat is alleen geldig voor *.lfibot.com op je lokale netwerk.
        </p>
      </div>
    </div>
  );
}

function Guide({ title, open, onToggle, steps }: {
  title: string;
  open: boolean;
  onToggle: () => void;
  steps: string[];
}) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-left"
      >
        <span className="text-xs font-medium text-gray-300">{title}</span>
        {open
          ? <ChevronUp className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
          : <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        }
      </button>
      {open && (
        <ol className="px-3.5 pb-3 space-y-1.5 border-t border-gray-800 pt-2.5">
          {steps.map((step, i) => (
            <li key={i} className="flex gap-2 text-[11px] text-gray-400 leading-relaxed">
              <span className="text-gray-600 font-mono flex-shrink-0">{i + 1}.</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
