import * as vscode from 'vscode';
import { ProviderConfig } from './ai/types';

export const SECTION = 'pdf-zh';

/** SecretStorage 中保存 API Key 的键名。 */
export const API_KEY_SECRET = 'pdf-zh.aiTranslation.apiKey';

export function readProviderConfig(): ProviderConfig {
  const c = vscode.workspace.getConfiguration(SECTION);
  return {
    provider: c.get<string>('provider', 'deepseek'),
    model: c.get<string>('model', 'deepseek-chat'),
    baseUrl: c.get<string>('baseUrl', ''),
    targetLang: c.get<string>('targetLang', '简体中文'),
    glossary: c.get<Record<string, string>>('glossary') ?? {},
    maxCharsPerRequest: Math.max(500, c.get<number>('maxCharsPerRequest', 6000)),
    timeoutMs: Math.max(5000, c.get<number>('timeoutMs', 120000)),
  };
}

export function readAutoTranslateOnScroll(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('autoTranslatePageOnScroll', false);
}

function readCacheDirOverride(): string {
  return (vscode.workspace.getConfiguration(SECTION).get<string>('cacheDir', '') ?? '').trim();
}

/**
 * 缓存根目录。
 * 默认落在扩展的 globalStorage —— 可写，且**绝不碰只读的文档目录**。
 */
export function resolveCacheRoot(context: vscode.ExtensionContext): string {
  const override = readCacheDirOverride();
  if (override) {
    return override;
  }
  return vscode.Uri.joinPath(context.globalStorageUri, 'translation-cache').fsPath;
}

export async function apiKeyOf(context: vscode.ExtensionContext): Promise<string> {
  return (await context.secrets.get(API_KEY_SECRET)) ?? '';
}
