#!/usr/bin/env node
'use strict';

// 同时修改三处版本号：package.json、remote-fileshare.js、src/remote_fileshare/__init__.py。
// 用法：node scripts/bump-version.js 1.2.0
// 提交并推送到 main 后，GitHub Actions 会自动发布到 npm 和 PyPI。
const fs = require('fs');
const path = require('path');

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?$/.test(version || '')) {
  console.error('用法：node scripts/bump-version.js <版本号>，例如 1.2.0');
  process.exit(1);
}
const root = path.join(__dirname, '..');
const edits = [
  ['package.json', /("version": ")[^"]+(")/],
  ['remote-fileshare.js', /(const VERSION = ')[^']+(')/],
  [path.join('src', 'remote_fileshare', '__init__.py'), /(__version__ = ")[^"]+(")/],
];
for (const [file, pattern] of edits) {
  const full = path.join(root, file);
  const text = fs.readFileSync(full, 'utf8');
  if (!pattern.test(text)) throw new Error(`${file} 里找不到版本号`);
  fs.writeFileSync(full, text.replace(pattern, `$1${version}$2`));
  console.log(`${file} → ${version}`);
}
console.log(`\n下一步：git commit -am "Release ${version}" && git push`);
