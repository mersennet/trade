'use client';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import en from './en.json';
import es from './es.json';
import zh from './zh.json';
import ko from './ko.json';
import ja from './ja.json';

export type Locale = 'en' | 'es' | 'zh' | 'ko' | 'ja';

const messages: Record<Locale, Record<string, Record<string, string>>> = { en, es, zh, ko, ja };

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useLocale = create<I18nState>()(
  persist(
    (set) => ({
      locale: 'en',
      setLocale: (locale) => set({ locale }),
    }),
    { name: 'mersennet-trade-locale', partialize: (s) => ({ locale: s.locale }) }
  )
);

// Only complete locales are rendered. Others exist as partial dictionaries
// (nav + a few ticket strings) and would produce a mixed-language UI, so a
// persisted choice from before the switcher was hidden falls back to English.
const COMPLETE_LOCALES: ReadonlySet<Locale> = new Set<Locale>(['en']);

export function useTranslation() {
  const stored = useLocale((s) => s.locale);
  const locale: Locale = COMPLETE_LOCALES.has(stored) ? stored : 'en';

  function t(key: string, fallback?: string): string {
    const parts = key.split('.');
    const ns = parts[0];
    const k = parts.slice(1).join('.');
    return messages[locale]?.[ns]?.[k] || messages.en?.[ns]?.[k] || fallback || key;
  }

  return { t, locale };
}
