/**
 * 测试侧的 node:sqlite 转发模块。
 *
 * 起因：Vite 的解析器会把 `node:sqlite` 的 `node:` 前缀当作包名处理，
 * 报 `Failed to load url sqlite`。这里用 createRequire 在运行时加载，
 * 绕开静态解析。生产构建（tsc → CJS）不经此文件，直接使用原生 import。
 */
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url) as NodeRequire;
const sqlite = req('node:sqlite') as typeof import('node:sqlite');

export const DatabaseSync = sqlite.DatabaseSync;
export type DatabaseSyncInstance = InstanceType<typeof sqlite.DatabaseSync>;
export default sqlite;
