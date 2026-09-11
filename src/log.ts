import type * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;
let unavailable = false;

/**
 * 延迟 require('vscode')：
 * 这样 src/ai/** 这套纯逻辑（分段 / 缓存 / Provider / 翻译编排）可以在
 * VS Code 之外被脚本或单元测试直接加载，便于离线验证。
 */
function ensureChannel(): vscode.OutputChannel | undefined {
  if (channel || unavailable) {
    return channel;
  }
  try {
    const api = require('vscode') as typeof vscode;
    channel = api.window.createOutputChannel('PDF 中文翻译');
  } catch {
    unavailable = true;
  }
  return channel;
}

/** 统一日志出口：Output 面板「PDF 中文翻译」；脱离 VS Code 时退回 stdout。 */
export function log(message: string): void {
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `[${stamp}] ${message}`;
  const target = ensureChannel();
  if (target) {
    target.appendLine(line);
  } else {
    console.log(line);
  }
}

export function showLog(): void {
  ensureChannel()?.show(true);
}

export function disposeLog(): void {
  channel?.dispose();
  channel = undefined;
  unavailable = false;
}

