#!/usr/bin/env node
/*
 * 把 assets/src/ 下的模块拼回 assets/index.html。
 *
 * 运行期产物仍然是单个 index.html，WebView 加载方式不变。
 * 用法：
 *   node tools/build-html.js                 构建
 *   node tools/build-html.js --check         只校验当前 index.html 是否与模块一致（CI 用）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const SRC = path.join(ASSETS, 'src');
const OUT = path.join(ASSETS, 'index.html');

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function read(rel) {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

function replaceOnce(text, mark, value) {
  const first = text.indexOf(mark);
  if (first < 0) throw new Error('模板缺少占位符 ' + mark);
  if (text.indexOf(mark, first + mark.length) >= 0) throw new Error('模板中占位符 ' + mark + ' 出现多次');
  // 必须用函数替换：字符串替换会把内容里的 $$ / $& / $' 当成替换模式，
  // 曾经因此把 `const $$ = ...` 静默改成 `const $ = ...`。
  return text.slice(0, first) + value + text.slice(first + mark.length);
}

function build() {
  const manifest = JSON.parse(read('manifest.json'));
  const template = read(manifest.template);
  const styles = manifest.styles.map(read).join('');
  const scripts = manifest.scripts.map(read).join('');
  const html = replaceOnce(replaceOnce(template, '{{STYLES}}', styles), '{{SCRIPTS}}', scripts);
  if (html.indexOf('{{STYLES}}') >= 0 || html.indexOf('{{SCRIPTS}}') >= 0) {
    throw new Error('拼接结果仍含占位符，聚合结果不可信');
  }
  return { html, manifest };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const { html, manifest } = build();
  const digest = sha256(html);

  if (checkOnly) {
    const current = fs.readFileSync(OUT, 'utf8');
    if (sha256(current) !== digest) {
      console.error('index.html 与 src/ 模块不一致，请运行：node tools/build-html.js');
      process.exit(1);
    }
    console.log('index.html 与模块一致（' + digest.slice(0, 12) + '…）');
    return;
  }

  fs.writeFileSync(OUT, html, 'utf8');
  console.log('已生成 ' + path.relative(ROOT, OUT) + '：' + Buffer.byteLength(html) + ' 字节，'
    + manifest.scripts.length + ' 个脚本模块，SHA-256 ' + digest.slice(0, 12) + '…');
}

try { main(); } catch (e) { console.error('构建失败：' + (e && e.message ? e.message : e)); process.exit(1); }
