export function Placeholder({ title, owner }: { title: string; owner: string }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
        <p>脚手架占位页 · 负责任务 {owner}</p>
      </div>
      <div className="panel">该页面由对应任务实现，交互与文案以已验收的 v12 原型为准。</div>
    </>
  );
}
