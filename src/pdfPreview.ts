import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DocManifest, TranslationCache } from './ai/cache';
import { fileHash, segKey } from './ai/segment';
import { assertConfigured, Translator } from './ai/translate';
import { ProviderConfig, SegRequest, SegResult, Usage } from './ai/types';
import {
  apiKeyOf,
  readAutoTranslateOnScroll,
  readOverlayConfig,
  readProviderConfig,
  resolveCacheRoot,
} from './config';
import { log, showLog } from './log';

interface IncomingRequest {
  type: 'tr:request';
  reqId: number;
  kind: 'page' | 'doc' | 'selection';
  pageNo?: number;
  items: SegRequest[];
}

type Incoming =
  | IncomingRequest
  | { type: 'tr:abort' }
  | { type: 'tr:stats' }
  | { type: 'tr:clearFile' }
  | { type: 'tr:export'; format: 'dual' | 'zh' }
  | { type: 'tr:openLog' }
  | { type: 'tr:ready' };

function escapeAttribute(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 单个 PDF 预览实例。
 *
 * 设计要点：
 *  - 文本抽取发生在 Webview（那里才有 pdf.js 的文本层），
 *    网络请求发生在扩展宿主（Node 侧）—— 因此**无需放宽 Webview 的 connect-src，
 *    且 API Key 永不进入 Webview**。
 *  - 所有译文先查磁盘缓存，只有未命中的段落才真正发请求。
 */
export class PdfPreview implements vscode.Disposable {
  private disposed = false;
  private readonly cache: TranslationCache;
  private readonly translator: Translator;
  private readonly disposables: vscode.Disposable[] = [];
  private docHash?: string;
  private abortController?: AbortController;
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly resource: vscode.Uri,
    private readonly panel: vscode.WebviewPanel,
  ) {
    this.cache = new TranslationCache(resolveCacheRoot(context));
    this.translator = new Translator(this.cache);

    const fileName = this.resource.path.replace(/\/[^/]*$/, '/');
    const resourceDir = this.resource.with({ path: fileName });

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [context.extensionUri, resourceDir],
    };
    panel.webview.html = this.getWebviewContents();

    panel.webview.onDidReceiveMessage((message: Incoming) => {
      void this.onMessage(message);
    });

    // 源文件在磁盘上被覆盖（例如重新下载同一篇论文）时自动重载，
    // 行为与原生 PDF 阅读器保持一致。
    const dirUri = this.resource.with({
      path: this.resource.path.replace(/\/[^/]*$/, ''),
    });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(dirUri, path.basename(this.resource.fsPath)),
    );
    this.disposables.push(
      watcher,
      watcher.onDidChange((uri) => {
        if (uri.toString() === this.resource.toString()) {
          void this.post({ type: 'reload' });
        }
      }),
      watcher.onDidDelete((uri) => {
        if (uri.toString() === this.resource.toString()) {
          panel.dispose();
        }
      }),
    );

    log(`打开预览：${this.resource.fsPath}`);
  }

  dispose(): void {
    this.disposed = true;
    this.abortController?.abort();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    void this.cache.flush();
  }

  private get webview(): vscode.Webview {
    return this.panel.webview;
  }

  private asset(...parts: string[]): string {
    return this.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'lib', ...parts))
      .toString();
  }

  private async post(message: unknown): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.webview.postMessage(message);
  }

  private async ensureDocHash(): Promise<string> {
    if (!this.docHash) {
      const bytes = await vscode.workspace.fs.readFile(this.resource);
      this.docHash = fileHash(Buffer.from(bytes));
    }
    return this.docHash;
  }

  /**
   * 直接读取上游 `lib/web/viewer.html` 作为模板，只做最小改写。
   * 好处：pdf.js 升级时无需同步维护一份 22KB 的 HTML 副本。
   */
  private getWebviewContents(): string {
    const templatePath = path.join(
      this.context.extensionUri.fsPath,
      'lib',
      'web',
      'viewer.html',
    );
    let html = fs.readFileSync(templatePath, 'utf8');

    const config = readProviderConfig();
    const settings = {
      fileUri: this.webview.asWebviewUri(this.resource).toString(),
      fileName: path.basename(this.resource.fsPath),
      cMapUrl: `${this.asset('web', 'cmaps')}/`,
      standardFontDataUrl: `${this.asset('web', 'standard_fonts')}/`,
      // 显式给出 worker 的绝对地址：即使 worker 脚本因任何原因没被加载，
      // pdf.js 的「假 worker」也不会再按相对路径 ../build/pdf.worker.js 去解析。
      workerSrc: this.asset('build', 'pdf.worker.js'),
      autoTranslatePageOnScroll: readAutoTranslateOnScroll(),
      overlay: readOverlayConfig(),
      provider: config.provider,
      model: config.model,
      targetLang: config.targetLang,
    };

    const csp = [
      "default-src 'none'",
      `connect-src ${this.webview.cspSource}`,
      `script-src 'unsafe-inline' ${this.webview.cspSource}`,
      `style-src 'unsafe-inline' ${this.webview.cspSource}`,
      `img-src blob: data: ${this.webview.cspSource}`,
      `font-src data: ${this.webview.cspSource}`,
    ].join('; ');

    html = html
      .replace(
        '<meta charset="utf-8">',
        [
          '<meta charset="utf-8">',
          `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
          `<meta id="pdf-zh-config" data-config="${escapeAttribute(JSON.stringify(settings))}">`,
        ].join('\n'),
      )
      .replace('href="viewer.css"', `href="${this.asset('web', 'viewer.css')}"`)
      .replace(
        'href="locale/locale.properties"',
        `href="${this.asset('web', 'locale', 'locale.properties')}"`,
      )
      // ⚠️ 必须整段替换（连同 </script>）。
      // 若只替换 src 属性，会拼出 <script src="A"><script src="B"></script>：
      // 浏览器处于 script data 状态时会把第二个 <script> 当作**第一个脚本的文本内容**，
      // 于是紧接着的 </script> 只闭合了第一个标签 —— worker 脚本从未被加载，
      // pdf.js 随之退化为「假 worker」，并用相对路径解析地址而失败。
      .replace(
        '<script src="../build/pdf.js"></script>',
        [
          `<script src="${this.asset('build', 'pdf.js')}"></script>`,
          `<script src="${this.asset('build', 'pdf.worker.js')}"></script>`,
        ].join('\n'),
      )
      .replace('src="viewer.js"', `src="${this.asset('web', 'viewer.js')}"`)
      .replace(
        '</head>',
        [
          `<link rel="stylesheet" href="${this.asset('pdf.css')}">`,
          `<script src="${this.asset('bootstrap.js')}"></script>`,
          `<script src="${this.asset('ai-translate.js')}"></script>`,
          '</head>',
        ].join('\n'),
      );

    return html;
  }

  // ───────────────────────────── 消息桥 ─────────────────────────────

  private async onMessage(message: Incoming): Promise<void> {
    switch (message.type) {
      case 'tr:ready':
        await this.post({
          type: 'ready',
          fileName: path.basename(this.resource.fsPath),
          autoTranslatePageOnScroll: readAutoTranslateOnScroll(),
        });
        break;
      case 'tr:request':
        await this.handleRequest(message);
        break;
      case 'tr:abort':
        this.abortController?.abort();
        break;
      case 'tr:stats':
        await this.sendStats();
        break;
      case 'tr:clearFile':
        await this.clearCurrentFileCache();
        break;
      case 'tr:export':
        await this.exportMarkdown(message.format);
        break;
      case 'tr:openLog':
        showLog();
        break;
      default:
        break;
    }
  }

  private async handleRequest(message: IncomingRequest): Promise<void> {
    const reqId = message.reqId;
    if (this.busy) {
      await this.post({ type: 'result', reqId, items: [], error: '上一批翻译尚未结束，请稍候。' });
      return;
    }

    const config = readProviderConfig();
    const apiKey = await apiKeyOf(this.context);
    let results: SegResult[];
    let usage: Usage;

    try {
      assertConfigured(config, apiKey);
      this.busy = true;
      this.abortController = new AbortController();
      await this.cache.init();

      const outcome = await this.translator.run(message.items, {
        cfg: config,
        apiKey,
        signal: this.abortController.signal,
        onProgress: (done, total) => {
          void this.post({ type: 'progress', reqId, done, total });
        },
      });
      results = outcome.results;
      usage = outcome.usage;

      if (
        (message.kind === 'page' || message.kind === 'doc') &&
        typeof message.pageNo === 'number'
      ) {
        await this.recordManifest(message.pageNo, message.items, config);
      }

      log(
        `reqId=${reqId} 段=${results.length} 缓存命中=${usage.cached} 新增请求=${usage.requested} ` +
          `tokens(prompt=${usage.promptTokens}, completion=${usage.completionTokens})`,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      log(`翻译失败：${text}`);
      await this.post({ type: 'result', reqId, items: [], error: text });
      return;
    } finally {
      this.busy = false;
      this.abortController = undefined;
    }

    await this.post({ type: 'result', reqId, items: results, usage });
  }

  /** 记录“文档 → 页 → 段落键”，供整篇导出与清除本文件缓存使用。 */
  private async recordManifest(
    pageNo: number,
    items: SegRequest[],
    config: ProviderConfig,
  ): Promise<void> {
    const hash = await this.ensureDocHash();
    const stat = await vscode.workspace.fs.stat(this.resource);
    const keys = items.map((item) => segKey(item.text, config));
    const manifest: DocManifest = {
      size: stat.size,
      mtime: new Date(stat.mtime).toISOString(),
      name: path.basename(this.resource.fsPath),
      pages: { [String(pageNo)]: keys },
    };
    await this.cache.putDoc(hash, manifest);
  }

  private async sendStats(): Promise<void> {
    await this.cache.init();
    await this.post({
      type: 'stats',
      stats: this.cache.statsSnapshot(),
      root: this.cache.rootDir,
    });
  }

  private async clearCurrentFileCache(): Promise<void> {
    await this.cache.init();
    const hash = await this.ensureDocHash();
    const removed = await this.cache.clearDoc(hash);
    await this.post({
      type: 'info',
      text: removed > 0 ? `已清除本文件的 ${removed} 条段落缓存。` : '本文件没有已缓存的译文。',
    });
    await this.sendStats();
  }

  // ─────────────────────────── 导出（零 token） ───────────────────────────

  private defaultExportUri(format: 'dual' | 'zh'): vscode.Uri {
    const ext = path.extname(this.resource.fsPath);
    const base = path.basename(this.resource.fsPath, ext);
    const fileName = `${base}${format === 'dual' ? '.zh-dual' : '.zh'}.md`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (folder) {
      return vscode.Uri.joinPath(folder, fileName);
    }
    return vscode.Uri.file(path.join(path.dirname(this.resource.fsPath), fileName));
  }

  /**
   * 导出完全复用磁盘缓存里的「原文 + 译文」，因此不产生任何新的 API 调用。
   */
  private async exportMarkdown(format: 'dual' | 'zh'): Promise<void> {
    await this.cache.init();
    const hash = await this.ensureDocHash();
    const manifest = await this.cache.getDoc(hash);

    if (!manifest || Object.keys(manifest.pages).length === 0) {
      await this.post({ type: 'info', text: '本文件还没有已缓存的译文，请先翻译若干页再导出。' });
      return;
    }

    const pages = Object.keys(manifest.pages)
      .map(Number)
      .sort((a, b) => a - b);

    const lines: string[] = [
      `# ${manifest.name} — ${format === 'dual' ? '中英对照' : '中文'}翻译稿`,
      '',
      '> 由 [vscode-pdf-zh-translator](https://github.com/JustPlayinger/vscode-pdf-zh-translator) 生成。',
      '> 本文件为**机器翻译参照稿**：公式、术语与专有名词可能存在偏差，引用或写作前请回到原文核对。',
      `> 生成时间：${new Date().toLocaleString('zh-CN')}　|　模式：${
        format === 'dual' ? '中英对照' : '仅中文'
      }　|　覆盖页数：${pages.length}`,
      '',
    ];

    let rendered = 0;
    for (const pageNo of pages) {
      const keys = manifest.pages[String(pageNo)] ?? [];
      const blocks: string[] = [];
      for (const key of keys) {
        const seg = await this.cache.readSegment(key);
        if (!seg || !seg.t) {
          continue;
        }
        blocks.push(format === 'dual' ? `**原文**　${seg.s}\n\n**译文**　${seg.t}` : seg.t);
      }
      if (blocks.length === 0) {
        continue;
      }
      lines.push(`## 第 ${pageNo} 页`, '', blocks.join('\n\n'), '');
      rendered += blocks.length;
    }

    if (rendered === 0) {
      await this.post({ type: 'info', text: '缓存清单还在，但段落正文已丢失。请重新翻译后再导出。' });
      return;
    }

    const target = await vscode.window.showSaveDialog({
      saveLabel: '导出',
      defaultUri: this.defaultExportUri(format),
      filters: { Markdown: ['md'] },
    });
    if (!target) {
      return;
    }

    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(lines.join('\n'), 'utf8'));
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      await this.post({ type: 'info', text: `导出失败：${text}` });
      return;
    }

    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc, { preview: false });
    await this.post({ type: 'info', text: `已导出 ${rendered} 段到 ${target.fsPath}` });
  }

  // ─────────────────── 命令入口（由 extension.ts 调用） ───────────────────

  async cmdTranslatePage(): Promise<void> {
    await this.post({ type: 'cmd', cmd: 'translate-page' });
  }

  async cmdTranslateDoc(): Promise<void> {
    await this.post({ type: 'cmd', cmd: 'translate-doc' });
  }

  async cmdShowOriginal(): Promise<void> {
    await this.post({ type: 'cmd', cmd: 'show-original' });
  }

  async cmdExport(format: 'dual' | 'zh'): Promise<void> {
    await this.exportMarkdown(format);
  }

  async cmdShowStats(): Promise<void> {
    await this.sendStats();
  }

  async cmdClearFileCache(): Promise<void> {
    await this.clearCurrentFileCache();
  }

  /** 清除全部缓存时必须经过预览实例，否则它的内存缓存仍会返回旧译文。 */
  async cmdClearAllCache(): Promise<void> {
    await this.cache.init();
    await this.cache.clearAll();
    await this.post({ type: 'cleared' });
    await this.post({ type: 'info', text: '已清除全部翻译缓存。' });
    await this.sendStats();
  }

  reveal(): void {
    this.panel.reveal();
  }
}


