#!/usr/bin/env node
// 生成 js/version.js（构建元数据：版本 / 作者 / commit / 构建时间）。
//
// 用法：node tools/build-meta.mjs [--version v1.4.8]
//   - 版本默认取 README「版本历史」表里最大的 vMAJOR.MINOR.PATCH（语义化，逐段比较；
//     带 -rc1 这类预发布后缀的行不参与取值）；
//   - commit 取当前 HEAD 短哈希（工作区有未提交改动时加 *，一眼看出不是干净构建）；
//   - 作者取 HEAD 提交的作者名（git config 里没配时回退 user.name）；
//   - 时间取本机当前时间。
//
// 产物会被 index.html 旁边的 sw.js 缓存，所以改完要一起提交、一起部署。

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cmd, fallback = '') => {
  try { return execSync(cmd, { cwd: root, encoding: 'utf8' }).trim() || fallback; }
  catch (_) { return fallback; }
};

// 版本：命令行优先，否则 README 版本表里最大的 vMAJOR.MINOR.PATCH
let version = '';
const argI = process.argv.indexOf('--version');
if (argI > 0 && process.argv[argI + 1]) version = process.argv[argI + 1];
if (!version) {
  const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
  let best = null;
  // 只认三段式正式版本；v1.4.1-rc1 这类预发布行不参与（其后紧跟 - 而非空格）
  for (const m of readme.matchAll(/^\|\s*v(\d+)\.(\d+)\.(\d+)\s*\|/gm)) {
    const cur = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best) { best = cur; continue; }
    const d = cur[0] - best[0] || cur[1] - best[1] || cur[2] - best[2];
    if (d > 0) best = cur;
  }
  version = best ? 'v' + best.join('.') : 'dev';
}

const commit = git('git rev-parse --short HEAD', 'unknown')
  // 生成的 version.js 自己会让工作区变脏，判断「是否有未提交改动」时要排除它，
  // 否则每次构建都会带一个 * 号。
  + (git('git status --porcelain -- . ":(exclude)js/version.js"') ? '*' : '');
const author = git('git log -1 --format=%an', '') || git('git config user.name', 'unknown');
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const buildTime = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;

const out = `// 构建元数据 —— 由 tools/build-meta.mjs 生成，请勿手改。
// 发布前跑一次：node tools/build-meta.mjs
export const VERSION = ${JSON.stringify(version)};
export const COMMIT = ${JSON.stringify(commit)};
export const BUILD_TIME = ${JSON.stringify(buildTime)};
export const AUTHOR = ${JSON.stringify(author)};
`;

writeFileSync(resolve(root, 'js/version.js'), out, 'utf8');
console.log(`js/version.js  ${version} · ${commit} · ${buildTime} · ${author}`);
