export const LANGUAGE_OPTIONS = [
  { code: 'en', label: 'English' },
  { code: 'ru', label: 'Русский' },
  { code: 'ru-x-rofl', label: 'Русский-Рофл' },
] as const;

export type AppLanguage = (typeof LANGUAGE_OPTIONS)[number]['code'];

export const DEFAULT_LANGUAGE: AppLanguage = 'en';

export function normalizeLanguage(value: string | null | undefined): AppLanguage {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) return DEFAULT_LANGUAGE;
  if (normalized === 'ru-x-rofl' || normalized === 'ru-rofl') return 'ru-x-rofl';
  if (normalized === 'ru' || normalized.startsWith('ru-')) return 'ru';
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';

  return DEFAULT_LANGUAGE;
}

export function getNextLanguage(value: string | null | undefined): AppLanguage {
  const current = normalizeLanguage(value);
  const currentIndex = LANGUAGE_OPTIONS.findIndex((language) => language.code === current);
  const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % LANGUAGE_OPTIONS.length : 0;
  return LANGUAGE_OPTIONS[nextIndex].code;
}

export function isRussianLanguage(value: string | null | undefined): boolean {
  return normalizeLanguage(value).startsWith('ru');
}
