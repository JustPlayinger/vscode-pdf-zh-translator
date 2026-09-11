/** 运行期配置快照（由 VS Code 设置读取而来）。 */
export interface ProviderConfig {
  provider: string;
  model: string;
  baseUrl: string;
  targetLang: string;
  glossary: Record<string, string>;
  maxCharsPerRequest: number;
  timeoutMs: number;
}

/** Webview 发来的一段待翻译文本。k 为 Webview 侧的本地序号，用于回包对齐。 */
export interface SegRequest {
  k: number;
  text: string;
}

/** 回给 Webview 的一条翻译结果。 */
export interface SegResult {
  k: number;
  text: string;
  /** true = 命中本地缓存，未消耗 token。 */
  hit: boolean;
  error?: string;
}

/** 一次翻译会话的用量统计。 */
export interface Usage {
  /** 实际发起请求的段数。 */
  requested: number;
  /** 命中缓存、直接复用的段数。 */
  cached: number;
  promptTokens: number;
  completionTokens: number;
  /** 因命中缓存而省下的原文字符数。 */
  charsSaved: number;
  /** 粗略估算省下的 token（中英混排按 3 字符≈1 token）。 */
  estTokensSaved: number;
}

export function emptyUsage(): Usage {
  return {
    requested: 0,
    cached: 0,
    promptTokens: 0,
    completionTokens: 0,
    charsSaved: 0,
    estTokensSaved: 0,
  };
}
