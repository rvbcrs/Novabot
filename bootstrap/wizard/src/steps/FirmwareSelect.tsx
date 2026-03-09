import { useState, useRef, DragEvent } from 'react';
import type { FirmwareInfo } from '../App.tsx';
import { useT } from '../i18n/index.ts';

interface Props {
  firmware: FirmwareInfo | null;
  onUploaded: (fw: FirmwareInfo) => void;
}

export default function FirmwareSelect({ firmware, onUploaded }: Props) {
  const { t } = useT();
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<FirmwareInfo | null>(firmware);
  const inputRef = useRef<HTMLInputElement>(null);

  async function uploadFile(file: File) {
    setError(null);

    if (!file.name.endsWith('.deb')) {
      setError(t('firmware.invalidFormat'));
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append('firmware', file);

      const resp = await fetch('/api/firmware', { method: 'POST', body: form });
      const data = await resp.json() as { ok?: boolean; error?: string; name: string; version: string; size: number };

      if (!resp.ok || data.error) {
        setError(data.error ?? t('firmware.uploadFailed'));
        return;
      }

      const fw: FirmwareInfo = { name: data.name, version: data.version, size: data.size };
      setUploaded(fw);
    } catch (e) {
      setError(t('firmware.uploadError'));
      console.error(e);
    } finally {
      setUploading(false);
    }
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  }

  return (
    <div className="glass-card p-8">
      <h2 className="text-xl font-bold text-white mb-2">{t('firmware.title')}</h2>
      <p className="text-gray-400 mb-6 text-sm">
        {t('firmware.description', { file: 'novabot-v*-server.deb' })}
      </p>

      {/* Drop zone */}
      <div
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors mb-4 ${
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
          accept=".deb"
          className="hidden"
          onChange={handleFileChange}
        />

        {uploading ? (
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-gray-400">{t('firmware.uploading')}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <span className="text-4xl">{'\uD83D\uDCE6'}</span>
            <p className="text-gray-300 font-medium">{t('firmware.dropTitle')}</p>
            <p className="text-gray-500 text-sm">{t('firmware.dropSubtitle')}</p>
          </div>
        )}
      </div>

      {error && (
        <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-xl text-red-400 text-sm mb-4">
          {error}
        </div>
      )}

      {uploaded && !uploading && (
        <div className="p-4 bg-emerald-900/20 border border-emerald-700/50 rounded-xl mb-6">
          <div className="flex items-center gap-3">
            <span className="text-emerald-400 text-xl">{'\u2713'}</span>
            <div>
              <p className="text-white font-medium">{uploaded.name}</p>
              <p className="text-gray-400 text-sm">
                {t('firmware.version', { version: uploaded.version, size: (uploaded.size / 1024 / 1024).toFixed(1) })}
              </p>
            </div>
          </div>
        </div>
      )}

      <button
        onClick={() => uploaded && onUploaded(uploaded)}
        disabled={!uploaded || uploading}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors"
      >
        {t('firmware.next')}
      </button>
    </div>
  );
}
