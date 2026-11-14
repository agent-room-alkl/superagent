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
import { LangSwitch, useT, type Dict } from './i18n';

type NavGroupId = 'daily' | 'team' | 'config';
type NavItemId = 'room' | 'work' | 'knowledge' | 'employees' | 'tools' | 'brain' | 'settings';
type NavItem = { id: NavItemId; owner: string };

/** Owner navigation: 7 entries, same as the accepted prototype (PRD §1.2). Labels live in TEXT below. */
const NAV: { group: NavGroupId; items: NavItem[] }[] = [
  {
    group: 'daily',
    items: [
      { id: 'room', owner: 'T-41' },
      { id: 'work', owner: 'T-41' },
    ],
  },
  {
    group: 'team',
    items: [
      { id: 'knowledge', owner: 'T-40' },
      { id: 'employees', owner: 'T-42' },
      { id: 'tools', owner: 'T-42' },
    ],
  },
  {
    group: 'config',
    items: [
      { id: 'brain', owner: 'T-40' },
      { id: 'settings', owner: 'T-39' },
    ],
  },
];

type ShellKey = `group.${NavGroupId}` | `nav.${NavItemId}` | 'menu' | 'signOut' | 'language';

const TEXT: Dict<ShellKey> = {
  en: {
    'group.daily': 'Daily work',
    'group.team': 'Team & knowledge',
    'group.config': 'Configuration',
    'nav.room': 'Command room',
    'nav.work': 'My work',
    'nav.knowledge': 'Company knowledge',
    'nav.employees': 'Digital employees',
    'nav.tools': 'Employee tools',
    'nav.brain': 'Super agent',
    'nav.settings': 'Admin settings',
    menu: 'Main menu',
    signOut: 'Sign out',
    language: 'Language',
  },
  zh: {
    'group.daily': '日常工作',
    'group.team': '团队与知识',
    'group.config': '配置',
    'nav.room': '指挥室',
    'nav.work': '待我处理',
    'nav.knowledge': '企业知识',
    'nav.employees': '数字员工',
    'nav.tools': '员工工具',
    'nav.brain': '超级智能体',
    'nav.settings': '管理设置',
    menu: '主菜单',
    signOut: '退出',
    language: '语言',
  },
};

/**
 * Someone signed in only as an employee works from the two daily pages (prototype QA: "Employee navigation
 * expanded"). This trims the menu; the server still decides what each role may call.
 */
export function navFor(roles: readonly string[] | null): typeof NAV {
  const staffOnly = roles !== null && roles.includes('employee') && !roles.some((role) => role === 'owner' || role === 'admin' || role === 'reviewer');
  return staffOnly ? NAV.filter((group) => group.group === 'daily') : NAV;
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
  const t = useT(TEXT);
  const page = useHashPage();
  const nav = navFor(useRoles());
  const current = nav.flatMap((g) => g.items).find((i) => i.id === page) ?? nav[0]!.items[0]!;
  return (
    <>
      <header className="topbar">
        <span className="brand">INNOPRO</span>
        <span className="product">Super Agent</span>
        <span className="topbar-end">
          <LangSwitch label={t('language')} />
          {user.mode === 'entra' ? (
            <span className="who">
              <span title={user.username}>{user.name ?? user.username}</span>
              <button className="btn" type="button" onClick={() => void signOut()}>{t('signOut')}</button>
            </span>
          ) : null}
        </span>
      </header>
      <div className="app">
        <nav className="sidebar" aria-label={t('menu')}>
          {nav.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{t(`group.${g.group}`)}</div>
              {g.items.map((i) => (
                <a key={i.id} className="nav-item" href={`#${i.id}`} aria-current={i.id === current.id ? 'page' : undefined}>
                  {t(`nav.${i.id}`)}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <main className="content">
          {current.id === 'settings' ? <SetupPage /> : current.id === 'tools' ? <ToolsPage /> : current.id === 'knowledge' ? <KnowledgePage /> : current.id === 'brain' ? <SuperAgentPage /> : current.id === 'room' ? <CommandRoomPage /> : current.id === 'work' ? <WorkInboxPage /> : <Placeholder title={t(`nav.${current.id}`)} owner={current.owner} />}
        </main>
      </div>
    </>
  );
}
