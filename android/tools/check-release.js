#!/usr/bin/env node
/*
 * 发布一致性检查：版本号、latest.json、APK 与校验值必须对得上。
 *
 *   node tools/check-release.js
 *
 * 检查项：
 *   1. latest.json 的 tag_name 与 build.gradle 的 versionName 一致；
 *   2. html_url 与全部资产 URL 指向公开仓库 xysy92ds/ElysiaFloat；
 *   3. 资产 URL 的 tag 与 tag_name 一致，文件名与 URL 末段一致；
 *   4. 本地 apk/ 下存在同名 APK 时，大小、SHA-256 与 release/<版本>/SHA256SUMS 一致。
 * 任何一项不符即退出码 1，可直接用于发布前 CI。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'xysy92ds/ElysiaFloat';
const BASE = 'https://github.com/' + REPO + '/releases';

function fail(msg) {
  console.error('✗ ' + msg);
  process.exitCode = 1;
}
function ok(msg) { console.log('✓ ' + msg); }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
const versionName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const versionCode = (gradle.match(/versionCode\s+(\d+)/) || [])[1];
if (!versionName) { fail('build.gradle 缺少 versionName'); process.exit(1); }

const latestPath = path.join(ROOT, 'release/latest.json');
if (!fs.existsSync(latestPath)) { fail('缺少 release/latest.json'); process.exit(1); }
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
const tag = 'v' + versionName;

if (latest.tag_name === tag) ok('tag_name 与 versionName 一致：' + tag);
else fail('tag_name=' + latest.tag_name + '，但 build.gradle 是 ' + tag);

if (latest.html_url === BASE + '/tag/' + latest.tag_name) ok('html_url 指向公开仓库');
else fail('html_url 不正确：' + latest.html_url);

const assets = Array.isArray(latest.assets) ? latest.assets : [];
if (!assets.length) fail('latest.json 没有 assets');
for (const a of assets) {
  const name = String(a.name || '');
  const url = String(a.browser_download_url || '');
  const expect = BASE + '/download/' + latest.tag_name + '/' + name;
  if (!name) { fail('资产缺少 name'); continue; }
  if (url !== expect) { fail('资产 URL 不正确：' + url + '（应为 ' + expect + '）'); continue; }
  ok('资产 URL 正确：' + name);

  const localApk = path.join(ROOT, 'apk', name);
  if (!/\.apk$/i.test(name) || !fs.existsSync(localApk)) continue;
  const size = fs.statSync(localApk).size;
  if (typeof a.size === 'number' && a.size !== size) fail(name + ' 大小不一致：latest.json ' + a.size + '，本地 ' + size);
  else if (typeof a.size === 'number') ok(name + ' 大小一致：' + size);

  const sumsPath = path.join(ROOT, 'release', latest.tag_name.replace(/^v/, ''), 'SHA256SUMS');
  if (fs.existsSync(sumsPath)) {
    const sums = fs.readFileSync(sumsPath, 'utf8');
    const digest = sha256(localApk);
    if (sums.indexOf(digest) >= 0) ok(name + ' SHA-256 与归档一致：' + digest.slice(0, 12) + '…');
    else fail(name + ' SHA-256 不在 ' + path.relative(ROOT, sumsPath) + ' 中');
  }
}

if (process.exitCode) {
  console.error('\n发布一致性检查失败');
} else {
  console.log('\n发布一致性检查通过（' + tag + ' / versionCode ' + versionCode + '）');
}
