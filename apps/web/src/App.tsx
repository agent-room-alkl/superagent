import { useEffect, useState } from 'react';
import { SetupPage } from './pages/SetupPage';
import { Placeholder } from './pages/Placeholder';
import { ToolsPage } from './pages/ToolsPage';
import { KnowledgePage } from './pages/KnowledgePage';

type NavItem = { id: string; label: string; owner: string };

/** Owner navigation: 7 entries, same as the accepted prototype (PRD §1.2). */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '日常工作',
    items: [
      { id: 'room', label: '指挥室', owner: 'T-41' },
      { id: 'work', label: '待我处理', owner: 'T-41' },
    ],
  },
  {
    group: '团队与知识',
    items: [
      { id: 'knowledge', label: '企业知识', owner: 'T-40' },
      { id: 'employees', label: '数字员工', owner: 'T-42' },
      { id: 'tools', label: '员工工具', owner: 'T-42' },
    ],
  },
  {
    group: '配置',
    items: [
      { id: 'brain', label: '超级智能体', owner: 'T-40' },
      { id: 'settings', label: '管理设置', owner: 'T-39' },
    ],
  },
];

function useHashPage(): string {
  const read = () => window.location.hash.slice(1) || 'room';
  const [page, setPage] = useState(read);
  useEffect(() => {
    const onChange = () => setPage(read());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}

export function App() {
  const page = useHashPage();
  const current = NAV.flatMap((g) => g.items).find((i) => i.id === page) ?? NAV[0]!.items[0]!;
  return (
    <>
      <header className="topbar">
        <span className="brand">INNOPRO</span>
        <span className="product">Super Agent</span>
      </header>
      <div className="app">
        <nav className="sidebar" aria-label="主菜单">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((i) => (
                <a key={i.id} className="nav-item" href={`#${i.id}`} aria-current={i.id === current.id ? 'page' : undefined}>
                  {i.label}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content">
          {current.id === 'settings' ? <SetupPage /> : current.id === 'tools' ? <ToolsPage /> : current.id === 'knowledge' ? <KnowledgePage /> : <Placeholder title={current.label} owner={current.owner} />}
        </main>
      </div>
    </>
  );
}
