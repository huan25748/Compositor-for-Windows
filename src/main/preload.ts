/**
 * 预加载脚本：把受控的文件 API 暴露给渲染进程。
 * 渲染进程永远拿不到 node 能力，只能调用下面这些明确的方法。
 */
import { contextBridge, ipcRenderer } from 'electron'
import type { Manifest } from '../shared/types.ts'

interface ProjectPayload {
  dir: string
  manifest: Manifest
  assets: Record<string, Uint8Array>
}

const api = {
  /** 选择并读取一个 .comp 项目。 */
  openProject: (): Promise<ProjectPayload | null> => ipcRenderer.invoke('project:pick').then((dir) => (dir ? ipcRenderer.invoke('project:read', dir) : null)),
  /** 直接读取已知路径的项目。 */
  readProject: (dir: string): Promise<ProjectPayload> => ipcRenderer.invoke('project:read', dir),
  /** 选择保存位置（创建 .comp 目录）。 */
  pickSavePath: (suggested: string): Promise<string | null> => ipcRenderer.invoke('project:pickSave', suggested),
  /** 写入项目。 */
  writeProject: (payload: ProjectPayload): Promise<{ dir: string }> => ipcRenderer.invoke('project:write', payload),
  /** 选择图片文件并返回原始字节。 */
  pickImages: (): Promise<{ name: string; bytes: Uint8Array }[]> => ipcRenderer.invoke('images:pick'),
  /** 保存导出的位图。 */
  saveImage: (opts: { suggested: string; format: 'png' | 'jpeg' | 'psd'; bytes: Uint8Array }): Promise<string | null> =>
    ipcRenderer.invoke('image:save', opts),
  /** 在资源管理器中定位文件。 */
  reveal: (path: string): Promise<void> => ipcRenderer.invoke('shell:reveal', path),
  /** 系统已安装的字体名列表。 */
  listFonts: (): Promise<string[]> => ipcRenderer.invoke('fonts:list'),
  /** 版本信息。 */
  info: (): Promise<{ version: string; electron: string; chrome: string }> => ipcRenderer.invoke('app:info'),
  /** 订阅菜单命令。 */
  onMenuCommand: (handler: (command: string) => void): void => {
    ipcRenderer.on('menu-command', (_e, command: string) => handler(command))
  },
}

contextBridge.exposeInMainWorld('compositor', api)

export type CompositorAPI = typeof api
