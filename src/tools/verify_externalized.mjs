/**
 * 回归验证：把 prompts/ 里的替换文本，与「从官方原始模板备份」中旧硬编码逻辑
 * 应当产出的结果做逐字节比对，确认外置化没有改变任何一个字节。
 *
 * 方法：用 backup/ 里的原始模板 + prompts/ 里的新文本，跑一遍完整补丁，
 * 生成到临时目录；再与当前磁盘上已应用补丁的文件逐字节比对。
 * 两者必须完全一致 —— 否则说明外置化引入了差异。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const B = path.join(ROOT, 'backup');

const loadPrompt = (name) =>
  fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');

const MODERN_POLICY = loadPrompt('content_policy.craft-expert.txt');
const LEGACY_POLICY = loadPrompt('content_policy.ask-legacy.txt');
const CLI_POLICY = loadPrompt('content_policy.cli.txt');
const PERSONAL = loadPrompt('personal_files_safety.txt');
const WINDOWS = loadPrompt('windows_command_safety.txt');
const ASK_CUR = loadPrompt('ask_mode.current_mode.txt');
const ASK_REM = loadPrompt('ask_mode.reminder.txt');
const CLI_SEC_OLD = loadPrompt('cli_security_note.old.txt');
const CLI_SEC_NEW = loadPrompt('cli_security_note.new.txt');
const UC_OLD = loadPrompt('user_custom.old.txt');
const UC_NEW = loadPrompt('user_custom.new.txt');

// 历史替换文本：已应用过的旧版本也要能回归。
const HISTORY_FILE = path.join(ROOT, '.state', 'prompt-history.json');
const history = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : {};
const variants = (name) => [...new Set([...(history[name] || []), loadPrompt(name)])].filter(Boolean);

const newlineOf = (s) => (s.includes('\r\n') ? '\r\n' : '\n');
const toNL = (s, nl) => s.replace(/\r?\n/g, nl);

/** 与 unlock.mjs 的 replaceKnownText 一致：原文、历史变体、当前文本依次尝试。 */
function replaceKnownTextLocal(text, oldText, newText, previous = []) {
  for (const body of [oldText, ...(Array.isArray(previous) ? previous : [previous]), newText]) {
    if (!body) continue;
    const candidate = toNL(body, newlineOf(text));
    if (text.includes(candidate)) return text.replace(candidate, () => toNL(newText, newlineOf(text)));
  }
  return text;
}

function replSection(text, tag, body) {
  const re = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  return re.test(text) ? text.replace(re, toNL(body, newlineOf(text))) : text;
}

// ── 复刻 planFor（模板）──────────────────────────────────────────────────
function patchTemplate(orig, file) {
  let t = orig;
  const policyRe = /<content_policy>([\s\S]*?)<\/content_policy>/;
  const m = t.match(policyRe);
  // 不硬编码补丁标记：已是当前文本时无需替换。
  if (m && m[1].trim() !== MODERN_POLICY.trim() && m[1].trim() !== LEGACY_POLICY.trim()) {
    const legacy = /politically sensitive topics|For suspicious requests/.test(m[1]);
    t = t.replace(policyRe, toNL(legacy ? LEGACY_POLICY : MODERN_POLICY, newlineOf(t)));
  }
  t = replSection(t, 'personal_files_safety', PERSONAL);
  t = replSection(t, 'windows_command_safety', WINDOWS);
  if (/(^|[\\/])workbuddy-ask.*\.tpl$/.test(file)) {
    t = replSection(t, 'current_mode', ASK_CUR);
  }
  if (/(^|[\\/])ask-mode-reminder\.tpl$/.test(file) && /<ask_mode>/.test(t)) {
    t = t.replace(/<ask_mode>[\s\S]*?<\/ask_mode>/, toNL(ASK_REM, newlineOf(t)));
  }
  if (t.includes(UC_OLD)) t = t.replace(UC_OLD, UC_NEW);
  // 已应用过的旧版自定义指令也要能匹配（历史变体 -> 当前文本）。
  for (const prev of variants('user_custom.new.txt')) {
    if (prev && prev !== UC_NEW && t.includes(prev)) t = t.replace(prev, UC_NEW);
  }
  return t;
}

// ── 复刻 planForJson ────────────────────────────────────────────────────
function patchJson(orig) {
  const data = JSON.parse(orig);
  if (!Array.isArray(data.prompts)) return orig;
  for (const item of data.prompts) {
    if (typeof item.template !== 'string') continue;
    let t = item.template;
    if (t.includes('<content_policy>')) {
      const cur = t.match(/<content_policy>([\s\S]*?)<\/content_policy>/)?.[1]?.trim();
      if (cur !== CLI_POLICY.trim()) {
        t = t.replace(/<content_policy>[\s\S]*?<\/content_policy>/, () => CLI_POLICY);
      }
    }
    t = replaceKnownTextLocal(t, CLI_SEC_OLD, CLI_SEC_NEW, variants('cli_security_note.new.txt'));
    if (/<ask_mode>[\s\S]*?<\/ask_mode>/.test(t)) {
      t = t.replace(/<ask_mode>[\s\S]*?<\/ask_mode>/, ASK_REM);
    }
    item.template = t;
  }
  const nl = newlineOf(orig);
  return toNL(JSON.stringify(data, null, 2) + '\n', nl);
}

// ── 跑回归 ──────────────────────────────────────────────────────────────
const ids = fs.readdirSync(B).filter((d) => fs.existsSync(path.join(B, d, 'manifest.json'))).sort();

const seen = new Set();
let ok = 0, diff = 0, skip = 0;

// 每个文件只取最新一次备份作为基线。
// 官方升级会改变非目标区块，拿更旧的备份重放会产生跨版本误报。
const latestForFile = new Map();
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(path.join(B, id, 'manifest.json'), 'utf8'));
  for (const e of m.entries) latestForFile.set(path.resolve(e.file), { ...e, id });
}

for (const e of latestForFile.values()) {
  {
    const id = e.id;
    if (seen.has(e.file)) continue;
    seen.add(e.file);

    const bak = path.join(B, id, e.backup);
    if (!fs.existsSync(bak)) { skip++; continue; }
    if (!fs.existsSync(e.file)) { skip++; continue; }

    const orig = fs.readFileSync(bak, 'utf8');
    const current = fs.readFileSync(e.file, 'utf8');

    // 只回归「提示词类」文件；安全配置与权限偏好由 security-unlock 负责，
    // 其内容变化不应在这里被当作失败。
    const base = path.basename(e.file).toLowerCase();
    const isSecurityConfig = base === 'settings.json' || base.endsWith('_rules.json')
      || base === 'app-config.json' || base === 'preferences.json';
    if (isSecurityConfig) { skip++; continue; }

    // 只回归「本补丁应当改动过」的文件
    const isTemplate = !e.file.endsWith('.json');
    const regenerated = isTemplate ? patchTemplate(orig, e.file) : patchJson(orig);

    if (regenerated === current) {
      ok++;
    } else {
      // JSON 运行时缓存会被客户端重生成，顶层 key 变化属正常，跳过
      const isRuntimeCache = /[\\/]\.workbuddy(-ai)?[\\/]cache[\\/]/i.test(e.file);
      if (!isTemplate && isRuntimeCache) {
        skip++;
        continue;
      }
      diff++;
      let i = 0;
      while (i < Math.min(regenerated.length, current.length) && regenerated[i] === current[i]) i++;
      console.log(`✗ 字节不一致: ${path.basename(e.file)} @${i}`);
      console.log(`   期望: ${JSON.stringify(regenerated.slice(Math.max(0, i - 50), i + 70))}`);
      console.log(`   实际: ${JSON.stringify(current.slice(Math.max(0, i - 50), i + 70))}`);
    }
  }
}

console.log(`\n外置化回归: 逐字节一致 ${ok}，不一致 ${diff}，跳过 ${skip}`);
process.exit(diff ? 1 : 0);
