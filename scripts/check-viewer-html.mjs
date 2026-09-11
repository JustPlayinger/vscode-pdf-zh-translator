#!/usr/bin/env node
/*
 * 校验 lib/web/viewer.html 是否仍包含 src/pdfPreview.ts 依赖的全部「替换锚点」。
 *
 * 为什么需要它：扩展不改写磁盘上的 viewer.html，而是在运行时读取它并做字符串替换。
 * 一旦 pdf.js 升级导致锚点文本变化，String.replace 会**静默不生效** —— 扩展表面能开，
 * 但样式/脚本全部指向错误路径。本脚本把这种失败前移到 CI 与本地检查。
 *
 *   node scripts/check-viewer-html.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(name, ok, extra) {
  if (ok) {
    console.log(`  \u2713 ${name}`);
  } else {
    failures += 1;
    console.log(`  \u2717 ${name}${extra ? `  \u2192 ${extra}` : ''}`);
  }
}

const viewerHtmlPath = path.join(root, 'lib', 'web', 'viewer.html');
const previewTsPath = path.join(root, 'src', 'pdfPreview.ts');

console.log('\n[1] viewer.html 替换锚点');

if (!fs.existsSync(viewerHtmlPath)) {
  console.error(`  \u2717 找不到 ${viewerHtmlPath}（请先运行 npm run sync-lib）`);
  process.exitCode = 1;
} else {
  const html = fs.readFileSync(viewerHtmlPath, 'utf8');
  const anchors = [
    '<meta charset="utf-8">',
    'href="viewer.css"',
    'href="locale/locale.properties"',
    'src="../build/pdf.js"',
    'src="viewer.js"',
    '</head>',
  ];
  for (const anchor of anchors) {
    check(`包含锚点 ${anchor}`, html.includes(anchor));
  }
  check(
    '锚点均只出现一次（避免 replace 替换错位置）',
    anchors.every((a) => html.split(a).length - 1 === 1),
    anchors.filter((a) => html.split(a).length - 1 !== 1).join(', '),
  );

  console.log('\n[2] 必需静态资源');
  const assets = [
    'lib/build/pdf.js',
    'lib/build/pdf.worker.js',
    'lib/web/viewer.html',
    'lib/web/viewer.js',
    'lib/web/viewer.css',
    'lib/web/locale/locale.properties',
    'lib/web/locale/zh-CN/viewer.properties',
    'lib/pdf.css',
    'lib/bootstrap.js',
    'lib/ai-translate.js',
    'lib/LICENSE',
    'lib/web/standard_fonts/LICENSE_FOXIT',
    'lib/web/standard_fonts/LICENSE_LIBERATION',
  ];
  for (const rel of assets) {
    check(rel, fs.existsSync(path.join(root, rel)));
  }
  check('lib/web/cmaps 目录存在', fs.existsSync(path.join(root, 'lib/web/cmaps')));
  check('lib/web/images 目录存在', fs.existsSync(path.join(root, 'lib/web/images')));

  console.log('\n[3] 与 src/pdfPreview.ts 的一致性');
  if (fs.existsSync(previewTsPath)) {
    const ts = fs.readFileSync(previewTsPath, 'utf8');
    for (const fragment of [
      'href="viewer.css"',
      'href="locale/locale.properties"',
      // 必须整段替换（含闭合标签），这里同步校验 pdfPreview.ts 用的是完整锚点
      'src="../build/pdf.js"></script>',
      // worker 资源确实被引用；它是否被装配成**独立标签**由下方结构断言保证
      "'build', 'pdf.worker.js'",
      'src="viewer.js"',
      "'</head>'",
    ]) {
      check(`pdfPreview.ts 中仍引用 ${fragment}`, ts.includes(fragment));
    }
  } else {
    check('找到 src/pdfPreview.ts', false);
  }
}

console.log('\n[4] 模拟 HTML 装配流程');
if (fs.existsSync(viewerHtmlPath)) {
  const html = fs.readFileSync(viewerHtmlPath, 'utf8');
  // 与 src/pdfPreview.ts 的 getWebviewContents() 保持同一套替换顺序
  const u = (p) => `https://example.invalid/${p}`;
  const assembled = html
    .replace(
      '<meta charset="utf-8">',
      ['<meta charset="utf-8">', '<meta id="pdf-zh-config" data-config="{}">'].join('\n'),
    )
    .replace('href="viewer.css"', `href="${u('lib/web/viewer.css')}"`)
    .replace(
      'href="locale/locale.properties"',
      `href="${u('lib/web/locale/locale.properties')}"`,
    )
    .replace(
      '<script src="../build/pdf.js"></script>',
      [
        `<script src="${u('lib/build/pdf.js')}"></script>`,
        `<script src="${u('lib/build/pdf.worker.js')}"></script>`,
      ].join('\n'),
    )
    .replace('src="viewer.js"', `src="${u('lib/web/viewer.js')}"`)
    .replace(
      '</head>',
      [
        `<link rel="stylesheet" href="${u('lib/pdf.css')}">`,
        `<script src="${u('lib/bootstrap.js')}"></script>`,
        `<script src="${u('lib/ai-translate.js')}"></script>`,
        '</head>',
      ].join('\n'),
    );

  check('viewer.css 已重写', assembled.includes(`href="${u('lib/web/viewer.css')}"`));
  check(
    'locale.properties 已重写',
    assembled.includes(`href="${u('lib/web/locale/locale.properties')}"`),
  );
  check('pdf.js 已重写', assembled.includes(`src="${u('lib/build/pdf.js')}"`));
  check('pdf.worker.js 已注入', assembled.includes(`src="${u('lib/build/pdf.worker.js')}"`));
  check('viewer.js 已重写', assembled.includes(`src="${u('lib/web/viewer.js')}"`));
  check('pdf-zh-config 已注入', assembled.includes('id="pdf-zh-config"'));
  check('bootstrap.js 已注入', assembled.includes(`src="${u('lib/bootstrap.js')}"`));
  check('ai-translate.js 已注入', assembled.includes(`src="${u('lib/ai-translate.js')}"`));

  const order = [
    u('lib/build/pdf.js'),
    u('lib/build/pdf.worker.js'),
    u('lib/web/viewer.js'),
    u('lib/bootstrap.js'),
    u('lib/ai-translate.js'),
  ].map((s) => assembled.indexOf(s));
  check(
    '脚本加载顺序正确（pdf.js → worker → viewer → bootstrap → ui）',
    order.every((value, i) => value >= 0 && (i === 0 || value > order[i - 1])),
    order.join(','),
  );
  check(
    '不再残留相对资源路径',
    !/href="viewer\.css"|src="viewer\.js"|src="\.\.\/build\/pdf\.js"/.test(assembled),
  );
  check('head 闭合且唯一', assembled.split('</head>').length - 1 === 1);

  // ── 结构合法性（这一组断言的存在原因见下方注释） ──────────────
  // 曾经出过的事故：只替换了 src 属性而没替换 </script>，拼出
  //   <script src="A"><script src="B"></script>
  // 浏览器在 script data 状态下会把第二个 <script> 当成第一个脚本的**文本内容**，
  // 于是 worker 脚本从未被加载，pdf.js 退化为「假 worker」并按相对路径
  // ../build/pdf.worker.js 解析，最终 404（Setting up fake worker failed）。
  // 只检查子串是否存在是发现不了这种问题的，必须检查标签结构。
  const openCount = (assembled.match(/<script\b/gi) || []).length;
  const closeCount = (assembled.match(/<\/script>/gi) || []).length;
  check(
    '<script 与 </script> 数量一致',
    openCount === closeCount,
    `open=${openCount} close=${closeCount}`,
  );

  const merged = (() => {
    const openRe = /<script\b/gi;
    let match;
    while ((match = openRe.exec(assembled)) !== null) {
      const closeIdx = assembled.indexOf('</script>', match.index);
      if (closeIdx === -1) {
        return { index: match.index, reason: '脚本标签缺少 </script>' };
      }
      const between = assembled.slice(match.index + 7, closeIdx);
      if (/<script\b/i.test(between)) {
        return {
          index: match.index,
          reason: '闭合前又出现 <script，会被当作脚本文本吞掉',
        };
      }
      openRe.lastIndex = closeIdx + '</script>'.length;
    }
    return null;
  })();
  check(
    'script 标签结构合法（没有被吞并的嵌套）',
    merged === null,
    merged ? `位置 ${merged.index}：${merged.reason}` : '',
  );
  check(
    'pdf.worker.js 是**独立**的 script 标签',
    new RegExp(`<script src="[^"]*pdf\\.worker\\.js"></script>`).test(assembled),
  );
  check(
    'pdf.js 标签自身是闭合的',
    new RegExp(`<script src="[^"]*build/pdf\\.js"></script>`).test(assembled),
  );
  check('装配后共 5 个脚本标签', openCount === 5, `open=${openCount}`);
}

console.log('\n[5] Webview 脚本语法检查');
const vm = await import('node:vm');
for (const rel of ['lib/bootstrap.js', 'lib/ai-translate.js']) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    check(rel, false, '文件不存在');
    continue;
  }
  try {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: rel });
    check(`${rel} 语法正确`, true);
  } catch (error) {
    check(`${rel} 语法正确`, false, error.message);
  }
}

console.log(
  failures === 0 ? '\n校验通过 \u2713\n' : `\n有 ${failures} 项未通过 \u2717\n`,
);
process.exitCode = failures === 0 ? 0 : 1;

