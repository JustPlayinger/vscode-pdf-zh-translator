import * as crypto from 'crypto';
import { ProviderConfig } from './types';

/**
 * 提示词版本号。任何会改变译文结果的提示词调整都必须 +1，
 * 这样旧缓存会自动失效，避免“换了 prompt 却拿到旧译文”的错位。
 */
export const PROMPT_VERSION = 1;

const NBSP = /[\u00a0\u2007\u2009\u200a\u202f\u3000]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201b\u2032]/g;
const DOUBLE_QUOTES = /[\u201c\u201d\u2033]/g;

/**
 * 归一化：只做“不改变语义”的规整（空白折叠、引号统一）。
 * 刻意保持保守 —— 归一化过猛会让不同段落产生相同哈希，导致译文串味。
 */
export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(NBSP, ' ')
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

export function sha1(input: string | Buffer): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

/**
 * 段落级缓存键 —— 内容寻址，因此：
 *  1) 同一段文字出现在正文 / SI / 其它论文里，都能直接复用译文；
 *  2) 文档改名、移动、换目录都不影响命中；
 *  3) 只有 provider / model / 目标语言 / 提示词版本变化时才会失效。
 */
export function segKey(text: string, cfg: ProviderConfig): string {
  const parts = [
    normalize(text),
    cfg.provider,
    cfg.model,
    cfg.targetLang,
    String(PROMPT_VERSION),
  ];
  return sha1(parts.join('\u0001'));
}

/** 文档级标识：用文件字节哈希，所以“只读文档”内容不变即标识稳定。 */
export function fileHash(buf: Buffer): string {
  return sha1(buf);
}

/** 估算 token 数（中英混排经验值：约 3 字符 ≈ 1 token）。 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 3);
}
