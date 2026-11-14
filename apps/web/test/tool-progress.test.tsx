import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../src/i18n';
import { ToolProgress, ToolsPage } from '../src/pages/ToolsPage';

describe('tool progress', () => {
  it('marks done, current (aria-current) and not-started steps, with the blocker', () => {
    const html = renderToStaticMarkup(
      <LangProvider initial="zh">
        <ToolProgress p={{ done: ['placeholder', 'acquire'], current: 'test', blocker: 'failed: normal' }} />
      </LangProvider>,
    );
    expect(html.match(/class="done"/g)?.length).toBe(2);
    expect(html).toContain('aria-current="step"');
    expect(html.match(/class="todo"/g)?.length).toBe(4);
    expect(html).toContain('卡点：failed: normal');
  });
  it('shows ready when all steps are done', () => {
    const all = ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'] as const;
    const html = renderToStaticMarkup(
      <LangProvider initial="zh">
        <ToolProgress p={{ done: [...all], current: 'available' }} />
      </LangProvider>,
    );
    expect(html).not.toContain('aria-current');
    expect(html).toContain('就绪');
  });
  it('renders English by default and bilingual tool store headings', () => {
    const en = renderToStaticMarkup(<ToolsPage />);
    expect(en).toContain('Tool store');
    expect(en).toContain('Custom tools');
    const zh = renderToStaticMarkup(
      <LangProvider initial="zh">
        <ToolsPage />
      </LangProvider>,
    );
    expect(zh).toContain('工具商店');
    expect(zh).toContain('自定义工具');
  });
});
