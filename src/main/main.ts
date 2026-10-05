/**
 * Electron 主进程：窗口、中文菜单，以及全部文件系统 IPC。
 *
 * 渲染进程不直接碰磁盘；.comp 的读写、图片导入导出都经由这里，
 * 保证写入纪律（原子替换 manifest）只在一处实现。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { readComp, writeComp } from './comp-store.ts'
import { LIMITS, type Manifest } from '../shared/types.ts'

/** IPC 上传输的项目载荷。 */
interface ProjectPayload {
  dir: string
  manifest: Manifest
  /** 文件名 -> 字节。跨进程时是 Uint8Array。 */
  assets: Record<string, Uint8Array>
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif']

let mainWindow: BrowserWindow | null = null

function send(command: string): void {
  mainWindow?.webContents.send('menu-command', command)
}

/** 中文菜单栏。 */
function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '新建…', accelerator: 'CmdOrCtrl+N', click: () => send('file.new') },
        { label: '打开项目…', accelerator: 'CmdOrCtrl+O', click: () => send('file.open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('file.save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('file.saveAs') },
        { type: 'separator' },
        { label: '导入图像…', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('file.import') },
        { label: '导出 PNG…', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('file.exportPng') },
        { label: '导出 JPEG…', accelerator: 'CmdOrCtrl+Alt+Shift+E', click: () => send('file.exportJpeg') },
        { type: 'separator' },
        { label: '关闭项目', accelerator: 'CmdOrCtrl+W', click: () => send('file.close') },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => send('edit.undo') },
        { label: '重做', accelerator: 'CmdOrCtrl+Y', click: () => send('edit.redo') },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', click: () => send('edit.cut') },
        { label: '复制', accelerator: 'CmdOrCtrl+C', click: () => send('edit.copy') },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', click: () => send('edit.paste') },
        { type: 'separator' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', click: () => send('select.all') },
        { label: '取消选择', accelerator: 'CmdOrCtrl+D', click: () => send('select.none') },
        { label: '反选', accelerator: 'CmdOrCtrl+Shift+I', click: () => send('select.invert') },
      ],
    },
    {
      label: '图层',
      submenu: [
        { label: '新建图层', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('layer.new') },
        { label: '复制图层', accelerator: 'CmdOrCtrl+J', click: () => send('layer.duplicate') },
        { label: '删除图层', click: () => send('layer.delete') },
        { type: 'separator' },
        { label: '新建组', accelerator: 'CmdOrCtrl+G', click: () => send('layer.group') },
        { label: '从选中图层建组', accelerator: 'CmdOrCtrl+Shift+G', click: () => send('layer.groupSelected') },
        { label: '取消编组', accelerator: 'CmdOrCtrl+Shift+U', click: () => send('layer.ungroup') },
        { type: 'separator' },
        { label: '添加蒙版', click: () => send('layer.addMask') },
        { label: '删除蒙版', click: () => send('layer.deleteMask') },
        { label: '创建剪贴蒙版', accelerator: 'CmdOrCtrl+Alt+G', click: () => send('layer.clip') },
        { type: 'separator' },
        { label: '上移一层', accelerator: 'CmdOrCtrl+]', click: () => send('layer.raise') },
        { label: '下移一层', accelerator: 'CmdOrCtrl+[', click: () => send('layer.lower') },
        { label: '置顶', accelerator: 'CmdOrCtrl+Shift+]', click: () => send('layer.toTop') },
        { label: '置底', accelerator: 'CmdOrCtrl+Shift+[', click: () => send('layer.toBottom') },
        { type: 'separator' },
        { label: '向下合并', accelerator: 'CmdOrCtrl+E', click: () => send('layer.mergeDown') },
        { label: '合并选中图层', accelerator: 'CmdOrCtrl+Shift+E', click: () => send('layer.mergeSelected') },
        { type: 'separator' },
        { label: '水平翻转图层', click: () => send('layer.flipH') },
        { label: '垂直翻转图层', click: () => send('layer.flipV') },
      ],
    },
    {
      label: '调整图层',
      submenu: [
        { label: '色相/饱和度…', click: () => send('adjust.hueSaturation') },
        { label: '色阶…', click: () => send('adjust.levels') },
        { label: '曲线…', click: () => send('adjust.curves') },
        { label: '曝光…', click: () => send('adjust.exposure') },
        { label: '渐变映射…', click: () => send('adjust.gradientMap') },
        { label: '黑白…', click: () => send('adjust.blackWhite') },
        { label: '色彩平衡…', click: () => send('adjust.colorBalance') },
        { label: '反相', click: () => send('adjust.invert') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: () => send('view.zoomIn') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: () => send('view.zoomOut') },
        { label: '适应窗口', accelerator: 'CmdOrCtrl+0', click: () => send('view.fit') },
        { label: '实际像素', accelerator: 'CmdOrCtrl+1', click: () => send('view.actual') },
        { type: 'separator' },
        { label: '显示标尺', click: () => send('view.toggleRulers') },
        { label: '显示网格', click: () => send('view.toggleGrid') },
        { label: '显示像素网格', click: () => send('view.togglePixelGrid') },
        { label: '清除参考线', click: () => send('view.clearGuides') },
        { label: '水平翻转画布', click: () => send('canvas.flipH') },
        { label: '垂直翻转画布', click: () => send('canvas.flipV') },
        { type: 'separator' },
        { label: '切换开发者工具', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 Compositor for Windows', click: () => send('help.about') },
        {
          label: '查看上游项目',
          click: () => void shell.openExternal('https://github.com/robbietilton/Compositor'),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 把 Map 形式资源转成可跨进程传输的普通对象。 */
function assetsToObject(assets: Map<string, Uint8Array>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const [k, v] of assets) out[k] = v
  return out
}

function registerIPC(): void {
  // —— 打开项目 ——
  ipcMain.handle('project:pick', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '打开 Compositor 项目',
      message: '选择一个 .comp 文件夹',
      properties: ['openDirectory'],
      buttonLabel: '打开',
    })
    return res.canceled || !res.filePaths[0] ? null : res.filePaths[0]
  })

  ipcMain.handle('project:read', async (_e, dir: string): Promise<ProjectPayload> => {
    const loaded = await readComp(dir)
    return { dir: resolve(dir), manifest: loaded.manifest, assets: assetsToObject(loaded.assets) }
  })

  // —— 另存为：让用户输入名字，然后把它当目录建出来 ——
  ipcMain.handle('project:pickSave', async (_e, suggested: string): Promise<string | null> => {
    const res = await dialog.showSaveDialog(mainWindow!, {
      title: '另存为 Compositor 项目',
      defaultPath: suggested,
      filters: [{ name: 'Compositor 项目', extensions: ['comp'] }],
      buttonLabel: '保存',
    })
    if (res.canceled || !res.filePath) return null
    const dir = res.filePath.endsWith('.comp') ? res.filePath : `${res.filePath}.comp`
    // showSaveDialog 可能预建了一个空文件，清掉改成目录
    await rm(dir, { force: true, recursive: true }).catch(() => undefined)
    await mkdir(dir, { recursive: true })
    return dir
  })

  ipcMain.handle('project:write', async (_e, payload: ProjectPayload): Promise<{ dir: string }> => {
    const assets = new Map<string, Uint8Array>()
    for (const [k, v] of Object.entries(payload.assets)) {
      assets.set(k, v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBufferLike))
    }
    await writeComp(payload.dir, payload.manifest, assets)
    return { dir: payload.dir }
  })

  // —— 导入图像（返回原始字节，解码交给渲染进程的浏览器能力）——
  ipcMain.handle('images:pick', async (): Promise<{ name: string; bytes: Uint8Array }[]> => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: '导入图像',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '图像', extensions: [...IMAGE_EXTENSIONS, 'psd'] }],
      buttonLabel: '导入',
    })
    if (res.canceled) return []
    const out: { name: string; bytes: Uint8Array }[] = []
    for (const p of res.filePaths) {
      const info = await stat(p)
      if (info.size > LIMITS.maxAssetBytes) continue
      out.push({ name: basename(p), bytes: new Uint8Array(await readFile(p)) })
    }
    return out
  })

  // —— 导出位图 ——
  ipcMain.handle(
    'image:save',
    async (_e, opts: { suggested: string; format: 'png' | 'jpeg'; bytes: Uint8Array }): Promise<string | null> => {
      const ext = opts.format === 'png' ? 'png' : 'jpg'
      const res = await dialog.showSaveDialog(mainWindow!, {
        title: opts.format === 'png' ? '导出 PNG' : '导出 JPEG',
        defaultPath: opts.suggested.endsWith(`.${ext}`) ? opts.suggested : `${opts.suggested}.${ext}`,
        filters: [{ name: opts.format.toUpperCase(), extensions: [ext] }],
        buttonLabel: '导出',
      })
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, opts.bytes)
      return res.filePath
    },
  )

  ipcMain.handle('shell:reveal', async (_e, path: string): Promise<void> => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#1b1d21',
    show: false,
    title: 'Compositor',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // 锁死导航：把文件拖进窗口时，Electron 默认会导航到 file:// 并替换整个页面，
  // 表现为「拖进去完全没反应」甚至白屏。这里明确拒绝一切导航与新窗口。
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    console.warn('[main] 已阻止页面导航：', url)
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 冒烟模式：加载后自检渲染进程是否初始化成功，然后退出。
  // 供 CI / 无人值守环境验证「能真正跑起来」。
  if (process.argv.includes('--smoke')) {
    const win = mainWindow
    const errors: string[] = []
    win.webContents.on('console-message', (event) => {
      const level = (event as unknown as { level?: string | number }).level
      const message = (event as unknown as { message?: string }).message
      const bad = level === 'error' || level === 'warning' || level === 3 || level === 2
      if (bad && message) errors.push(`[控制台] ${message}`)
    })
    win.webContents.on('render-process-gone', (_e, details) => {
      errors.push(`渲染进程退出：${details.reason}`)
    })
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const raw = (await win.webContents.executeJavaScript(
              'JSON.stringify({ready: !!window.__ready, error: window.__initError || null})',
            )) as string
            const parsed = JSON.parse(raw) as { ready: boolean; error: string | null }
            if (parsed.error) errors.push(`初始化异常：${parsed.error.split('\n')[0]}`)
            if (!parsed.ready) errors.push('渲染进程没有完成初始化')
          } catch (err) {
            errors.push(`检查脚本执行失败：${String(err)}`)
          }
          if (errors.length) {
            console.error('[smoke] 失败：')
            for (const e of errors) console.error('  -', e)
            app.exit(1)
          } else {
            console.log('[smoke] 通过：窗口已加载、渲染进程初始化成功、无控制台错误。')
            app.exit(0)
          }
        })()
      }, 3000)
    })
  }

  // 端到端自检：在渲染进程里建项目并写盘，再由主进程读回校验。
  if (process.argv.includes('--e2e')) {
    const win = mainWindow
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          const dir = join(app.getPath('temp'), `compositor-e2e-${Date.now()}.comp`)
          const problems: string[] = []
          try {
            const built = (await win.webContents.executeJavaScript(
              `window.__e2e.buildAndSave(${JSON.stringify(dir)}).then(r => JSON.stringify(r))`,
            )) as string
            console.log('[e2e] 渲染进程建项目结果：', built)

            // 由主进程独立读回（走的是真正的 .comp 解析路径）
            const loaded = await readComp(dir)
            const m = loaded.manifest
            // 「红块」像素图层 + 「反相」调整图层 = 2 个（蒙版不是独立图层）
            if (m.layers.length !== 2) problems.push(`图层数应为 2，实际 ${m.layers.length}`)
            if (m.width !== 64 || m.height !== 48) problems.push(`画布应为 64x48，实际 ${m.width}x${m.height}`)
            if (m.version !== 11) problems.push(`版本应为 11，实际 ${m.version}`)
            const withImage = m.layers.find((l) => l.imageFile)
            if (!withImage) problems.push('没有找到带图片的图层')
            else if (!loaded.assets.has(withImage.imageFile!)) problems.push('图层图片未落盘')
            const withMask = m.layers.find((l) => l.maskFile)
            if (!withMask) problems.push('没有找到带蒙版的图层')
            else if (!loaded.assets.has(withMask.maskFile!)) problems.push('蒙版图片未落盘')
            const adj = m.layers.find((l) => l.adjustment)
            if (!adj) problems.push('没有找到调整图层')
            else if (adj.adjustment!.kind !== 'Invert') problems.push(`调整类型应为 Invert，实际 ${adj.adjustment!.kind}`)

            // —— 导入探针：小图与大图各来一次，验证解码 → 建层 → 渲染全链路 ——
            for (const [w, h] of [
              [8, 8],
              [1600, 1200],
            ] as [number, number][]) {
              const probeRaw = (await win.webContents.executeJavaScript(
                `window.__e2e.importProbe(${w}, ${h}).then(r => JSON.stringify(r))`,
              )) as string
              const probe = JSON.parse(probeRaw) as {
                before: number
                after: number
                file: string | null
                pixel: number[] | null
                ms: number
              }
              console.log(
                `[e2e] 导入 ${w}x${h}：图层 ${probe.before}→${probe.after}，imageFile=${probe.file}，中心像素=${JSON.stringify(probe.pixel)}，耗时 ${probe.ms}ms`,
              )
              if (probe.after !== probe.before + 1) problems.push(`${w}x${h} 导入后图层数未增加`)
              if (!probe.file) problems.push(`${w}x${h} 导入的图层缺少 imageFile`)
              const px = probe.pixel
              if (!px || px[3] === 0) {
                problems.push(`${w}x${h} 导入后合成结果为空白（透明），图片没有被渲染出来`)
              } else if (
                Math.abs(px[0]! - 0) > 16 ||
                Math.abs(px[1]! - 200) > 16 ||
                Math.abs(px[2]! - 83) > 16
              ) {
                problems.push(`${w}x${h} 导入后中心像素不是预期绿色，实际 rgba(${px.join(',')})`)
              }
            }

            // —— 压力探针：导入大图后连续 40 次操作，必须依然流畅 ——
            const stressRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.stressProbe().then(r => JSON.stringify(r))',
            )) as string
            const stress = JSON.parse(stressRaw) as { ms: number }
            console.log(`[e2e] 压力测试：导入 2000x1500 后连续 40 次操作耗时 ${stress.ms}ms`)
            if (stress.ms > 2000) {
              problems.push(`连续操作过慢（${stress.ms}ms），历史很可能仍在整幅拷贝像素`)
            }

            // —— 拖放探针：合成 drop 事件，验证渲染进程侧的导入链路 ——
            const dropRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.dropProbe().then(r => JSON.stringify(r))',
            )) as string
            const drop = JSON.parse(dropRaw) as { before: number; after: number; name: string | null }
            console.log(`[e2e] 拖放探针：图层 ${drop.before}→${drop.after}，新图层名=${drop.name}`)
            if (drop.after !== drop.before + 1) problems.push('拖放的 drop 事件没有生成新图层')
            if (!drop.name) problems.push('拖放生成的图层名称不符合预期')

            // —— 覆盖层探针：模态遮罩与拖放提示层必须真正隐藏 ——
            const overlayRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.overlayProbe().then(r => JSON.stringify(r))',
            )) as string
            const ov = JSON.parse(overlayRaw) as Record<string, string | boolean>
            console.log(`[e2e] 覆盖层探针：${JSON.stringify(ov)}`)
            if (ov['modalVisible'] !== false) {
              problems.push(`模态遮罩仍然可见（display=${ov['modalDisplay']}），会拦掉鼠标操作`)
            }
            if (ov['overlayVisible'] !== false) {
              problems.push(`拖放提示层仍然可见（display=${ov['overlayDisplay']}）`)
            }
            if (ov['hintVisible'] !== false) {
              problems.push(`画布提示仍然可见（display=${ov['hintDisplay']}）`)
            }

            // —— 选区探针：选区轮廓必须真的画到屏幕上 ——
            const selRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.selectionProbe().then(r => JSON.stringify(r))',
            )) as string
            const selp = JSON.parse(selRaw) as { sampled: number; white: number; column: number }
            console.log(
              `[e2e] 选区探针：在选区左边界第 ${selp.column} 列采样 ${selp.sampled} 个像素，其中亮色 ${selp.white} 个`,
            )
            if (selp.sampled === 0) problems.push('选区探针没有采到任何屏幕像素')
            else if (selp.white === 0) problems.push('选区轮廓没有出现在屏幕上')

            // —— 文字探针：新建文字 → 像素被画出 → 改字号后重绘 ——
            const textRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textProbe().then(r => JSON.stringify(r))',
            )) as string
            const tp = JSON.parse(textRaw) as {
              created: boolean
              layerName: string
              hasTextMeta: boolean
              content: string
              canvasSize: string
              opaquePixels: number
              restyled: boolean
            }
            console.log(
              `[e2e] 文字探针：图层「${tp.layerName}」创建=${tp.created}，画布=${tp.canvasSize}，不透明像素=${tp.opaquePixels}，改字号后重绘=${tp.restyled}`,
            )
            if (!tp.created) problems.push('文字图层没有创建成功')
            if (!tp.hasTextMeta) problems.push('文字图层缺少 text 元数据')
            if (tp.opaquePixels === 0) problems.push('文字没有被渲染成像素')
            if (!tp.restyled) problems.push('修改字号后文字没有重绘')

            // —— 图层效果探针：外发光必须真的合成进画面 ——
            const fxRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.effectsProbe().then(r => JSON.stringify(r))',
            )) as string
            const fx = JSON.parse(fxRaw) as {
              inside: number[]
              outsideBefore: number[]
              outsideAfter: number[]
              hasEffect: boolean
              changed: boolean
            }
            console.log(
              `[e2e] 图层效果探针：方块内=${JSON.stringify(fx.inside)} 外侧加效果前=${JSON.stringify(fx.outsideBefore)} 加效果后=${JSON.stringify(fx.outsideAfter)}`,
            )
            if (fx.inside[3] === 0) problems.push('探针的方块图层本身没有被渲染')
            if (!fx.hasEffect) problems.push('外发光参数没有写进图层')
            if (!fx.changed) problems.push('外发光没有被合成到画面里')

            // —— 形状探针：椭圆被画出，且放大后按新尺寸重画 ——
            const shapeRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.shapeProbe().then(r => JSON.stringify(r))',
            )) as string
            const sp = JSON.parse(shapeRaw) as {
              kind: string
              hasShape: boolean
              opaque: number
              resized: boolean
            }
            console.log(
              `[e2e] 形状探针：kind=${sp.kind}，shape 元数据=${sp.hasShape}，不透明像素=${sp.opaque}，放大后重画=${sp.resized}`,
            )
            if (!sp.hasShape) problems.push('形状图层缺少 shape 元数据')
            if (sp.opaque === 0) problems.push('形状没有被渲染成像素')
            if (!sp.resized) problems.push('放大形状后没有按新尺寸重画')

            // —— 参考线探针：参考线必须画到屏幕上 ——
            const guideRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.guideProbe().then(r => JSON.stringify(r))',
            )) as string
            const gp = JSON.parse(guideRaw) as { before: number; after: number }
            console.log(`[e2e] 参考线探针：加参考线前亮青色像素=${gp.before}，加之后=${gp.after}`)
            if (gp.after <= gp.before) problems.push('参考线没有被画到画面上')

            // —— 修图工具探针：四种工具的像素改动量 ——
            const retouchRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.retouchProbe().then(r => JSON.stringify(r))',
            )) as string
            const rt = JSON.parse(retouchRaw) as Record<string, number>
            console.log(`[e2e] 修图探针：改动像素数 ${JSON.stringify(rt)}`)
            for (const name of ['clone', 'heal', 'smudge', 'liquify']) {
              if ((rt[name] ?? 0) === 0) problems.push(`修图工具 ${name} 没有改动任何像素`)
            }
          } catch (err) {
            problems.push(`端到端流程抛错：${String(err)}`)
          } finally {
            await rm(dir, { recursive: true, force: true }).catch(() => undefined)
          }

          if (problems.length) {
            console.error('[e2e] 失败：')
            for (const p of problems) console.error('  -', p)
            app.exit(1)
          } else {
            console.log('[e2e] 通过：建项目 → 写盘 .comp → 主进程读回，图层/蒙版/调整图层均正确。')
            app.exit(0)
          }
        })()
      }, 2500)
    })
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadFile(join(__dirname, '..', 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  registerIPC()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
