import { useState, useRef, DragEvent } from 'react';
import type { DeviceMode, FirmwareInfo } from '../App.tsx';

interface Props {
  deviceMode: DeviceMode;
  onUploaded: (type: 'charger' | 'mower', fw: FirmwareInfo) => void;
  onNext: () => void;
  onSkip: () => void;
}

interface UploadZoneProps {
  label: string;
  accept: string;
  acceptLabel: string;
  firmware: FirmwareInfo | null;
  uploading: boolean;
  error: string | null;
  onFile: (file: File) => void;
}

function UploadZone({ label, accept, acceptLabel, firmware, uploading, error, onFile }: UploadZoneProps) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFile(file);
  }

  return (
    <div className="flex-1">
      <p className="text-gray-300 text-sm font-medium mb-2">{label}</p>

      <div
        className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-emerald-500 bg-emerald-900/20'
            : 'border-gray-700 hover:border-gray-500 bg-gray-800/30'
        }`}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleFileChange}
        />

        {uploading ? (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400 text-sm">Uploading...</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <span className="text-3xl">{'\uD83D\uDCE6'}</span>
            <p className="text-gray-300 text-sm font-medium">Drop file or click to browse</p>
            <p className="text-gray-600 text-xs">Accepts {acceptLabel} files</p>
          </div>
        )}
      </div>

      {error && (
        <div className="mt-2 p-2 bg-red-900/30 border border-red-700/50 rounded-lg text-red-400 text-xs">
          {error}
        </div>
      )}

      {firmware && !uploading && (
        <div className="mt-3 p-3 bg-emerald-900/20 border border-emerald-700/50 rounded-xl">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400">{'\u2713'}</span>
            <div>
              <p className="text-white text-sm font-medium">{firmware.name}</p>
              <p className="text-gray-400 text-xs">
                v{firmware.version} &middot; {(firmware.size / 1024 / 1024).toFixed(1)} MB
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FirmwareSelect2({ deviceMode, onUploaded, onNext, onSkip }: Props) {
  const [chargerFw, setChargerFw] = useState<FirmwareInfo | null>(null);
  const [mowerFw, setMowerFw] = useState<FirmwareInfo | null>(null);
  const [chargerUploading, setChargerUploading] = useState(false);
  const [mowerUploading, setMowerUploading] = useState(false);
  const [chargerError, setChargerError] = useState<string | null>(null);
  const [mowerError, setMowerError] = useState<string | null>(null);

  const showCharger = deviceMode === 'charger' || deviceMode === 'both';
  const showMower = deviceMode === 'mower' || deviceMode === 'both';

  async function uploadFile(file: File, type: 'charger' | 'mower') {
    const setUploading = type === 'charger' ? setChargerUploading : setMowerUploading;
    const setError = type === 'charger' ? setChargerError : setMowerError;
    const setFw = type === 'charger' ? setChargerFw : setMowerFw;

    // Validate file type
    const expectedExt = type === 'charger' ? '.bin' : '.deb';
    if (!file.name.endsWith(expectedExt)) {
      setError(`Invalid file type. Expected ${expectedExt} file.`);
      return;
    }

    setError(null);
    setUploading(true);

    try {
      const form = new FormData();
      form.append('firmware', file);
      form.append('type', type);

      const resp = await fetch('/api/firmware', { method: 'POST', body: form });
      const data = await resp.json() as { ok?: boolean; error?: string; name: string; version: string; size: number };

      if (!resp.ok || data.error) {
        setError(data.error ?? 'Upload failed');
        return;
      }

      const fw: FirmwareInfo = { name: data.name, version: data.version, size: data.size };
      setFw(fw);
      onUploaded(type, fw);
    } catch {
      setError('Upload failed. Check your connection.');
    } finally {
      setUploading(false);
    }
  }

  const hasAnyFirmware = chargerFw || mowerFw;

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">Firmware Select</h2>
      <p className="text-gray-400 mb-6 text-sm">
        Upload firmware for your device(s). This is optional &mdash; you can skip this step and flash firmware later
        from the dashboard.
      </p>

      <div className={`flex gap-6 mb-6 ${showCharger && showMower ? 'flex-col sm:flex-row' : ''}`}>
        {showCharger && (
          <UploadZone
            label="Charger Firmware"
            accept=".bin"
            acceptLabel=".bin"
            firmware={chargerFw}
            uploading={chargerUploading}
            error={chargerError}
            onFile={f => uploadFile(f, 'charger')}
          />
        )}
        {showMower && (
          <UploadZone
            label="Mower Firmware"
            accept=".deb"
            acceptLabel=".deb"
            firmware={mowerFw}
            uploading={mowerUploading}
            error={mowerError}
            onFile={f => uploadFile(f, 'mower')}
          />
        )}
      </div>

      <div className="flex gap-4">
        <button
          onClick={onNext}
          disabled={!hasAnyFirmware || chargerUploading || mowerUploading}
          className="flex-1 py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
        >
          Next
        </button>
        <button
          onClick={onSkip}
          disabled={chargerUploading || mowerUploading}
          className="flex-1 py-3 px-6 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors"
        >
          Skip Firmware
        </button>
      </div>
    </div>
  );
}
