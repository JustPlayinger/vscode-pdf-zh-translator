import { log } from '../log';
import { ProviderConfig } from './types';

/** 内置的 OpenAI 兼容端点。`custom` / `google` 不走这张表。 */
const OPENAI_COMPATIBLE_BASE_URL: Record<string, string> = {
  deepseek: 'https://api.deepseek.com/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

export function isGoogleProvider(cfg: ProviderConfig): boolean {
  return cfg.provider === 'google';
}

/** `google` 公共端点与本地 `ollama` 不强制要求 API Key。 */
export function requiresApiKey(cfg: ProviderConfig): boolean {
  return cfg.provider !== 'google' && cfg.provider !== 'ollama';
}

export function resolveBaseUrl(cfg: ProviderConfig): string {
  const base =
    cfg.provider === 'custom'
      ? cfg.baseUrl
      : OPENAI_COMPATIBLE_BASE_URL[cfg.provider] ?? cfg.baseUrl;
  return (base ?? '').trim().replace(/\/+$/, '');
}

export function endpointFor(cfg: ProviderConfig): string {
  return `${resolveBaseUrl(cfg)}/chat/completions`;
}

function googleLangCode(targetLang: string): string {
  if (/繁|traditional/i.test(targetLang)) return 'zh-TW';
  if (/^英|english/i.test(targetLang)) return 'en';
  if (/日|japan/i.test(targetLang)) return 'ja';
  if (/韩|korea/i.test(targetLang)) return 'ko';
  return 'zh-CN';
}

export interface ProviderPayload {
  /** 1 基序号 */
  index: number;
  text: string;
}

export interface ProviderResponse {
  /** 1 基序号 → 译文 */
  translations: Map<number, string>;
  promptTokens: number;
  completionTokens: number;
}

const MAX_GLOSSARY_ENTRIES = 200;

export function buildSystemPrompt(cfg: ProviderConfig): string {
  const glossaryKeys = Object.keys(cfg.glossary ?? {}).slice(0, MAX_GLOSSARY_ENTRIES);
  const glossaryBlock = glossaryKeys.length
    ? '\n\n术语对照表（必须严格遵守，左列保持原样或译为右列）：\n' +
      glossaryKeys.map((k) => `- 「${k}」 → 「${cfg.glossary[k]}」`).join('\n')
    : '';

  return [
    `你是一名专业的学术论文翻译引擎，负责把英文科技论文逐段译成${cfg.targetLang}。`,
    '',
    '严格遵守以下规则：',
    '1. 输入的每一段都以 [[序号]] 开头。输出必须保留完全相同的 [[序号]] 标记，每段一个，顺序与输入一致，不得合并或拆分段落。',
    '2. 数学公式、变量、基因名、蛋白质名、方法名、软件名、缩写词、单位、参数记号（如 H2O、pLDDT、ESM-2、PDB、kNN=5、P<0.05）一律保持原样，不翻译、不改写、不补充解释。',
    '3. 使用学术书面语，忠实原意，不增不减，不做总结、点评或延伸。',
    '4. 只输出译文本身。不要输出前言、说明、注释、Markdown 代码块围栏或额外标题。',
    '5. 若某段极短（小标题、图表标题、页眉信息），也必须给出对应的 [[序号]] 译文。',
    glossaryBlock,
  ].join('\n');
}

export function buildUserPrompt(payload: ProviderPayload[]): string {
  return payload.map((p) => `[[${p.index}]] ${p.text}`).join('\n\n');
}

/** 按 [[n]] 标记把模型输出切回“序号 → 译文”。 */
export function parseNumbered(content: string): Map<number, string> {
  const result = new Map<number, string>();
  const marks: { index: number; start: number; end: number }[] = [];
  const re = /\[\[\s*(\d+)\s*\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    marks.push({
      index: Number.parseInt(m[1], 10),
      start: m.index,
      end: re.lastIndex,
    });
  }
  for (let i = 0; i < marks.length; i += 1) {
    const current = marks[i];
    const next = marks[i + 1];
    const body = content
      .slice(current.end, next ? next.start : content.length)
      .trim();
    if (body) {
      result.set(current.index, body);
    }
  }
  return result;
}

interface AbortGuard {
  signal: AbortSignal;
  dispose: () => void;
}

/** 把外部取消信号与超时合并成一个可用的 AbortSignal（不依赖 AbortSignal.any）。 */
function abortableTimeout(timeoutMs: number, outer: AbortSignal): AbortGuard {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort(outer.reason);
  if (outer.aborted) {
    controller.abort(outer.reason);
  } else {
    outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  const timer = setTimeout(
    () => controller.abort(new Error(`请求超时（${timeoutMs} ms）`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      outer.removeEventListener('abort', onOuterAbort);
    },
  };
}

async function readErrorMessage(response: Response): Promise<string> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    /* 忽略读取失败 */
  }
  return `${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 400)}` : ''}`;
}

/** 调用 OpenAI 兼容的 `/chat/completions`。 */
export async function translateWithOpenAICompatible(
  cfg: ProviderConfig,
  apiKey: string,
  payload: ProviderPayload[],
  outerSignal: AbortSignal,
): Promise<ProviderResponse> {
  const url = endpointFor(cfg);
  if (!url.startsWith('http')) {
    throw new Error('Base URL 未配置：请设置 pdf-zh.baseUrl，或改用内置 provider。');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const userPrompt = buildUserPrompt(payload);
  const body = {
    model: cfg.model,
    temperature: 0,
    stream: false,
    messages: [
      { role: 'system', content: buildSystemPrompt(cfg) },
      { role: 'user', content: userPrompt },
    ],
  };

  const guard = abortableTimeout(cfg.timeoutMs, outerSignal);
  try {
    log(`POST ${url} model=${cfg.model} segs=${payload.length} chars=${userPrompt.length}`);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    const json = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    return {
      translations: parseNumbered(content),
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
    };
  } finally {
    guard.dispose();
  }
}

/** Google 公共端点：免 Key，逐段翻译（零配置回退用）。 */
export async function translateWithGoogle(
  cfg: ProviderConfig,
  payload: ProviderPayload[],
  outerSignal: AbortSignal,
): Promise<ProviderResponse> {
  const tl = googleLangCode(cfg.targetLang);
  const translations = new Map<number, string>();
  for (const item of payload) {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(item.text)}`;
    const guard = abortableTimeout(cfg.timeoutMs, outerSignal);
    try {
      const response = await fetch(url, { method: 'GET', signal: guard.signal });
      if (!response.ok) {
        throw new Error(await readErrorMessage(response));
      }
      const json = (await response.json()) as unknown;
      const sentences =
        Array.isArray(json) && Array.isArray(json[0]) ? (json[0] as unknown[]) : [];
      const text = sentences
        .map((s) => (Array.isArray(s) ? String(s[0] ?? '') : ''))
        .join('')
        .trim();
      if (text) {
        translations.set(item.index, text);
      }
    } finally {
      guard.dispose();
    }
  }
  return { translations, promptTokens: 0, completionTokens: 0 };
}

/** 统一入口：按 provider 选择适配器。 */
export async function translate(
  cfg: ProviderConfig,
  apiKey: string,
  payload: ProviderPayload[],
  signal: AbortSignal,
): Promise<ProviderResponse> {
  if (isGoogleProvider(cfg)) {
    return translateWithGoogle(cfg, payload, signal);
  }
  return translateWithOpenAICompatible(cfg, apiKey, payload, signal);
}
