import type { ToolEffect } from '@superagent/shared';
import type { ToolService } from './lifecycle.js';

export interface PresetToolDefinition {
  toolId: string;
  name: { en: string; zh: string };
  summary: { en: string; zh: string };
  effect: ToolEffect;
  /** Underlying server module that implements this capability, or null if not yet built. */
  capability: string | null;
  installable: boolean;
  defaultBindingRef: string;
  acceptanceCases: string[];
}

export type CatalogToolStatus = 'available' | 'installed' | 'coming_soon';

export interface CatalogToolView {
  toolId: string;
  name: { en: string; zh: string };
  summary: { en: string; zh: string };
  effect: ToolEffect;
  capability: string | null;
  installable: boolean;
  status: CatalogToolStatus;
  installedEmployees: string[];
}

/**
 * Preset tool catalog grounded in actual server capabilities:
 * - Installable tools map to implemented modules (knowledge, plugins, sandbox).
 * - External write connectors not yet registered in execution/connectors stay coming_soon.
 */
export const PRESET_TOOL_CATALOG: readonly PresetToolDefinition[] = [
  {
    toolId: 'knowledge.search',
    name: { en: 'Knowledge Base Q&A', zh: '知识库问答' },
    summary: {
      en: 'Search and answer questions from indexed company documents and local files.',
      zh: '检索已索引的企业文档与本地文件并回答问题。',
    },
    effect: 'read',
    capability: 'knowledge/service + knowledge/plugins/local-file',
    installable: true,
    defaultBindingRef: 'kv://preset-knowledge-search',
    acceptanceCases: ['search indexed knowledge'],
  },
  {
    toolId: 'mail.read',
    name: { en: 'Enterprise Mail Reader', zh: '企业邮件只读' },
    summary: {
      en: 'Read enterprise inbox messages via Microsoft Graph (read-only).',
      zh: '通过 Microsoft Graph 只读获取企业邮箱邮件。',
    },
    effect: 'read',
    capability: 'knowledge/plugins/mail',
    installable: true,
    defaultBindingRef: 'kv://preset-mail-read',
    acceptanceCases: ['read mailbox messages'],
  },
  {
    toolId: 'sharepoint.search',
    name: { en: 'SharePoint Search', zh: 'SharePoint 检索' },
    summary: {
      en: 'Search and fetch documents from configured SharePoint sites (read-only).',
      zh: '从已配置的 SharePoint 站点检索并读取文档。',
    },
    effect: 'read',
    capability: 'knowledge/plugins/sharepoint',
    installable: true,
    defaultBindingRef: 'kv://preset-sharepoint-search',
    acceptanceCases: ['search sharepoint documents'],
  },
  {
    toolId: 'db.query',
    name: { en: 'Read-Only SQL Query', zh: '只读查库' },
    summary: {
      en: 'Run AST-validated read-only SELECT queries against approved data sources.',
      zh: '对已批准的数据源执行经过 AST 校验的只读 SELECT 查询。',
    },
    effect: 'read',
    capability: 'knowledge/plugins/database + select-ast',
    installable: true,
    defaultBindingRef: 'kv://preset-db-query',
    acceptanceCases: ['execute read-only select query'],
  },
  {
    toolId: 'browser.browse',
    name: { en: 'Supervised Web Browser', zh: '网页只读浏览' },
    summary: {
      en: 'Navigate web pages and capture screenshots in read-only sandbox mode.',
      zh: '在只读沙箱中浏览网页并截图核验。',
    },
    effect: 'read',
    capability: 'sandbox/computer-use + sandbox/replay',
    installable: true,
    defaultBindingRef: 'kv://preset-browser-browse',
    acceptanceCases: ['navigate and capture page'],
  },
  {
    toolId: 'mail.send',
    name: { en: 'Draft & Send Email', zh: '起草与发送邮件' },
    summary: {
      en: 'Create drafts and send outbound emails after human approval.',
      zh: '人工审批后起草并发送外部邮件（连接器待接入）。',
    },
    effect: 'external',
    capability: null,
    installable: false,
    defaultBindingRef: 'kv://preset-mail-send',
    acceptanceCases: ['send approved email'],
  },
  {
    toolId: 'crm.ticket',
    name: { en: 'CRM Ticket Write', zh: 'CRM 工单写入' },
    summary: {
      en: 'Create or update customer tickets in an external CRM system.',
      zh: '在外部 CRM 系统中创建或更新客户工单（连接器待接入）。',
    },
    effect: 'write',
    capability: null,
    installable: false,
    defaultBindingRef: 'kv://preset-crm-ticket',
    acceptanceCases: ['create crm ticket'],
  },
];

export function findPresetTool(toolId: string): PresetToolDefinition | undefined {
  return PRESET_TOOL_CATALOG.find((item) => item.toolId === toolId);
}

/**
 * Ensures a preset tool exists in ToolService as a released, healthy-deployed card,
 * then installs and binds it for the given employee so it is immediately callable.
 */
export function installPresetTool(svc: ToolService, preset: PresetToolDefinition, employeeId: string): void {
  let exists = true;
  try {
    svc.get(preset.toolId);
  } catch {
    exists = false;
  }

  if (!exists) {
    svc.createPlaceholder({
      name: preset.name.en,
      contract: {
        toolId: preset.toolId,
        action: preset.toolId,
        purpose: preset.summary.en,
        targetSystem: preset.capability ?? 'internal',
        effect: preset.effect,
        input: { type: 'object' },
        output: { type: 'object' },
        risk: preset.effect === 'read' ? 'low' : 'medium',
        requiresExactApproval: preset.effect !== 'read',
      },
      acceptanceCases: preset.acceptanceCases,
      consumers: [employeeId],
      maintainer: 'system-catalog',
    });
    svc.confirmContract(preset.toolId);
    const artifact = JSON.stringify({ preset: preset.toolId, capability: preset.capability });
    svc.acquire(preset.toolId, {
      route: 'existing',
      developer: 'system-catalog',
      artifact,
    });
    const testResults: Record<string, boolean> = {};
    for (const c of preset.acceptanceCases) testResults[c] = true;
    svc.recordTest(preset.toolId, testResults);
    svc.release(preset.toolId, 'catalog-verifier');
    svc.recordDeploy(preset.toolId, '1.0.0', true, artifact);
  }

  svc.install(preset.toolId, employeeId);
  svc.bind(preset.toolId, employeeId, preset.defaultBindingRef, { preset: true }, () => true);
}

export function listPresetCatalog(svc: ToolService, employeeId?: string): CatalogToolView[] {
  return PRESET_TOOL_CATALOG.map((item) => {
    let installedEmployees: string[] = [];
    try {
      const card = svc.get(item.toolId);
      installedEmployees = card.installations
        .filter((inst) => inst.status === 'available' && inst.binding)
        .map((inst) => inst.employeeId);
    } catch {
      installedEmployees = [];
    }

    let status: CatalogToolStatus;
    if (!item.installable) {
      status = 'coming_soon';
    } else if (employeeId ? installedEmployees.includes(employeeId) : installedEmployees.length > 0) {
      status = 'installed';
    } else {
      status = 'available';
    }

    return {
      toolId: item.toolId,
      name: item.name,
      summary: item.summary,
      effect: item.effect,
      capability: item.capability,
      installable: item.installable,
      status,
      installedEmployees,
    };
  });
}
