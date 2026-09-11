import * as fsp from 'fs/promises';
import * as path from 'path';
import { log } from '../log';
import { estimateTokens } from './segment';

export interface CacheStats {
  segments: number;
  docs: number;
  hits: number;
  misses: number;
  charsSaved: number;
  estTokensSaved: number;
}

export interface DocManifest {
  size: number;
  mtime: string;
  name: string;
  /** 页号 → 该页段落键（顺序即原文顺序） */
  pages: Record<string, string[]>;
}

export interface SegFile {
  /** 原文（归一化后的形态，供导出时还原对照） */
  s: string;
  /** 译文 */
  t: string;
  ts: number;
}

interface StatsFile {
  segCount: number;
  docCount: number;
  hits: number;
  misses: number;
  charsSaved: number;
}

const EMPTY_STATS: StatsFile = {
  segCount: 0,
  docCount: 0,
  hits: 0,
  misses: 0,
  charsSaved: 0,
};

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** 这些错误码通常来自「文件被短暂持有」，重试即可，不必立刻降级。 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 原子写入：先写临时文件再 rename，避免半截 JSON 污染缓存。
 *
 * 注意：Windows 上 `rename` 覆盖已存在文件会偶发 EPERM/EACCES/EBUSY
 * （杀毒软件、Windows Search 索引器、OneDrive 同步等会短暂持有句柄）。
 * 因此这里先做几次短退避重试，仍失败才降级为直接覆盖写。
 */
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(data);
  await fsp.writeFile(tmp, payload, 'utf8');

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_CODES.has(code)) {
        log(`rename 失败（${code}），退化为直接写入`);
        break;
      }
      if (attempt === 3) {
        log(`rename 连续 ${attempt + 1} 次被拒（${code}），退化为直接写入`);
        break;
      }
      await delay(20 * (attempt + 1));
    }
  }

  await fsp.writeFile(file, payload, 'utf8');
  await fsp.rm(tmp, { force: true });
}

/**
 * 磁盘持久化翻译缓存。
 *
 * 布局（全部落在 globalStorage 或用户指定目录，**绝不写入只读的文档目录**）：
 *   meta.json                  缓存格式版本
 *   seg/<a>/<b>/<sha1>.json    {"s":原文,"t":译文,"ts":…}
 *   doc/<sha1>.json            文档清单（页 → 段落键）
 *   stats.json                 命中 / 未命中 / 节省统计
 */
export class TranslationCache {
  private readonly memory = new Map<string, SegFile>();
  private stats: StatsFile = { ...EMPTY_STATS };
  private loaded = false;
  private flushTimer?: NodeJS.Timeout;

  constructor(private readonly root: string) {}

  get rootDir(): string {
    return this.root;
  }

  private segPath(key: string): string {
    return path.join(this.root, 'seg', key.slice(0, 2), key.slice(2, 4), `${key}.json`);
  }

  private docPath(hash: string): string {
    return path.join(this.root, 'doc', `${hash}.json`);
  }

  private get statsPath(): string {
    return path.join(this.root, 'stats.json');
  }

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    await fsp.mkdir(this.root, { recursive: true });
    const metaPath = path.join(this.root, 'meta.json');
    if (!(await readJson<{ version: number }>(metaPath))) {
      await writeJsonAtomic(metaPath, { version: 1 });
    }
    this.stats = (await readJson<StatsFile>(this.statsPath)) ?? { ...EMPTY_STATS };
    log(`缓存目录：${this.root}`);
  }

  /** 命中返回译文；未命中返回 undefined（并记一次 miss）。 */
  async get(key: string): Promise<string | undefined> {
    const cached = this.memory.get(key);
    if (cached) {
      this.noteHit(cached.s.length);
      return cached.t;
    }
    const fromDisk = await readJson<SegFile>(this.segPath(key));
    if (fromDisk && typeof fromDisk.t === 'string') {
      this.memory.set(key, fromDisk);
      this.noteHit(fromDisk.s.length);
      return fromDisk.t;
    }
    this.noteMiss();
    return undefined;
  }

  /** 原文与译文成对落盘，因此导出对照 Markdown 时可以零 token 复用。 */
  async put(key: string, source: string, translation: string): Promise<void> {
    const entry: SegFile = { s: source, t: translation, ts: Date.now() };
    this.memory.set(key, entry);
    await writeJsonAtomic(this.segPath(key), entry);
    this.stats.segCount += 1;
    this.scheduleFlush();
  }

  async readSegment(key: string): Promise<SegFile | undefined> {
    const cached = this.memory.get(key);
    if (cached) {
      return cached;
    }
    const fromDisk = await readJson<SegFile>(this.segPath(key));
    if (fromDisk) {
      this.memory.set(key, fromDisk);
    }
    return fromDisk;
  }

  async getDoc(hash: string): Promise<DocManifest | undefined> {
    return readJson<DocManifest>(this.docPath(hash));
  }

  /** 记录/更新文档清单：用于“整篇导出”与“清除本文件缓存”。 */
  async putDoc(hash: string, manifest: DocManifest): Promise<void> {
    const existing = await this.getDoc(hash);
    const pages: Record<string, string[]> = { ...(existing?.pages ?? {}) };
    for (const [page, keys] of Object.entries(manifest.pages)) {
      pages[page] = keys;
    }
    await writeJsonAtomic(this.docPath(hash), {
      size: manifest.size,
      mtime: manifest.mtime,
      name: manifest.name,
      pages,
    });
    if (!existing) {
      this.stats.docCount += 1;
      this.scheduleFlush();
    }
  }

  async listDocs(): Promise<{ hash: string; manifest: DocManifest }[]> {
    const dir = path.join(this.root, 'doc');
    let names: string[];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const out: { hash: string; manifest: DocManifest }[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) {
        continue;
      }
      const manifest = await readJson<DocManifest>(path.join(dir, name));
      if (manifest) {
        out.push({ hash: name.slice(0, -'.json'.length), manifest });
      }
    }
    return out;
  }

  statsSnapshot(): CacheStats {
    return {
      segments: this.stats.segCount,
      docs: this.stats.docCount,
      hits: this.stats.hits,
      misses: this.stats.misses,
      charsSaved: this.stats.charsSaved,
      estTokensSaved: estimateTokens(this.stats.charsSaved),
    };
  }

  async clearDoc(hash: string): Promise<number> {
    const manifest = await this.getDoc(hash);
    let removed = 0;
    if (manifest) {
      for (const keys of Object.values(manifest.pages)) {
        for (const key of keys) {
          this.memory.delete(key);
          await fsp.rm(this.segPath(key), { force: true });
          removed += 1;
        }
      }
      await fsp.rm(this.docPath(hash), { force: true });
      this.stats.docCount = Math.max(0, this.stats.docCount - 1);
      this.stats.segCount = Math.max(0, this.stats.segCount - removed);
    }
    await this.flush();
    return removed;
  }

  async clearAll(): Promise<void> {
    this.memory.clear();
    await fsp.rm(path.join(this.root, 'seg'), { recursive: true, force: true });
    await fsp.rm(path.join(this.root, 'doc'), { recursive: true, force: true });
    this.stats = { ...EMPTY_STATS };
    await this.flush();
  }

  private noteHit(chars: number): void {
    this.stats.hits += 1;
    this.stats.charsSaved += chars;
    this.scheduleFlush();
  }

  private noteMiss(): void {
    this.stats.misses += 1;
    this.scheduleFlush();
  }

  /** 统计写盘做 800ms 防抖，避免翻译过程中频繁落盘。 */
  private scheduleFlush(): void {
    if (this.flushTimer) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, 800);
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    try {
      await writeJsonAtomic(this.statsPath, this.stats);
    } catch (error) {
      log(`统计写盘失败：${String(error)}`);
    }
  }
}
