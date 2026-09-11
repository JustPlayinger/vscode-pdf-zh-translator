import * as vscode from 'vscode';

/**
 * 供 CustomEditorProvider 使用的文档对象。
 * 本扩展是**只读**编辑器：绝不回写用户的 PDF。
 */
export class PdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}

  dispose(): void {
    // 无需要释放的资源
  }
}
