/**
 * 验证 CLI 提示词的改动范围与有效性。
 *
 * 两类文件，两种校验策略：
 *
 *   1) 安装目录的 product.json
 *      —— 不会被服务端改写，做严格字段级校验：
 *         除 prompts[].template 的目标段落外，其余字段必须与备份完全一致。
 *
 *   2) ~/.workbuddy/cache/acc-product-config-v3.json 等运行时缓存
 *      —— 由客户端按「本地 product.json + 服务端合并」重新生成，
 *         顶层 key 数量/内容会变（服务端可能追加 enterpriseId、modelTiers 等）。
 *         对它做「与备份逐字段比对」是无意义的，正确校验是：
 *           a. 结构仍然完整（prompts 是数组、条目有 name/template）
 *           b. 补丁确实存在（无原始拒答规则，且含补丁标记）
 *           c. 若顶层 key 有变化，只作提示，不计为错误
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const B = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backup');
const ids = fs.readdirSync(B).filter((d) => fs.existsSync(path.join(B, d, 'manifest.json'))).sort();

const REFUSAL_MARKERS = [
  'You MUST refuse',
  'NEVER reveal, rephrase',
  'politically sensitive topics',
  'cannot be bypassed by claims of',
];
/**
 * 补丁标记不硬编码文本 —— 否则 prompts/ 一改措辞，校验器就会误报“未检测到补丁”。
 * 直接从 prompts/ 取当前文本的首个非空行作为签名。
 */
const PROMPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');
const signature = (name) => {
  const raw = fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
  return raw.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('<') && !l.startsWith('#'));
};
const PATCH_MARKERS = [signature('content_policy.cli.txt'), signature('cli_security_note.new.txt')];
const SECURITY_NOTE_ORIGINAL = fs.readFileSync(
  path.join(PROMPTS_DIR, 'cli_security_note.old.txt'), 'utf8').trim().split('\n')[0].trim();

/** 运行时缓存：由客户端/服务端重新生成，不做逐字段比对。 */
const isRuntimeCache = (p) => p.toLowerCase().includes(`${path.sep}.workbuddy${path.sep}cache${path.sep}`);

/**
 * 只校验「提示词类」文件 —— 即含 prompts[] 数组的 product.json / 产品配置。
 * settings.json、tsbx_rules.json 等属于安全配置，由 security-unlock 负责，
 * 本脚本不应把它们当成提示词配置来判断。
 */
function isPromptConfig(doc, file) {
  if (Array.isArray(doc?.prompts)) return true;
  const base = path.basename(file).toLowerCase();
  if (base === 'settings.json' || base.endsWith('_rules.json') || base === 'tsbx_rules.json') return false;
  return false;
}

/** 统计某个具体提示词条目里的拒答残留。 */
function scanEntry(item) {
  const t = item.template;
  if (typeof t !== 'string') return { refusals: [], patched: false };
  return {
    refusals: REFUSAL_MARKERS.filter((m) => t.includes(m)),
    patched: PATCH_MARKERS.some((m) => t.includes(m)),
  };
}

let checked = 0;
let bad = 0;
let warned = 0;

for (const id of ids) {
  const m = JSON.parse(fs.readFileSync(path.join(B, id, 'manifest.json'), 'utf8'));

  for (const e of m.entries) {
    if (!e.file.endsWith('.json')) continue;
    if (!fs.existsSync(e.file)) { console.log(`SKIP (不存在)  ${e.file}`); continue; }

    const name = path.basename(e.file);
    let after;
    try {
      after = JSON.parse(fs.readFileSync(e.file, 'utf8'));
    } catch (err) {
      console.log(`✗ JSON 解析失败: ${name} — ${err.message}`);
      bad++;
      continue;
    }
    checked++;

    if (!isPromptConfig(after, e.file)) {
      console.log(`SKIP (非提示词配置，属安全配置)  ${name}`);
      continue;
    }

    if (!Array.isArray(after.prompts)) {
      console.log(`✗ prompts 不是数组: ${name}`);
      bad++;
      continue;
    }

    // ── 通用校验：结构完整 + 补丁生效 ────────────────────────────────
    let structOk = true;
    let refusalTotal = 0;
    let patchedCount = 0;
    for (const item of after.prompts) {
      if (typeof item.name !== 'string' || typeof item.template !== 'string') { structOk = false; }
      const s = scanEntry(item);
      refusalTotal += s.refusals.length;
      if (s.patched) patchedCount++;
    }

    if (!structOk) { console.log(`✗ 结构损坏（存在缺 name/template 的条目）: ${name}`); bad++; continue; }
    if (refusalTotal > 0) { console.log(`✗ 仍有拒答规则残留 (${refusalTotal} 处): ${name}`); bad++; continue; }
    if (patchedCount === 0) { console.log(`✗ 未检测到补丁标记: ${name}`); bad++; continue; }

    // ── 运行时缓存：只报告，不做严格比对 ─────────────────────────────
    if (isRuntimeCache(e.file)) {
      const before = JSON.parse(fs.readFileSync(path.join(B, id, e.backup), 'utf8'));
      const kb = Object.keys(before).length;
      const ka = Object.keys(after).length;
      const note = kb === ka
        ? `顶层 key 未变 (${ka})`
        : `顶层 key 由客户端重生成: ${kb} -> ${ka}（正常，服务端会追加字段）`;
      console.log(`✓ ${name}  运行时缓存：结构完整、补丁生效 (${patchedCount} 个模板) · ${note}`);
      if (kb !== ka) warned++;
      continue;
    }

    // ── 安装目录文件：严格字段级比对 ────────────────────────────────
    const before = JSON.parse(fs.readFileSync(path.join(B, id, e.backup), 'utf8'));

    const kb = Object.keys(before).sort().join(',');
    const ka = Object.keys(after).sort().join(',');
    if (kb !== ka) { console.log(`✗ 顶层 key 变化: ${name}`); bad++; continue; }

    for (const k of Object.keys(before)) {
      if (k === 'prompts') continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
        console.log(`✗ 非 prompts 字段被改动: ${name} -> ${k}`);
        bad++;
      }
    }

    if (before.prompts.length !== after.prompts.length) {
      console.log(`✗ prompts 数量变化: ${name}`);
      bad++;
      continue;
    }

    const byName = new Map(after.prompts.map((p) => [p.name, p]));
    for (const b of before.prompts) {
      const a = byName.get(b.name);
      if (!a) { console.log(`✗ 条目丢失: ${name} -> ${b.name}`); bad++; continue; }

      for (const k of Object.keys(b)) {
        if (k === 'template') continue;
        if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) { console.log(`✗ ${b.name}.${k} 变化`); bad++; }
      }

      const shouldChange = b.template.includes('<content_policy>') ||
                           b.template.includes(SECURITY_NOTE_ORIGINAL) ||
                           PATCH_MARKERS.some((m) => b.template.includes(m));
      if (b.template !== a.template && !shouldChange) {
        console.log(`✗ 不该改动的 template 被改动: ${name} -> ${b.name}`);
        bad++;
      }
    }

    console.log(`✓ ${name}  安装目录文件：结构一致，仅 prompts[].template 的目标段落被替换`);
  }
}

console.log(`\n检查 ${checked} 个 JSON，异常 ${bad} 个` + (warned ? `，另有 ${warned} 个运行时缓存被客户端重生成（正常）` : '') + '。');
process.exit(bad ? 1 : 0);
