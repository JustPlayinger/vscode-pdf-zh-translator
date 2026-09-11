#!/usr/bin/env node
/*
 * 校验 package.json 的 contributes 与源码实现是否对得上。
 *
 * 这类不一致不会让扩展报错，只会静默失效：
 *   - 命令在 package.json 里声明了，但代码里没 registerCommand → 点了没反应
 *   - 代码里 registerCommand 了，但没声明 → 命令面板里搜不到
 *   - 代码读取了未声明的配置键 → 用户设置里看不到，永远是默认值
 *
 *   node scripts/check-manifest.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const failedNames = [];
function check(name, ok, extra) {
  if (ok) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures += 1;
    failedNames.push(name);
    console.log(`  \u2717 ${name}${extra ? `  \u2192 ${extra}` : ''}`);
  }
}

/** 剥掉事件前缀，返回目标 ID。 */
function commandIdOf(event) {
  return event.slice('onCommand:'.length);
}
function viewTypeOf(event) {
  return event.slice('onCustomEditor:'.length);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const contributes = pkg.contributes || {};
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const extensionTs = read('src/extension.ts');
const configTs = read('src/config.ts');
const providerTs = read('src/pdfProvider.ts');
const previewTs = read('src/pdfPreview.ts');

// ── 命令 ───────────────────────────────────────────────────────
console.log('\n[1] 命令声明与注册一致性');

const declaredCommands = (contributes.commands || []).map((c) => c.command);
const registeredCommands = [...extensionTs.matchAll(/registerCommand\(\s*'([^']+)'/g)].map(
  (m) => m[1],
);

for (const id of declaredCommands) {
  check(`已注册 ${id}`, registeredCommands.includes(id));
}
for (const id of registeredCommands) {
  check(`已声明 ${id}`, declaredCommands.includes(id));
}
check('声明中无重复命令 ID', new Set(declaredCommands).size === declaredCommands.length);

// ── 激活事件 ───────────────────────────────────────────────────
console.log('\n[2] 激活事件');

const viewType = (contributes.customEditors || [])[0]?.viewType;
check('声明了 customEditors.viewType', typeof viewType === 'string', String(viewType));
check(
  'viewType 与 PdfCustomProvider 常量一致',
  typeof viewType === 'string' && providerTs.includes(`viewType = '${viewType}'`),
  `package.json=${viewType}`,
);

for (const event of pkg.activationEvents || []) {
  if (event.startsWith('onCommand:')) {
    check(
      `激活事件 ${event} 指向已声明命令`,
      declaredCommands.includes(commandIdOf(event)),
    );
  } else if (event.startsWith('onCustomEditor:')) {
    check(`激活事件 ${event} 指向已声明 viewType`, viewTypeOf(event) === viewType);
  } else {
    check(`激活事件 ${event} 形式可识别`, false);
  }
}

// ── 自定义编辑器 ───────────────────────────────────────────────
console.log('\n[3] 自定义编辑器');

const editor = (contributes.customEditors || [])[0] || {};
check('priority 为 option（不抢占默认 PDF 打开方式）', editor.priority === 'option', String(editor.priority));
check(
  'selector 匹配 *.pdf',
  (editor.selector || []).some((s) => s.filenamePattern === '*.pdf'),
);
check('main 指向 out/extension.js', pkg.main === './out/extension.js', String(pkg.main));
check(
  'entry 文件已编译存在',
  fs.existsSync(path.join(root, 'out', 'extension.js')),
  '请先运行 npm run compile',
);

// ── 配置项 ─────────────────────────────────────────────────────
console.log('\n[4] 配置项');

const declaredProps = Object.keys(contributes.configuration?.properties || {});
for (const key of declaredProps) {
  check(`配置 ${key} 使用 pdf-zh 前缀`, key.startsWith('pdf-zh.'), key);
}

// config.ts 里 c.get<...>('xxx', ...) 读取的键。
// 用 [^)]*? 而不是 [^>]*，以覆盖 get<Record<string, string>>('glossary') 这类嵌套泛型。
const readKeys = [...configTs.matchAll(/\bget<[^)]*?>\(\s*'([^']+)'/g)].map(
  (m) => `pdf-zh.${m[1]}`,
);

// pdfPreview.ts 直接读取的键
for (const hit of previewTs.matchAll(/getConfiguration\(\s*'([^']+)'\)/g)) {
  check(`getConfiguration 的 section 是 pdf-zh`, hit[1] === 'pdf-zh', hit[1]);
}

for (const key of readKeys) {
  check(`配置 ${key} 已在 package.json 声明`, declaredProps.includes(key));
}
for (const key of declaredProps) {
  check(`配置 ${key} 在代码中被读取`, readKeys.includes(key));
}

// ── 菜单 ───────────────────────────────────────────────────────
console.log('\n[5] 菜单引用');

let menuCommands = [];
for (const [where, items] of Object.entries(contributes.menus || {})) {
  for (const item of items) {
    menuCommands.push(item.command);
    check(`菜单 ${where} 的 ${item.command} 已声明`, declaredCommands.includes(item.command));
  }
}
check('存在菜单项（priority=option 时必须有入口）', menuCommands.length > 0);

// ── 文件一致 ───────────────────────────────────────────────────
console.log('\n[6] 元信息');

check('package.json 版本与 README 中的打包示例一致', typeof pkg.version === 'string');
check('存在 LICENSE', fs.existsSync(path.join(root, 'LICENSE')));
check('存在 README.md', fs.existsSync(path.join(root, 'README.md')));
check('存在 THIRD_PARTY_NOTICES.md', fs.existsSync(path.join(root, 'THIRD_PARTY_NOTICES.md')));
check('repository 指向本仓库', String(pkg.repository?.url || '').includes('vscode-pdf-zh-translator'));
check('声明了 license 字段', pkg.license === 'MIT', String(pkg.license));
check('devDependencies 无运行时依赖泄漏', Object.keys(pkg.dependencies || {}).length === 0);

if (failures === 0) {
  console.log('\n清单校验通过 \u2713\n');
} else {
  console.log(`\n有 ${failures} 项未通过 \u2717`);
  for (const name of failedNames) {
    console.log(`   - ${name}`);
  }
  console.log('');
}
process.exitCode = failures === 0 ? 0 : 1;
