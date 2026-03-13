import { useT } from '../i18n/index.ts';

interface Props {
  onNext: () => void;
}

export default function Welcome({ onNext }: Props) {
  const { t } = useT();

  const features = [
    { icon: '👤', key: 'welcome.features.account' },
    { icon: '📡', key: 'welcome.features.devices' },
    { icon: '📊', key: 'welcome.features.history' },
    { icon: '🗺️', key: 'welcome.features.maps' },
    { icon: '📅', key: 'welcome.features.schedules' },
    { icon: '⚙️', key: 'welcome.features.firmware' },
  ];

  return (
    <div className="glass-card p-8">
      <div className="relative z-10">
        <div className="text-center mb-6">
          <div className="text-5xl mb-4">☁️</div>
          <h1 className="text-2xl font-bold text-white mb-2">{t('welcome.title')}</h1>
          <p className="text-gray-400">{t('welcome.subtitle')}</p>
        </div>

        <p className="text-gray-300 text-sm mb-6 leading-relaxed">
          {t('welcome.description')}
        </p>

        <div className="grid grid-cols-2 gap-3 mb-8">
          {features.map(f => (
            <div key={f.key} className="flex items-center gap-2 bg-white/5 rounded-lg p-3">
              <span className="text-lg">{f.icon}</span>
              <span className="text-sm text-gray-300">{t(f.key)}</span>
            </div>
          ))}
        </div>

        <button
          onClick={onNext}
          className="w-full py-3 bg-sky-600 hover:bg-sky-500 text-white font-semibold rounded-xl transition-all"
        >
          {t('welcome.start')} →
        </button>
      </div>
    </div>
  );
}
