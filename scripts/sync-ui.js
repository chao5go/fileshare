#!/usr/bin/env node
'use strict';

// 把 remote-fileshare.js 里的网页界面常量（UI_*）生成为 Python 版的 src/remote_fileshare/ui.py。
// 改了界面后运行：node scripts/sync-ui.js        只检查是否同步：node scripts/sync-ui.js --check
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'remote-fileshare.js'), 'utf8');
const start = source.indexOf('// ---- 网页界面：');
const end = source.indexOf('// ---- 网页界面结束 ----');
if (start < 0 || end < 0) throw new Error('找不到网页界面常量的起止标记');

const block = source.slice(start, end);
const names = [...block.matchAll(/^const (UI_[A-Z_]+) =/gm)].map(m => m[1]);
const ui = vm.runInNewContext(block + `;({${names.join(',')}})`);

let out = '# 由 scripts/sync-ui.js 从 remote-fileshare.js 自动生成，请勿手动修改。\n';
for (const name of names) out += `${name.slice(3)} = ${JSON.stringify(ui[name])}\n`;

const target = path.join(root, 'src', 'remote_fileshare', 'ui.py');
if (process.argv.includes('--check')) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  if (current !== out) { console.error('ui.py 与 remote-fileshare.js 不同步，请运行 node scripts/sync-ui.js'); process.exit(1); }
  console.log('ui.py 已同步');
} else {
  fs.writeFileSync(target, out);
  console.log(`已生成 ${path.relative(root, target)}（${names.length} 个常量）`);
}
