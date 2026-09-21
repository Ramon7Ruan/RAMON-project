import { contextBridge, ipcRenderer } from 'electron';
import { CH } from '../src/shared/ipc';

/**
 * 渲染层没有任何 Node 权限（contextIsolation: true, nodeIntegration: false）。
 * 这里只暴露两组能力：
 *   - invoke：受限 IPC 调用
 *   - onUpdateAvailable：主进程主动通知（内容更新可用）
 * 内容来自网络，一律视为不可信输入，因此渲染层不能直接碰文件系统。
 */
const ALLOWED = new Set<string>(Object.values(CH));

contextBridge.exposeInMainWorld('recall', {
  invoke: (channel: string, payload?: unknown) => {
    if (!ALLOWED.has(channel)) {
      return Promise.reject(new Error(`不允许的通道：${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onEvent: (cb: (name: string, data: unknown) => void) => {
    ipcRenderer.on('app:event', (_e, name: string, data: unknown) => cb(name, data));
  },
  platform: process.platform,
});
