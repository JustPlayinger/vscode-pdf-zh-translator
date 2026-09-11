import * as vscode from 'vscode';
import { PdfDocument } from './pdfDocument';
import { PdfPreview } from './pdfPreview';

/** 自定义编辑器 Provider：把 *.pdf 交给启用了翻译功能的 Webview 阅读器。 */
export class PdfCustomProvider
  implements vscode.CustomReadonlyEditorProvider<PdfDocument>
{
  public static readonly viewType = 'pdf-zh.preview';

  private readonly previews = new Set<PdfPreview>();
  private activePreview?: PdfPreview;

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): PdfDocument {
    return new PdfDocument(uri);
  }

  resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): void {
    const preview = new PdfPreview(this.context, document.uri, panel);
    this.previews.add(preview);

    if (panel.active) {
      this.activePreview = preview;
    }

    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activePreview = preview;
      }
    });

    panel.onDidDispose(() => {
      preview.dispose();
      this.previews.delete(preview);
      if (this.activePreview === preview) {
        this.activePreview = undefined;
      }
    });
  }

  get active(): PdfPreview | undefined {
    return this.activePreview;
  }
}
