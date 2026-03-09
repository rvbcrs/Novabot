import { useT } from '../i18n/index.ts';

interface Props {
  onNext: () => void;
}

export default function Welcome({ onNext }: Props) {
  const { t } = useT();
  return (
    <div className="glass-card p-10 flex flex-col items-center text-center">
      <img src="/OpenNova.png" alt="OpenNova" className="h-44 w-auto mb-6" />

      <h2 className="text-3xl font-bold text-white mb-2">{t('welcome.title')}</h2>
      <p className="text-emerald-400 text-lg font-medium mb-6">{t('welcome.subtitle')}</p>

      <p className="text-gray-400 leading-relaxed max-w-md mb-8">
        {t('welcome.description')}
      </p>

      <div className="flex gap-6 mb-10 text-sm">
        {['feature1', 'feature2', 'feature3'].map(key => (
          <div key={key} className="flex items-center gap-2 text-gray-300">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            {t(`welcome.${key}`)}
          </div>
        ))}
      </div>

      <button
        onClick={onNext}
        className="w-full max-w-sm py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
      >
        {t('welcome.begin')}
      </button>
    </div>
  );
}
