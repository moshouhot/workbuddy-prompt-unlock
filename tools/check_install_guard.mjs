/**
 * WorkBuddy 更新拦截诊断工具
 *
 * 复刻 app.asar 中的 hasUserContentInInstallDir() 判定逻辑，列出安装目录下
 * 所有会触发「无法安装必要的更新」的目录，并给出处理建议。
 *
 * ── 原始逻辑（从 app.asar 提取，WorkBuddy 5.7.7）─────────────────────────
 *   var APP_KNOWN_DIRS = new Set([
 *     'bin','locales','resources','tools','log','logs','_','share-target','assets'
 *   ]);
 *   function isKnownAppDirectory(name) {
 *     const t = name.toLowerCase();
 *     return APP_KNOWN_DIRS.has(t) || t.startsWith('$') || t.startsWith('nsis');
 *   }
 *   function hasUserContentInInstallDir() {
 *     const dir = getInstallDir();               // = dirname(process.execPath)
 *     if (!dir) return false;
 *     return fs.readdirSync(dir, { withFileTypes: true })
 *              .some(e => e.isDirectory() && !isKnownAppDirectory(e.name));
 *   }
 *
 * 只要安装目录下存在任意一个「不在白名单里的子目录」，更新就被拦截
 * （update 日志：`[win32] Update blocked by install dir guard`）。
 *
 * 注意：判定粒度是「目录」——安装目录根下的普通文件不影响判定。
 *
 * 用法:
 *   node check_install_guard.mjs                       # 自动检测所有安装
 *   node check_install_guard.mjs "D:\Program Files\WorkBuddy"
 *   node check_install_guard.mjs --fix                 # 删除可安全删除的缓存目录
 */

import fs from 'node:fs';
import path from 'node:path';

// ── 与客户端一致的白名单 ──────────────────────────────────────────────────
const APP_KNOWN_DIRS = new Set([
  'bin', 'locales', 'resources', 'tools', 'log', 'logs', '_', 'share-target', 'assets',
]);

const isKnownAppDirectory = (name) => {
  const t = name.toLowerCase();
  return APP_KNOWN_DIRS.has(t) || t.startsWith('$') || t.startsWith('nsis');
};

/**
 * 已知的工具型缓存目录：由外部工具（ruff / pytest / mypy 等）在 cwd 下自动创建，
 * 不含用户数据，可安全删除；工具会在其他 cwd 按需重建。
 */
const SAFE_TO_DELETE = new Set([
  '.ruff_cache',
  '.pytest_cache',
  '.mypy_cache',
  '.pyre',
  '.tox',
  '.nox',
  '__pycache__',
  '.hypothesis',
  '.pytest_tmp',
  '.coverage_cache',
]);

// ── 安装目录发现 ──────────────────────────────────────────────────────────
function detectInstallDirs() {
  if (process.env.WORKBUDDY_ROOT) return [process.env.WORKBUDDY_ROOT];
  const found = [];
  for (const drive of ['C:', 'D:', 'E:', 'F:']) {
    for (const name of ['WorkBuddy', 'WorkBuddyAI']) {
      const p = path.join(drive + path.sep, 'Program Files', name);
      const exes = ['WorkBuddy.exe', 'WorkBuddyAI.exe'].map((e) => path.join(p, e));
      if (exes.some((e) => fs.existsSync(e))) found.push(p);
    }
  }
  return found;
}

// ── 判定 ─────────────────────────────────────────────────────────────────
function analyse(dir) {
  if (!fs.existsSync(dir)) return null;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }

  const known = [];
  const offenders = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    (isKnownAppDirectory(e.name) ? known : offenders).push(e.name);
  }
  return { dir, known, offenders, blocked: offenders.length > 0 };
}

function dirSize(dir, name) {
  try {
    let total = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else { try { total += fs.statSync(f).size; } catch { /* ignore */ } }
      }
    };
    walk(path.join(dir, name));
    return total < 1024 ? `${total} B` : `${(total / 1024).toFixed(1)} KB`;
  } catch { return '?'; }
}

// ── main ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const doFix = args.includes('--fix');
const explicit = args.filter((a) => !a.startsWith('--'));
const dirs = explicit.length ? explicit : detectInstallDirs();

if (!dirs.length) {
  console.error('未检测到 WorkBuddy 安装目录。可显式传入路径，或设置 WORKBUDDY_ROOT。');
  process.exit(1);
}

let anyBlocked = false;
let fixedCount = 0;

for (const dir of dirs) {
  const r = analyse(dir);
  console.log(`\n=== ${dir} ===`);
  if (!r) { console.log('  (不存在或无法读取)'); continue; }

  for (const k of r.known) console.log(`  ✓ 白名单    ${k}`);
  for (const o of r.offenders) console.log(`  ✗ 未识别    ${o}   (${dirSize(dir, o)})`);

  if (!r.blocked) {
    console.log(`\n  >>> hasUserContentInInstallDir() = false`);
    console.log(`  >>> 更新可正常进行`);
    continue;
  }

  anyBlocked = true;
  console.log(`\n  >>> hasUserContentInInstallDir() = true`);
  console.log(`  >>> 更新会被拦截（日志: [win32] Update blocked by install dir guard）`);
  console.log(`  >>> 触发目录: ${r.offenders.join(', ')}`);

  const safe = r.offenders.filter((o) => SAFE_TO_DELETE.has(o.toLowerCase()));
  const risky = r.offenders.filter((o) => !safe.includes(o));

  if (safe.length) {
    console.log(`\n  可安全删除的缓存目录: ${safe.join(', ')}`);
    if (doFix) {
      for (const s of safe) {
        try {
          fs.rmSync(path.join(dir, s), { recursive: true, force: true });
          console.log(`    ✅ 已删除 ${s}`);
          fixedCount++;
        } catch (err) {
          console.log(`    ❌ 删除失败 ${s}: ${err.message}`);
        }
      }
    } else {
      console.log(`  （加 --fix 自动删除）`);
    }
  }

  if (risky.length) {
    console.log(`\n  ⚠️  非缓存目录，需要你自己判断: ${risky.join(', ')}`);
    console.log(`     如果这是你的项目/工作区，把它移到安装目录之外即可；`);
    console.log(`     移动前先备份对应 workspace，避免项目记录丢失。`);
    console.log(`     （这正是官方提示「更新会导致项目记录丢失」的原因）`);
  }
}

console.log('\n' + '─'.repeat(64));
if (fixedCount) console.log(`已清理 ${fixedCount} 个缓存目录。重启 WorkBuddy 后重试更新。`);
else if (anyBlocked) console.log('存在更新拦截，请处理上面标出的目录。');
else console.log('所有安装目录均正常，不会被更新拦截。');
