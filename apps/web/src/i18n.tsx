/**
 * Two-language interface text. English is the default; the choice is remembered in this browser only.
 *
 * Each page owns its dictionary and reads it with `useT(dict)`. There is deliberately no shared dictionary file, so
 * two people can change two pages without touching the same file:
 *
 *   const TEXT = { en: { title: 'Tools', count: '{n} installed' }, zh: { title: '员工工具', count: '已安装 {n} 个' } } satisfies Dict<string>;
 *   const t = useT(TEXT);
 *   t('title'); t('count', { n: 3 });
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Lang = 'en' | 'zh';

/** Each language is labelled in its own language, so someone who cannot read the current one can still find theirs. */
export const LANGS: readonly { id: Lang; label: string; htmlLang: string }[] = [
  { id: 'en', label: 'EN', htmlLang: 'en' },
  { id: 'zh', label: '中文', htmlLang: 'zh-CN' },
];

export const LANG_STORAGE_KEY = 'superagent.lang';

/** English must be complete; Chinese may lag behind a new key and then shows the English text for that key. */
export interface Dict<K extends string> {
  en: Record<K, string>;
  zh: Partial<Record<K, string>>;
}

export type Vars = Record<string, string | number>;

function browserStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined; // storage blocked (private mode, sandboxed frame)
  }
}

/** The remembered language, or English when nothing valid is stored or storage is unavailable. */
export function storedLang(storage: Pick<Storage, 'getItem'> | undefined = browserStorage()): Lang {
  try {
    return storage?.getItem(LANG_STORAGE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** Looks a key up in the chosen language, falls back to English, and fills `{name}` placeholders from `vars`. */
export function translate<K extends string>(dict: Dict<K>, lang: Lang, key: K, vars?: Vars): string {
  const text: string = (lang === 'zh' ? dict.zh[key] : undefined) ?? dict.en[key] ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole: string, name: string) => (name in vars ? String(vars[name]) : whole));
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

/** Without a provider (unit tests that render one component) everything is English and switching does nothing. */
const LangContext = createContext<LangState>({ lang: 'en', setLang: () => undefined });

export function LangProvider({ children, initial }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => initial ?? storedLang());
  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      browserStorage()?.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Storage refused the write: the choice still applies until the page is closed.
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = LANGS.find((l) => l.id === lang)?.htmlLang ?? 'en';
  }, [lang]);
  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useLang(): [Lang, (lang: Lang) => void] {
  const { lang, setLang } = useContext(LangContext);
  return [lang, setLang];
}

export function useT<K extends string>(dict: Dict<K>): (key: K, vars?: Vars) => string {
  const [lang] = useLang();
  return useCallback((key: K, vars?: Vars) => translate(dict, lang, key, vars), [dict, lang]);
}

/** The EN / 中文 control in the top bar. */
export function LangSwitch({ label }: { label: string }) {
  const [lang, setLang] = useLang();
  return (
    <div className="lang-switch" role="group" aria-label={label}>
      {LANGS.map((l) => (
        <button key={l.id} type="button" lang={l.htmlLang} aria-pressed={l.id === lang} onClick={() => setLang(l.id)}>
          {l.label}
        </button>
      ))}
    </div>
  );
}
