import * as vscode from 'vscode';
import { API_KEY_SECRET } from './config';
import { disposeLog, log } from './log';
import { PdfCustomProvider } from './pdfProvider';
import { PdfPreview } from './pdfPreview';

const VIEW_TYPE = PdfCustomProvider.viewType;

async function resolveTargetUri(uri?: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (uri && uri.fsPath.toLowerCase().endsWith('.pdf')) {
    return uri;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: '用翻译阅读器打开',
    filters: { PDF: ['pdf'] },
  });
  return picked?.[0];
}

export function activate(context: vscode.ExtensionContext): void {
  log('扩展已激活');
  const provider = new PdfCustomProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  /** 把命令路由到“当前聚焦的翻译阅读器”，没有就直接引导用户打开一个。 */
  const withActive = async (action: (preview: PdfPreview) => Promise<void> | void) => {
    const active = provider.active;
    if (!active) {
      const choice = await vscode.window.showInformationMessage(
        '当前没有聚焦的「PDF 中文翻译阅读器」。',
        '选择一个 PDF…',
      );
      if (choice === '选择一个 PDF…') {
        await vscode.commands.executeCommand('pdf-zh.openTranslated');
      }
      return;
    }
    active.reveal();
    await action(active);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf-zh.openTranslated', async (uri?: vscode.Uri) => {
      const target = await resolveTargetUri(uri);
      if (!target) {
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
    }),

    vscode.commands.registerCommand('pdf-zh.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        title: '设置 AI 翻译 API Key',
        prompt: '密钥加密保存在 VS Code SecretStorage 中，不会写入 settings.json，也不会被提交到任何仓库。',
        placeHolder: 'sk-...',
        password: true,
        ignoreFocusOut: true,
        validateInput: (input) =>
          input.trim().length < 8 ? '看起来不像有效的 API Key' : undefined,
      });
      if (value === undefined) {
        return;
      }
      await context.secrets.store(API_KEY_SECRET, value.trim());
      vscode.window.showInformationMessage('已保存 AI 翻译 API Key。');
    }),

    vscode.commands.registerCommand('pdf-zh.translatePage', async () => {
      await withActive((preview) => preview.cmdTranslatePage());
    }),

    vscode.commands.registerCommand('pdf-zh.translateDoc', async () => {
      await withActive(async (preview) => {
        const choice = await vscode.window.showWarningMessage(
          '整篇翻译会为每一页中尚未缓存的段落发起请求，可能产生较多 token 消耗。\n' +
            '已翻译过的内容会命中本地缓存，不会重复计费。是否继续？',
          { modal: true },
          '继续翻译',
        );
        if (choice === '继续翻译') {
          await preview.cmdTranslateDoc();
        }
      });
    }),

    vscode.commands.registerCommand('pdf-zh.showOriginal', async () => {
      await withActive((preview) => preview.cmdShowOriginal());
    }),

    vscode.commands.registerCommand('pdf-zh.exportMarkdown', async () => {
      const format = await vscode.window.showQuickPick(
        [
          { label: '中英对照 Markdown', detail: '原文与译文成对输出，适合精读与核对', value: 'dual' as const },
          { label: '仅中文 Markdown', detail: '只输出译文，适合快速通读', value: 'zh' as const },
        ],
        { title: '导出格式（直接复用本地缓存，不消耗 token）' },
      );
      if (!format) {
        return;
      }
      await withActive((preview) => preview.cmdExport(format.value));
    }),

    vscode.commands.registerCommand('pdf-zh.showStats', async () => {
      await withActive((preview) => preview.cmdShowStats());
    }),

    vscode.commands.registerCommand('pdf-zh.clearCache', async () => {
      await withActive(async (preview) => {
        const scope = await vscode.window.showQuickPick(
          [
            { label: '仅清除当前文件的翻译缓存', value: 'file' as const },
            { label: '清除全部翻译缓存', value: 'all' as const },
          ],
          { title: '清除翻译缓存' },
        );
        if (!scope) {
          return;
        }
        if (scope.value === 'file') {
          await preview.cmdClearFileCache();
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          '将删除所有已缓存的译文，之后阅读任何文档都需要重新调用 API。确定吗？',
          { modal: true },
          '确定清除',
        );
        if (confirm === '确定清除') {
          await preview.cmdClearAllCache();
        }
      });
    }),
  );
}

export async function deactivate(): Promise<void> {
  disposeLog();
}
