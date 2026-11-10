import { useEffect, useState } from 'react';
import { SetupPage } from './pages/SetupPage';
import { Placeholder } from './pages/Placeholder';
import { ToolsPage } from './pages/ToolsPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { signOut, type SignedIn } from './auth';
import { authHeaders } from './api';
import { SuperAgentPage } from './pages/SuperAgentPage';
import { CommandRoomPage } from './pages/CommandRoomPage';
import { WorkInboxPage } from './pages/WorkInboxPage';

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

/**
 * Someone signed in only as an employee works from the two daily pages (prototype QA: "Employee navigation
 * expanded"). This trims the menu; the server still decides what each role may call.
 */
export function navFor(roles: readonly string[] | null): typeof NAV {
  const staffOnly = roles !== null && roles.includes('employee') && !roles.some((role) => role === 'owner' || role === 'admin' || role === 'reviewer');
  return staffOnly ? NAV.filter((group) => group.group === '日常工作') : NAV;
}

function useRoles(): string[] | null {
  const [roles, setRoles] = useState<string[] | null>(null);
  useEffect(() => {
    let stop = false;
    void (async () => {
      try {
        const response = await fetch('/api/v1/room/roster', { headers: await authHeaders() });
        if (!response.ok) return;
        const data = (await response.json()) as { viewer?: { roles?: string[] } };
        if (!stop && Array.isArray(data.viewer?.roles)) setRoles(data.viewer.roles);
      } catch {
        // Without an answer the full menu stays; every module still checks the role on the server.
      }
    })();
    return () => {
      stop = true;
    };
  }, []);
  return roles;
}

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

export function App({ user = { mode: 'dev' } }: { user?: SignedIn }) {
  const page = useHashPage();
  const nav = navFor(useRoles());
  const current = nav.flatMap((g) => g.items).find((i) => i.id === page) ?? nav[0]!.items[0]!;
  return (
    <>
      <header className="topbar">
        <span className="brand">INNOPRO</span>
        <span className="product">Super Agent</span>
        {user.mode === 'entra' ? (
          <span className="who">
            <span title={user.username}>{user.name ?? user.username}</span>
            <button className="btn" type="button" onClick={() => void signOut()}>退出</button>
          </span>
        ) : null}
      </header>
      <div className="app">
        <nav className="sidebar" aria-label="主菜单">
          {nav.map((g) => (
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
          {current.id === 'settings' ? <SetupPage /> : current.id === 'tools' ? <ToolsPage /> : current.id === 'knowledge' ? <KnowledgePage /> : current.id === 'brain' ? <SuperAgentPage /> : current.id === 'room' ? <CommandRoomPage /> : current.id === 'work' ? <WorkInboxPage /> : <Placeholder title={current.label} owner={current.owner} />}
        </main>
      </div>
    </>
  );
}
