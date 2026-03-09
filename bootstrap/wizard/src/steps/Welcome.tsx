import { useT } from '../i18n/index.ts';

interface Props {
  onNext: () => void;
}

export default function Welcome({ onNext }: Props) {
  const { t } = useT();
  return (
    <div className="glass-card p-8">
      <div className="flex flex-col items-center mb-8">
        <img src="/OpenNova.png" alt="OpenNova" className="h-24 w-auto mb-4" />
        <h2 className="text-2xl font-bold text-white mb-2 text-center">{t('welcome.title')}</h2>
        <p className="text-gray-400 leading-relaxed text-center">
          {t('welcome.description')}
        </p>
      </div>

      <div className="space-y-3 mb-8">
        {[
          { num: '\u2460', title: t('welcome.step1Title'), desc: t('welcome.step1Desc') },
          { num: '\u2461', title: t('welcome.step2Title'), desc: t('welcome.step2Desc') },
          { num: '\u2462', title: t('welcome.step3Title'), desc: t('welcome.step3Desc') },
          { num: '\u2463', title: t('welcome.step4Title'), desc: t('welcome.step4Desc') },
        ].map(({ num, title, desc }, i) => (
          <div key={i} className="flex items-start gap-3 p-4 bg-gray-800/50 rounded-xl">
            <span className="text-emerald-400 mt-0.5">{num}</span>
            <div>
              <p className="text-white font-medium">{title}</p>
              <p className="text-gray-400 text-sm">{desc}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="p-4 bg-amber-900/30 border border-amber-700/50 rounded-xl mb-8">
        <div className="flex items-start gap-2">
          <span className="text-amber-400 mt-0.5">&#9888;</span>
          <div className="text-sm text-amber-300">
            <p className="font-medium mb-1">{t('welcome.requirements')}</p>
            <ul className="space-y-1 text-amber-400">
              <li>&#8226; {t('welcome.reqDocker')}</li>
              <li>&#8226; {t('welcome.reqWifi')}</li>
              <li>&#8226; {t('welcome.reqApp')}</li>
              <li>&#8226; {t('welcome.reqFirmware', { file: 'novabot-v*-server.deb' })}</li>
            </ul>
          </div>
        </div>
      </div>

      <button
        onClick={onNext}
        className="w-full py-3 px-6 bg-emerald-700 hover:bg-emerald-600 text-white font-semibold rounded-xl transition-colors"
      >
        {t('welcome.begin')}
      </button>
    </div>
  );
}
