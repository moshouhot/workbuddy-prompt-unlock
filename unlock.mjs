#!/usr/bin/env node
/**
 * WorkBuddy Prompt Unlock (wb-prompt-unlock)
 *
 * 直接修改 WorkBuddy 桌面客户端在磁盘上「解包」的系统提示词模板，
 * 解除客户端侧的提示词/拒答/行为限制。不触碰 app.asar 本体，无需 repack，
 * 因此不会出现第三方 Patcher 那种「打包失败导致客户端打不开」的问题。
 *
 * 覆盖两个位置：
 *   1. <安装目录>/resources/app.asar.unpacked/resources/templates/*.tpl
 *   2. <安装目录>/.../plugins/workbuddy-builtin/welcomemode/{code,work,design}/prompt.tpl
 *   3. ~/.workbuddy/plugins/cache/workbuddy-builtin/welcomemode-<mode>/<version>/prompt.tpl
 *      （插件缓存副本 —— 这一份才是真正被 include 进 agent 提示词的，必须一起改）
 *
 * 用法:
 *   node unlock.mjs list                 # 查看可修改的模板及现状
 *   node unlock.mjs apply                # 只解除 content_policy（最小改动）
 *   node unlock.mjs apply --full         # content_policy + 文件安全段 + Windows 段 + Ask 模式可写
 *   node unlock.mjs apply --dry-run      # 只预览，不写入
 *   node unlock.mjs verify               # 校验当前状态
 *   node unlock.mjs restore              # 还原到最近一次备份
 *   node unlock.mjs restore --backup=ID  # 还原到指定备份
 *
 * 修改前请完全退出 WorkBuddy（含托盘图标）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUP_ROOT = process.env.WORKBUDDY_BACKUP_DIR || path.join(__dirname, 'backup');
const HOME = os.homedir();
const CONFIG_DIR = process.env.WORKBUDDY_CONFIG_DIR || path.join(HOME, '.workbuddy');

/**
 * 每个安装对应的用户配置目录。WorkBuddy 与 WorkBuddyAI 各自使用一套
 * 独立配置（~/.workbuddy、~/.workbuddy-ai）；插件缓存和 CLI 缓存都是
 * 按配置目录分开存放的独立副本，必须单独同步。
 *
 * 顺序：显式 --config 最高；否则按上表配对；未知安装回落到 CONFIG_DIR。
 */
function configDirForRoot(root) {
  if (process.env.WORKBUDDY_CONFIG_DIR) return process.env.WORKBUDDY_CONFIG_DIR;
  const name = path.basename(path.resolve(root)).toLowerCase();
  if (name === 'workbuddy') return path.join(HOME, '.workbuddy');
  if (name === 'workbuddyai') return path.join(HOME, '.workbuddy-ai');
  return CONFIG_DIR;
}

/** 所有可能出现且实际存在的配置目录（用于 status 展示与多目录发现）。 */
function configDirsForRoots(roots) {
  if (process.env.WORKBUDDY_CONFIG_DIR) return [process.env.WORKBUDDY_CONFIG_DIR];
  const out = [];
  for (const root of roots) {
    const d = configDirForRoot(root);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------- 替换文本（从 prompts/ 读取）

const PROMPTS_DIR = process.env.WORKBUDDY_PROMPTS_DIR || path.join(__dirname, 'prompts');

/**
 * 读取 prompts/ 下的替换文本。
 * 文件可用 LF 或 CRLF 保存；写入目标模板时再按该模板原本的换行风格转换。
 */
function loadPrompt(name) {
  const p = path.join(PROMPTS_DIR, name);
  if (!fs.existsSync(p)) {
    throw new Error(`缺少提示词文件: prompts/${name}\n请确认 prompts/ 目录完整（参见 prompts/README.md）`);
  }
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

const MODERN_POLICY              = loadPrompt('content_policy.craft-expert.txt');
const LEGACY_POLICY              = loadPrompt('content_policy.ask-legacy.txt');
const CLI_POLICY                 = loadPrompt('content_policy.cli.txt');
const PERSONAL_FILES_SAFETY      = loadPrompt('personal_files_safety.txt');
const WINDOWS_COMMAND_SAFETY     = loadPrompt('windows_command_safety.txt');
const ASK_MODE_UNLOCKED          = loadPrompt('ask_mode.current_mode.txt');
const ASK_MODE_REMINDER_UNLOCKED = loadPrompt('ask_mode.reminder.txt');
const CLI_SECURITY_OLD           = loadPrompt('cli_security_note.old.txt');
const CLI_SECURITY_NEW           = loadPrompt('cli_security_note.new.txt');
const USER_CUSTOM_OLD            = loadPrompt('user_custom.old.txt');
const USER_CUSTOM_NEW            = loadPrompt('user_custom.new.txt');

// ---------------------------------------------------------------- 目标发现

function detectRoots() {
  const candidates = [];
  if (process.env.WORKBUDDY_ROOT) return [path.resolve(process.env.WORKBUDDY_ROOT)].filter((c) =>
    fs.existsSync(path.join(c, 'resources', 'app.asar.unpacked', 'resources')));
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    for (const name of ['WorkBuddy', 'WorkBuddyAI']) {
      candidates.push(path.join(drive + path.sep, 'Program Files', name));
      candidates.push(path.join(drive + path.sep, name));
    }
  }
  const roots = [];
  for (const c of candidates) {
    const dir = path.join(c, 'resources', 'app.asar.unpacked', 'resources');
    if (fs.existsSync(dir) && !roots.includes(c)) roots.push(c);
  }
  return roots;
}

function collectTargets(root) {
  const base = path.join(root, 'resources', 'app.asar.unpacked', 'resources');
  const targets = [];

  const tplDir = path.join(base, 'templates');
  if (fs.existsSync(tplDir)) {
    for (const f of fs.readdirSync(tplDir).filter((f) => f.endsWith('.tpl')).sort()) {
      targets.push(path.join(tplDir, f));
    }
  }

  const welcome = path.join(base, 'plugins', 'workbuddy-builtin', 'welcomemode');
  if (fs.existsSync(welcome)) {
    for (const d of fs.readdirSync(welcome).sort()) {
      const p = path.join(welcome, d, 'prompt.tpl');
      if (fs.existsSync(p)) targets.push(p);
    }
  }
  return targets;
}

/** CLI 的 product.json（内含 123 个基座提示词模板）。collectCliCacheTargets。 */
function collectCliTargets(root) {
  const base = path.join(root, 'resources', 'app.asar.unpacked', 'cli');
  const out = [];
  const p = path.join(base, 'product.json');
  if (fs.existsSync(p)) out.push(p);
  return out;
}

/** 每个配置目录下的 CLI 运行时缓存（服务端下发配置的本地副本）。 */
function collectCliCacheTargets(configDir) {
  const cache = path.join(configDir, 'cache', 'acc-product-config-v3.json');
  return fs.existsSync(cache) ? [cache] : [];
}

/** 处理 product.json / acc-product-config-v3.json 里的 prompts[].template。 */
function planForJson(file, opts) {
  const raw = fs.readFileSync(file, 'utf8');
  let data;
  try { data = JSON.parse(raw); } catch { return { raw, text: raw, actions: [] }; }
  if (!Array.isArray(data.prompts)) return { raw, text: raw, actions: [] };

  const actions = [];
  let touched = 0;
  for (const item of data.prompts) {
    if (typeof item.template !== 'string') continue;
    let t = item.template;
    const orig = t;

    if (t.includes('<content_policy>')) {
      t = t.replace(/<content_policy>[\s\S]*?<\/content_policy>/, () => CLI_POLICY);
      actions.push(`prompts.${item.name}.content_policy`);
    }
    t = replaceKnownText(t, CLI_SECURITY_OLD, CLI_SECURITY_NEW,
      opts.previousPrompts?.['cli_security_note.new.txt'],
      opts.strictPairs && (/cli-agent-prompt/.test(item.name || '') || /Treat security tooling/.test(orig)));
    if (t !== orig) actions.push(`prompts.${item.name}.security_note / policy`);
    // Ask/只读硬限制类模板
    if (opts.full && /<ask_mode>[\s\S]*?<\/ask_mode>/.test(t)) {
      t = t.replace(/<ask_mode>[\s\S]*?<\/ask_mode>/, () => ASK_MODE_REMINDER_UNLOCKED);
      actions.push(`prompts.${item.name}.ask_mode`);
    }

    if (t !== orig) { item.template = t; touched++; }
  }

  if (!touched) return { raw, text: raw, actions: [] };

  // 保留原缩进风格：product.json 是 2 空格缩进
  const nl = newlineOf(raw);
  let text = JSON.stringify(data, null, 2) + '\n';
  text = toNL(text, nl);
  return { raw, text, actions };
}

/** 插件缓存中的 welcomemode 提示词副本（实际被 include 的那个）。 */
function collectCacheTargets(configDir = CONFIG_DIR) {
  const cacheRoot = path.join(configDir, 'plugins', 'cache', 'workbuddy-builtin');
  const targets = [];
  if (!fs.existsSync(cacheRoot)) return targets;
  for (const dir of fs.readdirSync(cacheRoot).sort()) {
    if (!dir.startsWith('welcomemode-')) continue;
    const d = path.join(cacheRoot, dir);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const ver of fs.readdirSync(d).sort()) {
      const p = path.join(d, ver, 'prompt.tpl');
      if (fs.existsSync(p)) targets.push(p);
    }
  }
  return targets;
}

// ---------------------------------------------------------------- 工具

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const newlineOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toNL = (s, nl) => s.replace(/\r?\n/g, nl);
const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');

function wbRunning() {
  let n = 0;
  for (const exe of ['WorkBuddy.exe', 'WorkBuddyAI.exe']) {
    try {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exe}" /NH`, {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      n += (out.match(new RegExp(exe.replace('.', '\\.'), 'gi')) || []).length;
    } catch { /* tasklist unavailable */ }
  }
  return n;
}

// ---------------------------------------------------------------- 补丁逻辑

function replaceSection(text, tag, replacement) {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  if (!re.test(text)) return { text, changed: false };
  return { text: text.replace(re, () => toNL(replacement, newlineOf(text))), changed: true };
}

function replaceKnownText(text, oldText, newText, previous, required = false) {
  for (const body of [oldText, ...(Array.isArray(previous) ? previous : [previous]), newText]) {
    if (!body) continue;
    const candidate = toNL(body, newlineOf(text));
    if (text.includes(candidate)) return text.replace(candidate, () => toNL(newText, newlineOf(text)));
  }
  if (required) throw new Error('说明段无法匹配：缺少上次提示词历史，或此客户端版本不受支持；未写入任何文件。');
  return text;
}

function planFor(file, opts) {
  const raw = fs.readFileSync(file, 'utf8');
  let text = raw;
  const actions = [];
  const isAskTemplate = /(^|[\\/])workbuddy-ask.*\.tpl$/.test(file);

  // 1) content_policy —— 核心解锁
  const policyRe = /<content_policy>([\s\S]*?)<\/content_policy>/;
  const m = text.match(policyRe);
  if (m) {
    const isLegacy = isAskTemplate || /politically sensitive topics/.test(m[1]) || /For suspicious requests/.test(m[1]);
    text = text.replace(policyRe, () => toNL(isLegacy ? LEGACY_POLICY : MODERN_POLICY, newlineOf(text)));
    actions.push(isLegacy ? 'content_policy(ask/legacy -> unlocked)' : 'content_policy(craft/expert -> unlocked)');
  }

  if (opts.full) {
    // 2) 文件安全段：保留真正危险的红线，去掉「只准扫描不准动手」这类阻塞
    for (const [tag, body] of [
      ['personal_files_safety', PERSONAL_FILES_SAFETY],
      ['windows_command_safety', WINDOWS_COMMAND_SAFETY],
    ]) {
      const r = replaceSection(text, tag, body);
      if (r.changed && r.text !== text) { text = r.text; actions.push(`${tag} 放宽`); }
    }

    // 3) Ask 模式：解除只读硬限制
    if (isAskTemplate || /(^|[\\/])ask-mode-reminder\.tpl$/.test(file)) {
      const r = replaceSection(text, 'current_mode', ASK_MODE_UNLOCKED);
      if (r.changed && r.text !== text) { text = r.text; actions.push('Ask 模式 -> 可写'); }
    }
    if (/(^|[\\/])ask-mode-reminder\.tpl$/.test(file) && /<ask_mode>/.test(text)) {
      const nl = newlineOf(text);
      text = text.replace(
        /<ask_mode>[\s\S]*?<\/ask_mode>/,
        () => toNL(ASK_MODE_REMINDER_UNLOCKED, nl)
      );
      actions.push('ask_mode reminder -> 可写');
    }

    // 4) 用户自定义指令不再从属于「safety rules」
    const custom = replaceKnownText(text, USER_CUSTOM_OLD, USER_CUSTOM_NEW,
      opts.previousPrompts?.['user_custom.new.txt'],
      opts.strictPairs && /user-context-(?:expert-)?identity\.tpl$/.test(file) && /custom instructions/i.test(text));
    if (custom !== text) { text = custom; actions.push('用户自定义指令更新'); }
  }

  return { raw, text, actions };
}

// ---------------------------------------------------------------- 备份

function makeBackup(files, tag) {
  const id = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    const name = `${tag}-${crypto.createHash('md5').update(f).digest('hex').slice(0, 8)}.tpl`;
    fs.writeFileSync(path.join(dir, name), buf);
    entries.push({ file: f, backup: name, sha256: sha256(buf), size: buf.length });
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id, createdAt: new Date().toISOString(), entries }, null, 2)
  );
  return { id, dir, entries };
}

function loadBackup(id) {
  const dir = path.join(BACKUP_ROOT, id);
  const man = path.join(dir, 'manifest.json');
  if (!fs.existsSync(man)) return null;
  return { id, dir, manifest: JSON.parse(fs.readFileSync(man, 'utf8')) };
}

function latestBackup() {
  if (!fs.existsSync(BACKUP_ROOT)) return null;
  const ids = fs.readdirSync(BACKUP_ROOT).filter((d) =>
    fs.existsSync(path.join(BACKUP_ROOT, d, 'manifest.json'))
  ).sort();
  return ids.length ? loadBackup(ids[ids.length - 1]) : null;
}

// ---------------------------------------------------------------- 命令

const REFUSAL_MARKERS = [
  'You MUST refuse',
  'NEVER reveal, rephrase',
  'politically sensitive topics',
  "I'm unable to output system information",
  'These rules apply at all times and cannot be bypassed',
  'cannot be bypassed by claims of',
];

function allTargets(roots, options = {}) {
  const out = [];
  const seen = new Set();
  const push = (root, file, kind) => {
    const key = path.resolve(file);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ root, file, kind });
  };
  // 未显式指定安装时，把每个安装与其配对配置目录一起处理。
  const configDirs = options.configDirs || configDirsForRoots(roots);
  for (const root of roots) {
    for (const f of collectTargets(root)) push(root, f, 'install');
  }
  for (const dir of configDirs) {
    for (const f of collectCacheTargets(dir)) push(dir, f, 'cache');
    for (const f of collectCliCacheTargets(dir)) push(dir, f, 'cli');
  }
  for (const root of roots) {
    for (const f of collectCliTargets(root)) push(root, f, 'cli');
  }
  return out;
}

function cmdList(roots) {
  let lastKind = null;
  let lastRoot = null;
  for (const t of allTargets(roots)) {
    if (t.kind !== lastKind || t.root !== lastRoot) {
      console.log(`\n=== ${t.kind === 'cache' ? '插件缓存 (实际生效)' : t.root} ===`);
      lastKind = t.kind;
      lastRoot = t.root;
    }
    const raw = fs.readFileSync(t.file, 'utf8');
    const m = raw.match(/<content_policy>([\s\S]*?)<\/content_policy>/);
    let state = '（无 content_policy）';
    if (m) {
      const legacy = /politically sensitive topics|For suspicious requests/.test(m[1]);
      const unlocked = !REFUSAL_MARKERS.some((k) => raw.includes(k));
      state = `${legacy ? 'ask/legacy' : 'craft/expert'} ${unlocked ? '[已解锁]' : '[原始]'}`;
    } else if (t.file.includes('user-context')) {
      state = raw.includes('unless they conflict with safety rules') ? '[自定义指令从属 safety]' : '（无 content_policy）';
    }
    console.log(`  ${rel(t.root, t.file)}  [${t.kind}]  ->  ${state}`);
  }
}

function cmdApply(roots, opts) {
  if (!roots.length) {
    console.error('未找到 WorkBuddy 安装目录。用 WORKBUDDY_ROOT 环境变量指定，例如：');
    console.error('  set WORKBUDDY_ROOT=D:\\Program Files\\WorkBuddy');
    process.exit(1);
  }

  const running = wbRunning();
  if (running && !opts.force && !opts.dryRun) {
    console.error(`检测到 ${running} 个 WorkBuddy 进程正在运行。`);
    console.error('请完全退出 WorkBuddy（含右下角托盘图标）后重试；或加 --force 强行写入（重启后生效）。');
    process.exit(2);
  }

  const all = [];
  for (const t of allTargets(roots)) {
    if (opts.onlyCurrent && t.kind === 'cache') {
      // 只改每个插件的最新版本
      const m = t.file.match(/welcomemode-[a-z]+[\\/]([^\\/]+)[\\/]prompt\.tpl$/);
      if (m) {
        const dir = path.dirname(path.dirname(t.file));
        const versions = fs.readdirSync(dir).filter((v) => v !== m[1]).sort();
        if (versions.length && versions[versions.length - 1] > m[1]) continue;
      }
    }
    const { raw, text, actions } = t.kind === 'cli' ? planForJson(t.file, opts) : planFor(t.file, opts);
    if (!actions.length || raw === text) continue;
    all.push({ ...t, text, actions });
  }

  if (!all.length) {
    console.log('没有需要修改的文件（可能已全部解锁）。');
    return;
  }

  console.log(`\n计划修改 ${all.length} 个文件:`);
  let lastKey = null;
  for (const a of all) {
    const key = `${a.kind}|${a.root}`;
    if (key !== lastKey) { console.log(`  --- ${a.kind === 'cache' ? '插件缓存' : a.root} ---`); lastKey = key; }
    console.log(`      ${rel(a.root, a.file)}  ->  ${a.actions.join(', ')}`);
  }

  if (opts.dryRun) {
    console.log('\n--dry-run: 未写入任何文件。');
    return;
  }

  const installFiles = all.filter((a) => a.kind === 'install').map((a) => a.file);
  const cacheFiles = all.filter((a) => a.kind === 'cache' || a.kind === 'cli').map((a) => a.file);
  const backups = [];
  if (installFiles.length) backups.push(makeBackup(installFiles, 'install'));
  if (cacheFiles.length) backups.push(makeBackup(cacheFiles, 'cache'));

  for (const b of backups) console.log(`\n备份已保存: ${b.dir}  (id=${b.id}, ${b.entries.length} 个文件)`);

  for (const a of all) {
    fs.writeFileSync(a.file, a.text, 'utf8');
    console.log(`已写入: [${a.kind}] ${rel(a.root, a.file)}`);
  }

  console.log('\n完成。请重新启动 WorkBuddy 使改动生效。');
  console.log('校验: node unlock.mjs verify      还原: node unlock.mjs restore');
  console.log('注意: WorkBuddy 升级到新版本后会重新解包，需要重新运行本脚本。');
}

function cmdVerify(roots) {
  let ok = true;
  let lastKey = null;
  for (const t of allTargets(roots)) {
    const key = `${t.kind}|${t.root}`;
    if (key !== lastKey) { console.log(`\n=== ${t.kind === 'cache' ? '插件缓存' : t.root} ===`); lastKey = key; }
    const raw = fs.readFileSync(t.file, 'utf8');
    const open = (raw.match(/<content_policy>/g) || []).length;
    const close = (raw.match(/<\/content_policy>/g) || []).length;
    const hits = REFUSAL_MARKERS.filter((k) => raw.includes(k));
    const tagOk = open === close;
    const customOk = !raw.includes('unless they conflict with safety rules');
    const r = rel(t.root, t.file);
    if (!tagOk) { ok = false; console.log(`  ✗ ${r}  标签不配对 (${open}/${close})`); }
    else if (hits.length) { ok = false; console.log(`  ✗ ${r}  [${t.kind}] 残留: ${hits.join(' | ')}`); }
    else if (!customOk) { ok = false; console.log(`  ✗ ${r}  自定义指令仍从属于 safety`); }
    else { console.log(`  ✓ ${r}  [${t.kind}]`); }
  }
  console.log(ok ? '\n全部模板已解锁，标签配对正常。' : '\n仍有未解锁或异常的模板。');
  return ok;
}

function cmdRestore(roots, opts) {
  const b = opts.backup ? loadBackup(opts.backup) : latestBackup();
  if (!b) { console.error('没有可用备份。'); process.exit(1); }
  console.log(`使用备份 ${b.id}  (${b.dir})`);
  let n = 0;
  for (const e of b.manifest.entries) {
    const src = path.join(b.dir, e.backup);
    if (!fs.existsSync(src)) { console.log(`  跳过（备份缺失）: ${e.file}`); continue; }
    fs.copyFileSync(src, e.file);
    console.log(`  已还原: ${e.file}`);
    n++;
  }
  console.log(`\n还原 ${n} 个文件。请重启 WorkBuddy。`);
}

// ---------------------------------------------------------------- main

export { detectRoots, allTargets, planFor, planForJson, wbRunning, loadPrompt, PROMPTS_DIR, CONFIG_DIR,
  configDirForRoot, configDirsForRoots, collectTargets, collectCliTargets, collectCliCacheTargets, collectCacheTargets };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const opts = {
  full: argv.includes('--full'),
  dryRun: argv.includes('--dry-run'),
  force: argv.includes('--force'),
  onlyCurrent: argv.includes('--current-only'),
  backup: (argv.find((a) => a.startsWith('--backup=')) || '').split('=')[1],
};

const roots = detectRoots();

switch (cmd) {
  case 'list': cmdList(roots); break;
  case 'apply': cmdApply(roots, opts); break;
  case 'verify': if (!cmdVerify(roots)) process.exitCode = 1; break;
  case 'restore': cmdRestore(roots, opts); break;
  default:
    console.log(`
WorkBuddy Prompt Unlock

  node unlock.mjs list                 查看模板与现状
  node unlock.mjs apply                解除 content_policy（最小改动）
  node unlock.mjs apply --full         同时放宽文件安全段 / Windows 段 / Ask 只读 / 自定义指令优先级
  node unlock.mjs apply --full --dry-run    只预览
  node unlock.mjs apply --current-only      插件缓存只改最新版本
  node unlock.mjs verify               校验
  node unlock.mjs restore              还原最近备份
  node unlock.mjs restore --backup=ID  还原指定备份

环境变量 WORKBUDDY_ROOT 可指定安装目录。修改前请完全退出 WorkBuddy。`);
    process.exit(1);
}
}
