#!/usr/bin/env node
/*
 * 插件清单校验器（E4-009 开发者工具包）
 *
 * 用法：
 *   node tools/plugin-validate.js plugin-examples/theme-aurora.json
 *   node tools/plugin-validate.js plugin-examples            # 校验目录下所有 .json
 *
 * 校验内容：清单结构、surface 是否被接受、组件类型、动作类型、主题对比度。
 * 退出码 0 = 全部通过，1 = 有错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { T } = require('./harness');

function walkTree(node, ctx, issues) {
  if (Array.isArray(node)) { node.forEach(n => walkTree(n, ctx, issues)); return; }
  if (!node || typeof node !== 'object') return;
  if (node.type) {
    if (T.PLUG_COMPONENT_TYPES.indexOf(String(node.type)) < 0) issues.push('未知组件：' + node.type);
    if (node.action) checkAction(node.action, '组件 ' + node.type, issues);
    if (node.submit) checkAction(node.submit, '表单提交', issues);
    if (node.style && T.plugStyleAttr(node.style) === '' && Object.keys(node.style).length) {
      issues.push('组件 ' + node.type + ' 的样式全部被白名单丢弃');
    }
  }
  ['children', 'body'].forEach(k => { if (node[k]) walkTree(node[k], ctx, issues); });
  if (Array.isArray(node.tabs)) node.tabs.forEach(t => walkTree(t && t.children, ctx, issues));
  if (Array.isArray(node.options)) node.options.forEach(o => {
    if (o && typeof o === 'object' && o.action) checkAction(o.action, '选项', issues);
  });
  if (Array.isArray(node.items)) node.items.forEach(it => {
    if (it && typeof it === 'object' && it.action) checkAction(it.action, '列表项', issues);
  });
}
function checkAction(a, where, issues) {
  if (!a || typeof a !== 'object') { issues.push(where + '：动作不是对象'); return; }
  if (T.PLUG_ACTION_TYPES.indexOf(String(a.type)) < 0) issues.push(where + '：未知动作 ' + a.type);
}

function validateOne(file) {
  const issues = [];
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { file, issues: ['JSON 解析失败：' + e.message] }; }
  const v2 = raw.manifestVersion === 2 || Array.isArray(raw.surfaces);
  const err = v2 ? T.plugManifestV2Error(raw) : T.plugManifestError(raw);
  if (err) issues.push(err);
  if (err) return { file, issues };
  const plugin = T.plugNormalize(raw);
  if (!plugin) return { file, issues: ['清单规整失败'] };
  const rawSurfaces = Array.isArray(raw.surfaces) ? raw.surfaces : [];
  if (v2 && plugin.surfaces.length !== rawSurfaces.length) {
    issues.push('有 ' + (rawSurfaces.length - plugin.surfaces.length) + ' 个 surface 声明无效被丢弃（检查 id/权限/命令格式）');
  }
  plugin.surfaces.forEach(s => {
    if (s.tree) walkTree(s.tree, {}, issues);
    if (s.action) checkAction(s.action, 'surface ' + s.id, issues);
    if (s.type === 'theme') {
      const c = T.plugThemeContrast(s.tokens || {});
      if (!c.ok) issues.push('主题 ' + s.id + ' 的对比度偏低（' + c.ratio + '），建议调整配色');
    }
  });
  if (!v2 && plugin.tools && plugin.tools.length && !plugin.surfaces.length) {
    if (!plugin.tools.every(t => t.name && t.code)) issues.push('v1 工具缺少 name/code');
  }
  return { file, issues, plugin };
}

function expand(input) {
  const p = path.resolve(input);
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isDirectory()) {
    return fs.readdirSync(p).filter(f => /\.json$/i.test(f)).sort().map(f => path.join(p, f));
  }
  return [p];
}

const args = process.argv.slice(2);
if (!args.length) {
  console.error('用法：node tools/plugin-validate.js <清单.json | 目录>');
  process.exit(2);
}
const files = args.reduce((a, x) => a.concat(expand(x)), []);
if (!files.length) {
  console.error('没有找到可校验的 .json 文件');
  process.exit(2);
}
let failed = 0;
files.forEach(f => {
  const r = validateOne(f);
  const name = path.relative(process.cwd(), r.file);
  if (r.issues.length) {
    failed++;
    console.log('✗ ' + name);
    r.issues.forEach(i => console.log('    - ' + i));
  } else {
    const info = r.plugin ? (r.plugin.surfaces.length ? r.plugin.surfaces.length + ' 个 surface' : (r.plugin.tools || []).length + ' 个工具') : '';
    console.log('✓ ' + name + (info ? '（' + info + '）' : ''));
  }
});
process.exit(failed ? 1 : 0);
