#!/usr/bin/env node
/*
 * 一次性迁移工具：把 app/src/main/assets/index.html 拆成 src/ 下的模块。
 *
 * 约束：拆分必须字节无损。做法是按行首的 banner 注释切块，
 * 再按 MODULES 映射把相邻块合成模块；拼接顺序恢复后应与原文件完全一致。
 *
 * 用法：node tools/split-html.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'app', 'src', 'main', 'assets');
const HTML = path.join(ASSETS, 'index.html');
const OUT = path.join(ASSETS, 'src');

/* 按 banner 顺序把块合进模块；数组元素为「块区间」[from, to]（含端点）。 */
const MODULES = [
  { file: '00-compat.js',          title: '兼容层、桥接与环境探测',        chunks: [0, 3] },
  { file: '01-ui-dialog.js',       title: '弹窗、头像、附件与窗口缩放',    chunks: [4, 7] },
  { file: '02-config.js',          title: '默认配置与人设/工具/上下文',    chunks: [8, 9] },
  { file: '03-state-tasks.js',     title: '状态与任务模型 v1',             chunks: [10, 12] },
  { file: '04-plugins-core.js',    title: '开放插件系统（清单与注册表）',  chunks: [13, 13] },
  { file: '05-memory.js',          title: '长期记忆库',                    chunks: [14, 14] },
  { file: '06-ui-render.js',       title: '主题、快捷操作与对话渲染',      chunks: [15, 17] },
  { file: '07-media-tts.js',       title: 'TTS、读屏与截屏',               chunks: [18, 20] },
  { file: '08-translate.js',       title: '翻译（微软与屏幕翻译）',        chunks: [21, 22] },
  { file: '09-ai-request.js',      title: 'AI 请求与工具循环',             chunks: [23, 23] },
  { file: '10-music.js',           title: '音乐模块与播放器对账',          chunks: [24, 26] },
  { file: '11-plugin-engine.js',   title: '插件执行引擎',                  chunks: [27, 27] },
  { file: '12-send-quick.js',      title: '发送与快捷操作',                chunks: [28, 29] },
  { file: '13-settings.js',        title: '设置页与插件安装',              chunks: [30, 31] },
  { file: '14-update.js',          title: '应用更新',                      chunks: [32, 32] },
  { file: '15-views.js',           title: '视图切换、音乐 UI、顶栏与输入区', chunks: [33, 37] },
  { file: '16-permission-boot.js', title: '权限引导与启动',                chunks: [38, 40] }
];

const STYLE_FILE = 'styles/main.css';
const TEMPLATE_FILE = 'template.html';
const MANIFEST_FILE = 'manifest.json';
const BASELINE_FILE = '.migration-baseline.sha256';
const STYLE_MARK = '{{STYLES}}';
const SCRIPT_MARK = '{{SCRIPTS}}';

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function bannerOffsets(text) {
  const out = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    if (/^\/\* ={10,}$/.test(line)) out.push(offset);
    offset += line.length + 1;
  }
  return out;
}

function main() {
  const source = fs.readFileSync(HTML, 'utf8');

  const ts = source.indexOf('<style>');
  const te = source.indexOf('</style>');
  const ss = source.indexOf('<script>');
  const se = source.indexOf('</script>');
  if (ts < 0 || te < 0 || ss < 0 || se < 0) {
    console.error('index.html 结构不符合预期：需要唯一的 <style> 与 <script> 块');
    process.exit(1);
  }
  if (te < ts || se < ss) {
    console.error('index.html 标签顺序异常');
    process.exit(1);
  }

  const styles = source.slice(ts + '<style>'.length, te);
  const scripts = source.slice(ss + '<script>'.length, se);
  const template = source.slice(0, ts + '<style>'.length) + STYLE_MARK
    + source.slice(te, ss + '<script>'.length) + SCRIPT_MARK
    + source.slice(se);

  const offsets = bannerOffsets(scripts);
  if (!offsets.length) { console.error('没有找到脚本 banner 注释，无法分块'); process.exit(1); }
  const bounds = [0, ...offsets, scripts.length];
  const chunks = [];
  for (let i = 0; i < bounds.length - 1; i++) chunks.push(scripts.slice(bounds[i], bounds[i + 1]));

  const manifest = { version: 1, template: TEMPLATE_FILE, styles: [STYLE_FILE], scripts: [], modules: [], sourceSha256: sha256(source) };

  fs.mkdirSync(path.join(OUT, 'styles'), { recursive: true });
  fs.mkdirSync(path.join(OUT, 'scripts'), { recursive: true });

  const used = new Set();
  for (const mod of MODULES) {
    const [from, to] = mod.chunks;
    if (from < 0 || to >= chunks.length || from > to) {
      console.error('模块块区间越界：' + mod.file + ' [' + from + ',' + to + ']');
      process.exit(1);
    }
    for (let i = from; i <= to; i++) used.add(i);
    const body = chunks.slice(from, to + 1).join('');
    const header = '/* ' + mod.title + ' */\n';
    fs.writeFileSync(path.join(OUT, 'scripts', mod.file), body, 'utf8');
    manifest.scripts.push('scripts/' + mod.file);
    manifest.modules.push({ file: mod.file, title: mod.title, chunks: [from, to], bytes: Buffer.byteLength(body) });
  }
  for (let i = 0; i < chunks.length; i++) {
    if (!used.has(i)) { console.error('有脚本块没有被任何模块覆盖：chunk ' + i); process.exit(1); }
  }

  fs.writeFileSync(path.join(OUT, TEMPLATE_FILE), template, 'utf8');
  fs.writeFileSync(path.join(OUT, STYLE_FILE), styles, 'utf8');
  fs.writeFileSync(path.join(OUT, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT, BASELINE_FILE), manifest.sourceSha256 + '\n', 'utf8');

  const total = manifest.modules.reduce((a, m) => a + m.bytes, 0);
  console.log('拆分完成：' + manifest.modules.length + ' 个脚本模块，' + Buffer.byteLength(styles) + ' 字节样式');
  console.log('脚本模块合计 ' + total + ' 字节（原始 ' + Buffer.byteLength(scripts) + ' 字节）');
  console.log('基线 SHA-256：' + manifest.sourceSha256);
  for (const m of manifest.modules) console.log('  ' + m.file.padEnd(24) + ' ' + String(m.bytes).padStart(7) + ' B  ' + m.title);
}

main();
