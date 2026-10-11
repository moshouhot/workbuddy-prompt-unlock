/**
 * 统一的路径解析。
 *
 * 所有引擎脚本都位于 src/，而用户可见的资源（prompts/、backup/、.state/）
 * 位于项目根目录，因此这里集中计算一次 PROJECT_ROOT，避免每个文件各写一遍
 * `path.join(__dirname, '..')` 并在目录调整时到处出问题。
 *
 * 环境变量优先（供隔离测试使用）：
 *   WORKBUDDY_PROMPTS_DIR / WORKBUDDY_BACKUP_DIR / WORKBUDDY_STATE_DIR
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** src/ 目录（本文件所在目录）。 */
export const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录：src/ 的上一级。 */
export const PROJECT_ROOT = path.resolve(SRC_DIR, '..');

/** 用户可编辑的提示词目录。 */
export const PROMPTS_DIR = process.env.WORKBUDDY_PROMPTS_DIR || path.join(PROJECT_ROOT, 'prompts');

/** 事务备份目录。 */
export const BACKUP_ROOT = process.env.WORKBUDDY_BACKUP_DIR || path.join(PROJECT_ROOT, 'backup');

/** 状态目录：提示词历史、并发锁、界面偏好。 */
export const STATE_DIR = process.env.WORKBUDDY_STATE_DIR || path.join(PROJECT_ROOT, '.state');

/** 内置的 nunjucks（与客户端同版本），随仓库分发或由 npm install 提供。 */
export const NUNJUCKS_PATH = path.join(SRC_DIR, 'tools', 'node_modules', 'nunjucks');
