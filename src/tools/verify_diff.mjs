import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const B = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backup');
const ids = fs.readdirSync(B).filter((d) => fs.existsSync(path.join(B, d, 'manifest.json'))).sort();

// 每个文件只取最新一次备份作为基线。
// 官方升级会改变非目标区块（WorkBuddyAI 5.5.2 -> 5.7.6 会整树重新解包），
// 拿更旧的备份比对会产生大量跨版本误报，而不是真实的块外改动。
const latest = new Map();
for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(path.join(B, id, 'manifest.json'), 'utf8'));
  for (const e of m.entries) latest.set(path.resolve(e.file), { ...e, dir: path.join(B, id) });
}
const entries = [...latest.values()];

// 允许被替换的区块
const ALLOWED = ['content_policy', 'personal_files_safety', 'windows_command_safety', 'current_mode', 'ask_mode'];
const NUNJUCK = /\{[%{#]/;

const CUSTOM_OLD = 'The user has provided the following custom instructions. You MUST follow them in all responses unless they conflict with safety rules.';
// 替换文本以 prompts/ 为准，不再硬编码 —— 否则一改措辞就会出现大批误报。
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');
const loadPrompt = (name) =>
  fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
// 历史变体 + 当前内容：旧补丁与本次补丁都要能被剥离。
const HISTORY_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.state', 'prompt-history.json');
const history = fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) : {};
const variants = (name) => [...new Set([...(history[name] || []), loadPrompt(name)])].filter(Boolean);
const CUSTOM_VARIANTS = [...variants('user_custom.new.txt'), loadPrompt('user_custom.old.txt')];

function strip(s) {
  let out = s;
  for (const t of ALLOWED) {
    out = out.replace(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, 'g'), `<${t}/>`);
  }
  out = out.split(CUSTOM_OLD).join('CUSTOM');
  for (const v of CUSTOM_VARIANTS) out = out.split(v).join('CUSTOM');
  return out;
}

let bad = 0;
let checked = 0;
for (const e of entries) {
  // JSON 由 verify_json.mjs 专门验证（它按字段级别对比，比文本对比更准确）
  if (e.file.endsWith('.json')) continue;
  const orig = fs.readFileSync(path.join(e.dir, e.backup), 'utf8');
  if (!fs.existsSync(e.file)) { console.log('SKIP (目录已被客户端 GC)', path.basename(path.dirname(e.file))); continue; }
  const now = fs.readFileSync(e.file, 'utf8');
  checked++;

  // 1) 新增的行不得引入 nunjucks 模板语法
  const origLines = new Set(orig.split('\n'));
  for (const l of now.split('\n')) {
    if (!origLines.has(l) && NUNJUCK.test(l)) {
      console.log(`✗ 新引入模板语法: ${e.file}\n    ${l.slice(0, 140)}`);
      bad++;
    }
  }

  // 2) 挖掉允许改动的区块后，其余部分必须逐字节一致
  const a = strip(orig);
  const b = strip(now);
  if (a !== b) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
    console.log(`✗ 区块外内容被改动: ${path.basename(e.file)}`);
    console.log(`    @${i}\n    orig: ${JSON.stringify(a.slice(Math.max(0, i - 60), i + 80))}\n    now : ${JSON.stringify(b.slice(Math.max(0, i - 60), i + 80))}`);
    bad++;
  }
}
console.log(`\n检查 ${checked} 个文件，异常 ${bad} 个。`);
