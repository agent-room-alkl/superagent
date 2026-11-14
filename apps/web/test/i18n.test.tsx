import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LANG_STORAGE_KEY, LangProvider, LangSwitch, storedLang, translate, useT, type Dict } from '../src/i18n';
import { Placeholder } from '../src/pages/Placeholder';

const TEXT: Dict<'title' | 'count' | 'onlyEnglish'> = {
  en: { title: 'Tools', count: '{n} of {total} installed', onlyEnglish: 'Not translated yet' },
  zh: { title: '员工工具', count: '已安装 {n} / {total}' },
};

function Sample() {
  const t = useT(TEXT);
  return <p>{t('title')}|{t('count', { n: 2, total: 5 })}|{t('onlyEnglish')}</p>;
}

const storage = (value: string | null) => ({ getItem: (key: string) => (key === LANG_STORAGE_KEY ? value : null) });

describe('interface language', () => {
  it('is English unless Chinese was chosen in this browser', () => {
    expect(storedLang(storage(null))).toBe('en');
    expect(storedLang(storage('zh'))).toBe('zh');
    expect(storedLang(storage('en'))).toBe('en');
    expect(storedLang(storage('fr'))).toBe('en'); // an unknown stored value is not trusted
    expect(storedLang(undefined)).toBe('en'); // no storage at all
    expect(storedLang({ getItem: () => { throw new Error('blocked'); } })).toBe('en');
  });

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translate(TEXT, 'en', 'count', { n: 2, total: 5 })).toBe('2 of 5 installed');
    expect(translate(TEXT, 'zh', 'count', { n: 2, total: 5 })).toBe('已安装 2 / 5');
    expect(translate(TEXT, 'en', 'count', { n: 2 })).toBe('2 of {total} installed');
  });

  it('shows the English text for a key Chinese does not have yet, never the key name', () => {
    expect(translate(TEXT, 'zh', 'onlyEnglish')).toBe('Not translated yet');
  });

  it('renders English without a provider and the chosen language inside one', () => {
    expect(renderToStaticMarkup(<Sample />)).toBe('<p>Tools|2 of 5 installed|Not translated yet</p>');
    expect(renderToStaticMarkup(<LangProvider initial="zh"><Sample /></LangProvider>)).toBe('<p>员工工具|已安装 2 / 5|Not translated yet</p>');
    expect(renderToStaticMarkup(<LangProvider><Sample /></LangProvider>)).toContain('Tools'); // nothing stored on the server side
  });

  it('marks the chosen language in the switch and labels each language in its own language', () => {
    const en = renderToStaticMarkup(<LangProvider initial="en"><LangSwitch label="Language" /></LangProvider>);
    expect(en).toContain('role="group"');
    expect(en).toContain('aria-label="Language"');
    expect(en).toMatch(/<button[^>]*aria-pressed="true"[^>]*>EN<\/button>/);
    expect(en).toMatch(/<button[^>]*aria-pressed="false"[^>]*>中文<\/button>/);
    const zh = renderToStaticMarkup(<LangProvider initial="zh"><LangSwitch label="语言" /></LangProvider>);
    expect(zh).toMatch(/<button[^>]*aria-pressed="true"[^>]*>中文<\/button>/);
  });

  it('translates the placeholder page', () => {
    expect(renderToStaticMarkup(<Placeholder title="Digital employees" owner="T-42" />)).toContain('Placeholder page · owning task T-42');
    expect(renderToStaticMarkup(<LangProvider initial="zh"><Placeholder title="数字员工" owner="T-42" /></LangProvider>)).toContain('脚手架占位页 · 负责任务 T-42');
  });
});
