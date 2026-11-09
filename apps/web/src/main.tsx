import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/shell.css';
import { App } from './App';
import { initAuth } from './auth';

const root = createRoot(document.getElementById('root')!);

initAuth()
  .then((user) =>
    root.render(
      <React.StrictMode>
        <App user={user} />
      </React.StrictMode>,
    ),
  )
  .catch((e: unknown) => root.render(<p className="warn" role="alert">无法登录：{e instanceof Error ? e.message : String(e)}</p>));
