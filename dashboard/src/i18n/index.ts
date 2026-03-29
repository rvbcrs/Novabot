import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import nl from './locales/nl.json';
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';

i18n.use(initReactI18next).init({
  resources: {
    nl: { translation: nl },
    en: { translation: en },
    fr: { translation: fr },
    de: { translation: de },
  },
  lng: localStorage.getItem('lang') ?? 'nl',
  fallbackLng: 'nl',
  interpolation: { escapeValue: false },
});

export default i18n;
