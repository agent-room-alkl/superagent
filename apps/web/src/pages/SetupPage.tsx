import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

interface LlmStatus {
  status: string;
  provider: string | null;
  keyLast4: string | null;
  primaryModel: string | null;
  economyModel: string | null;
  monthlyCapMicroUsd: number | null;
  reminder: string | null;
}
interface TestResponse {
  auth: string;
  listing: string;
  tools: string;
  message: string;
  selectable: string[];
  unverified: string[];
}

const PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic（Claude）' },
  { id: 'openai', label: 'OpenAI（GPT）' },
  { id: 'azure-openai', label: 'Azure OpenAI' },
];
const STATUS_LABEL: Record<string, string> = { unconfigured: '未配置', configured: '已配置', revoked: '已撤销', key_invalid: 'Key 失效' };
const AUTH_LABEL: Record<string, string> = { ok: '通过', invalid_key: 'Key 无效', quota: '额度不足', network: '网络错误', error: '其他错误' };

/** Setup (PRD §3.1). The key is sent once to the server for testing/activation and never kept in the browser. */
export function SetupPage() {
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [provider, setProvider] = useState('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [probeModel, setProbeModel] = useState('');
  const [test, setTest] = useState<TestResponse | null>(null);
  const [primary, setPrimary] = useState('');
  const [economy, setEconomy] = useState('');
  const [msg, setMsg] = useState('');
  const [capUsd, setCapUsd] = useState('');
  const [capMsg, setCapMsg] = useState('');

  const load = () => api<LlmStatus>('/api/v1/setup/llm').then((r) => setStatus(r.status === 200 ? r.body : null));
  useEffect(() => void load(), []);

  const body = () => ({ provider, apiKey, probeModel, ...(provider === 'azure-openai' ? { endpoint } : {}) });

  async function onTest(e: FormEvent) {
    e.preventDefault();
    setMsg('测试中…');
    const r = await api<TestResponse>('/api/v1/setup/llm/test', { method: 'POST', body: JSON.stringify(body()) });
    setTest(r.status === 200 ? r.body : null);
    setMsg(r.status === 200 ? '' : '请求失败');
  }

  async function onActivate() {
    const r = await api<LlmStatus & { error?: string; message?: string }>('/api/v1/setup/llm', {
      method: 'PUT',
      body: JSON.stringify({ ...body(), primaryModel: primary, economyModel: economy || undefined }),
    });
    setApiKey(''); // never keep the key in the page after submit
    setMsg(r.status === 200 ? '已保存到 Key Vault 并生效' : `未生效：${r.body.message ?? r.body.error}`);
    if (r.status === 200) {
      setTest(null);
      await load();
    }
  }

  async function onSaveCap(e: FormEvent) {
    e.preventDefault();
    const r = await api<LlmStatus & { message?: string }>('/api/v1/setup/llm/budget', { method: 'PUT', body: JSON.stringify({ monthlyCapUsd: Number(capUsd) }) });
    setCapMsg(r.status === 200 ? '已保存，立即对本月生效' : `未保存：${r.body.message ?? '请求失败'}`);
    if (r.status === 200) {
      setCapUsd('');
      await load();
    }
  }

  const capText = status?.monthlyCapMicroUsd != null ? `US$${(status.monthlyCapMicroUsd / 1_000_000).toFixed(2)} / 月` : '未设置（模型调用会被拒绝）';

  return (
    <>
      <div className="page-head">
        <h1>管理设置</h1>
        <p>模型服务商、Key 与用量上限</p>
      </div>
      <section className="panel stack">
        <h2 className="h2">当前模型</h2>
        <p>
          状态：{status ? STATUS_LABEL[status.status] ?? status.status : '读取中…'}
          {status?.keyLast4 ? ` · Key ••••${status.keyLast4}` : ''}
          {status?.primaryModel ? ` · 主模型 ${status.primaryModel}` : ''}
          {status?.economyModel ? ` · 经济模型 ${status.economyModel}` : ''}
        </p>
        {status?.reminder ? <p className="warn">{status.reminder}</p> : null}
      </section>

      <form className="panel stack" onSubmit={onSaveCap}>
        <h2 className="h2">月度用量上限</h2>
        <p>当前上限：{capText}</p>
        <p className="helper">硬上限：每次调用前按最大可能费用预留，超出上限的调用不会发出。下调到低于本月已用额度时，新调用会被拒绝。</p>
        <label className="field">
          <span>新的上限（美元，最多两位小数）</span>
          <input inputMode="decimal" value={capUsd} onChange={(e) => setCapUsd(e.target.value)} placeholder="例如 200" required />
        </label>
        <button className="btn" type="submit">保存上限</button>
        {capMsg ? <p className="helper">{capMsg}</p> : null}
      </form>

      <form className="panel stack" onSubmit={onTest}>
        <h2 className="h2">设置或更换 Key</h2>
        <label className="field">
          <span>服务商</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
        {provider === 'azure-openai' ? (
          <label className="field">
            <span>Endpoint</span>
            <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://<resource>.openai.azure.com" />
          </label>
        ) : null}
        <label className="field">
          <span>API Key（只发送到服务端，保存于 Key Vault）</span>
          <input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} required />
        </label>
        <label className="field">
          <span>用于测试的模型 ID（Azure 填部署名）</span>
          <input value={probeModel} onChange={(e) => setProbeModel(e.target.value)} required />
        </label>
        <button className="btn primary" type="submit">测试连接</button>
        {msg ? <p className="helper">{msg}</p> : null}
      </form>

      {test ? (
        <section className="panel stack">
          <h2 className="h2">测试结果</h2>
          <p>认证：{AUTH_LABEL[test.auth] ?? test.auth} · 模型列表：{test.listing === 'ok' ? '已获取' : '无法自动获取'} · 工具调用：{test.tools === 'ok' ? '通过' : test.tools === 'skipped' ? '未测' : '未通过'}</p>
          {test.message ? <p className="helper">{test.message}</p> : null}
          {test.auth === 'ok' ? (
            <>
              <label className="field">
                <span>主模型（仅显示已通过平台能力测试的模型）</span>
                <select value={primary} onChange={(e) => setPrimary(e.target.value)}>
                  <option value="">请选择</option>
                  {test.selectable.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>经济模型（可选，批量抽取用）</span>
                <select value={economy} onChange={(e) => setEconomy(e.target.value)}>
                  <option value="">与主模型相同</option>
                  {test.selectable.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </label>
              {test.unverified.length ? <p className="helper">未验证（不可选）：{test.unverified.join('，')}</p> : null}
              <button className="btn primary" type="button" disabled={!primary || !apiKey} onClick={onActivate}>保存并生效</button>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
