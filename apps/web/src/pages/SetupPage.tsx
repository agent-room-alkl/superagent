import { useEffect, useState } from 'react';

interface LlmStatus {
  status: string;
  provider: string | null;
  keyLast4: string | null;
  primaryModel: string | null;
}

/** Setup (T-39). Scaffold stage shows status only. Key entry is server-side only and lands in a follow-up PR. */
export function SetupPage() {
  const [s, setS] = useState<LlmStatus | null>(null);
  useEffect(() => {
    fetch('/api/v1/setup/llm')
      .then((r) => r.json() as Promise<LlmStatus>)
      .then(setS)
      .catch(() => setS(null));
  }, []);
  return (
    <>
      <div className="page-head">
        <h1>管理设置</h1>
        <p>模型服务商、Key 与用量上限</p>
      </div>
      <div className="panel">
        <p>模型状态：{s ? (s.status === 'unconfigured' ? '未配置' : s.status) : '读取中…'}</p>
        {s?.keyLast4 ? <p>Key：••••{s.keyLast4}</p> : null}
      </div>
    </>
  );
}
