import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolProgress } from '../src/pages/ToolsPage';

describe('tool progress', () => {
  it('marks done, current (aria-current) and not-started steps, with the blocker', () => {
    const html = renderToStaticMarkup(<ToolProgress p={{ done: ['placeholder', 'acquire'], current: 'test', blocker: 'failed: normal' }} />);
    expect(html.match(/class="done"/g)?.length).toBe(2);
    expect(html).toContain('aria-current="step"');
    expect(html.match(/class="todo"/g)?.length).toBe(4);
    expect(html).toContain('卡点：failed: normal');
  });
  it('shows ready when all steps are done', () => {
    const all = ['placeholder', 'acquire', 'test', 'release', 'deploy', 'install', 'available'] as const;
    const html = renderToStaticMarkup(<ToolProgress p={{ done: [...all], current: 'available' }} />);
    expect(html).not.toContain('aria-current');
    expect(html).toContain('就绪');
  });
});
