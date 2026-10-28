#!/usr/bin/env node
/*
 * 敏感信息扫描：发布前确认仓库里没有把 Key / Token / 私钥写进文本文件。
 *
 *   node tools/scan-secrets.js
 *
 * 只扫文本文件；跳过 .git、构建产物、依赖和工作转移包。
 * android/keystore.properties 是私有仓库有意保留的签名材料，列入白名单。
 * 命中任意规则即退出码 1。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', 'handoff', '.gradle', '.uploads', 'build']);
const SKIP_PATHS = new Set([
  'android/keystore.properties'
]);
const RULES = [
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'OpenAI 风格 Key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'AWS Access Key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/ },
  { name: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'URL 内嵌凭据', re: /https?:\/\/[^\s/:@]+:[^\s/@]{6,}@/ }
];
const TEXT_EXT = new Set(['.js', '.json', '.md', '.txt', '.html', '.css', '.kt', '.java', '.gradle', '.properties', '.yml', '.yaml', '.sh', '.xml', '.gitignore']);

const hits = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name));
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full);
    if (SKIP_PATHS.has(rel)) continue;
    if (rel.indexOf('apk/phases/') === 0) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!TEXT_EXT.has(ext) && !entry.name.startsWith('.gitignore')) continue;
    let text;
    try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const rule of RULES) {
        if (rule.re.test(lines[i])) hits.push({ rel, line: i + 1, rule: rule.name });
      }
    }
  }
}
walk(ROOT);

if (!hits.length) {
  console.log('✓ 未发现疑似敏感信息');
  process.exit(0);
}
console.error('✗ 发现 ' + hits.length + ' 处疑似敏感信息：');
for (const h of hits) console.error('  ' + h.rel + ':' + h.line + '  [' + h.rule + ']');
process.exit(1);
