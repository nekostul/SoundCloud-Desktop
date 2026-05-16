import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import ru from './locales/ru.json';
import ruRofl from './locales/ru-rofl.json';
import { DEFAULT_LANGUAGE, LANGUAGE_OPTIONS, normalizeLanguage } from './language';

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    'ru-x-rofl': { translation: ruRofl },
  },
  lng: normalizeLanguage(navigator.language),
  supportedLngs: LANGUAGE_OPTIONS.map((language) => language.code),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: { escapeValue: false },
});

// Sync language changes back to settings store
i18n.on('languageChanged', (lng) => {
  import('../stores/settings').then(({ useSettingsStore }) => {
    const store = useSettingsStore.getState();
    const nextLanguage = normalizeLanguage(lng);
    if (store.language !== nextLanguage) {
      store.setLanguage(nextLanguage);
    }
  });
});

export default i18n;
