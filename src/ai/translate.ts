import { log } from '../log';
import { TranslationCache } from './cache';
import { requiresApiKey, resolveBaseUrl, translate as callProvider } from './providers';
import { estimateTokens, normalize, segKey } from './segment';
import { emptyUsage, ProviderConfig, SegRequest, SegResult, Usage } from './types';

export interface TranslateOptions {
  cfg: ProviderConfig;
  apiKey: string;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

interface PendingEntry {
  key: string;
  text: string;
  /** 该文本在本次请求数组中的所有下标（去重后一对多） */
  indices: number[];
}

/** 单次请求最多打包的段数，防止模型漏编号。 */
const MAX_SEGMENTS_PER_REQUEST = 40;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return '已取消';
    }
    return error.message;
  }
  return String(error);
}

/** 按字符预算把段落切成多次请求；顺带限制单次段数。 */
function chunkByChars(entries: PendingEntry[], limit: number): PendingEntry[][] {
  const chunks: PendingEntry[][] = [];
  let current: PendingEntry[] = [];
  let size = 0;
  for (const entry of entries) {
    const len = entry.text.length;
    if (current.length > 0 && (size + len > limit || current.length >= MAX_SEGMENTS_PER_REQUEST)) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += len;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/** 发请求前的配置体检，给出可操作的报错信息。 */
export function assertConfigured(cfg: ProviderConfig, apiKey: string): void {
  if (cfg.provider === 'custom' && !cfg.baseUrl.trim()) {
    throw new Error('当前 provider 为 custom，但 pdf-zh.baseUrl 为空。');
  }
  if (cfg.provider !== 'custom' && !resolveBaseUrl(cfg).startsWith('http')) {
    throw new Error(
      `无法解析 provider "${cfg.provider}" 的服务地址，请检查 pdf-zh.provider / pdf-zh.baseUrl。`,
    );
  }
  if (requiresApiKey(cfg) && !apiKey.trim()) {
    throw new Error('尚未配置 API Key。请运行命令「PDF中文: 设置 AI 翻译 API Key」。');
  }
  if (!cfg.model.trim()) {
    throw new Error('尚未配置模型。请设置 pdf-zh.model，例如 "deepseek-chat"。');
  }
}

export class Translator {
  constructor(private readonly cache: TranslationCache) {}

  /**
   * 只对「缓存未命中」的段落发起请求 —— 这是省 token 的第一道闸门。
   * 返回顺序与入参 items 严格一致。
   */
  async run(
    items: SegRequest[],
    opts: TranslateOptions,
  ): Promise<{ results: SegResult[]; usage: Usage }> {
    const cfg = opts.cfg;
    const usage = emptyUsage();
    const results: (SegResult | undefined)[] = new Array(items.length).fill(undefined);
    const pendingByKey = new Map<string, PendingEntry>();
    let processed = 0;

    // ① 查缓存 + 同批内按内容去重
    for (let i = 0; i < items.length; i += 1) {
      const text = normalize(items[i].text);
      if (!text) {
        results[i] = { k: items[i].k, text: '', hit: true };
        processed += 1;
        continue;
      }
      const key = segKey(text, cfg);
      const cached = await this.cache.get(key);
      if (cached !== undefined) {
        results[i] = { k: items[i].k, text: cached, hit: true };
        usage.cached += 1;
        usage.charsSaved += text.length;
        processed += 1;
        continue;
      }
      const existing = pendingByKey.get(key);
      if (existing) {
        existing.indices.push(i);
      } else {
        pendingByKey.set(key, { key, text, indices: [i] });
      }
    }
    usage.estTokensSaved = estimateTokens(usage.charsSaved);
    opts.onProgress?.(processed, items.length);

    // ② 组批请求
    const retryQueue: PendingEntry[] = [];
    for (const chunk of chunkByChars([...pendingByKey.values()], cfg.maxCharsPerRequest)) {
      if (opts.signal.aborted) {
        break;
      }
      await this.requestChunk(chunk, items, results, usage, opts, retryQueue);
    }

    // ③ 模型漏编号的段落单独重试一次
    if (!opts.signal.aborted && retryQueue.length > 0) {
      log(`有 ${retryQueue.length} 段未拿到译文，逐段重试`);
      for (const entry of retryQueue) {
        if (opts.signal.aborted) {
          break;
        }
        await this.requestChunk([entry], items, results, usage, opts, []);
      }
    }

    // ④ 兜底：仍未填上的标记失败（失败结果绝不写缓存，避免污染）
    for (let i = 0; i < items.length; i += 1) {
      if (!results[i]) {
        results[i] = {
          k: items[i].k,
          text: '',
          hit: false,
          error: opts.signal.aborted ? '已取消' : '未获得译文',
        };
      }
    }
    return { results: results as SegResult[], usage };
  }

  private async requestChunk(
    chunk: PendingEntry[],
    items: SegRequest[],
    results: (SegResult | undefined)[],
    usage: Usage,
    opts: TranslateOptions,
    retryQueue: PendingEntry[],
  ): Promise<void> {
    try {
      const response = await callProvider(
        opts.cfg,
        opts.apiKey,
        chunk.map((e, i) => ({ index: i + 1, text: e.text })),
        opts.signal,
      );
      usage.requested += chunk.length;
      usage.promptTokens += response.promptTokens;
      usage.completionTokens += response.completionTokens;
      for (let i = 0; i < chunk.length; i += 1) {
        const entry = chunk[i];
        const translated = response.translations.get(i + 1)?.trim();
        if (translated) {
          await this.cache.put(entry.key, entry.text, translated);
          for (const idx of entry.indices) {
            results[idx] = { k: items[idx].k, text: translated, hit: false };
          }
        } else {
          retryQueue.push(entry);
        }
      }
    } catch (error) {
      const message = errorMessage(error);
      log(`请求失败（${chunk.length} 段）：${message}`);
      for (const entry of chunk) {
        for (const idx of entry.indices) {
          results[idx] = { k: items[idx].k, text: '', hit: false, error: message };
        }
      }
    }
  }
}
