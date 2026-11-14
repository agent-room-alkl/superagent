import { useT, type Dict } from '../i18n';

const TEXT: Dict<'subtitle' | 'body'> = {
  en: {
    subtitle: 'Placeholder page · owning task {owner}',
    body: 'This page is built by its owning task. Interaction and wording follow the accepted v12 prototype.',
  },
  zh: {
    subtitle: '脚手架占位页 · 负责任务 {owner}',
    body: '该页面由对应任务实现，交互与文案以已验收的 v12 原型为准。',
  },
};

export function Placeholder({ title, owner }: { title: string; owner: string }) {
  const t = useT(TEXT);
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        <p>{t('subtitle', { owner })}</p>
      </div>
      <div className="panel">{t('body')}</div>
    </>
  );
}
