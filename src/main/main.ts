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
        { label: '导出 PSD…', click: () => send('file.exportPsd') },
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
        { label: '诊断信息（反馈问题时请附上）', click: () => send('help.diagnostics') },
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

  // —— 导出位图 / PSD ——
  ipcMain.handle(
    'image:save',
    async (
      _e,
      opts: { suggested: string; format: 'png' | 'jpeg' | 'psd'; bytes: Uint8Array },
    ): Promise<string | null> => {
      const ext = opts.format === 'png' ? 'png' : opts.format === 'psd' ? 'psd' : 'jpg'
      const title =
        opts.format === 'png' ? '导出 PNG' : opts.format === 'psd' ? '导出 PSD' : '导出 JPEG'
      const res = await dialog.showSaveDialog(mainWindow!, {
        title,
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

  // —— 枚举系统已安装字体（读注册表，能拿到人类可读的字体名）——
  ipcMain.handle('fonts:list', async (): Promise<string[]> => {
    try {
      const { execFile } = await import('node:child_process')
      // 走 PowerShell 的 InstalledFontCollection：它给出干净的字体族名（如 "Microsoft YaHei"），
      // 并且包含「仅为我安装」的用户级字体 —— 只读 HKLM 会漏掉后者。
      // 两点注意：
      //   1. 必须显式把输出编码设成 UTF-8，否则中文系统上拿到的是 GBK 字节，列表会全是乱码。
      //   2. 不要把注册表路径拼进脚本里，反斜杠在多层转义中极易被吃掉而静默返回空列表。
      const script =
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
        'Add-Type -AssemblyName System.Drawing;' +
        '(New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }'
      const stdout = await new Promise<string>((resolve) => {
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          { maxBuffer: 4 * 1024 * 1024, windowsHide: true },
          (err, out) => resolve(err ? '' : out),
        )
      })
      const names = new Set<string>()
      for (const raw of stdout.split(/\r?\n/)) {
        const name = raw.replace(/^\uFEFF/, '').trim()
        if (name && name.length <= 60) names.add(name)
      }
      return [...names].sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
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
      if (message) console.log(`[renderer:${String(level)}] ${message}`)
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
            // —— 起始页探针：必须最先跑 —— 它会关掉起始页，
            //    而起始页是全屏遮罩，留着会拦掉后面所有真实鼠标点击。
            const wcRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.welcomeProbe().then(r => JSON.stringify(r))',
            )) as string
            const wc = JSON.parse(wcRaw) as Record<string, unknown>
            console.log(
              `[e2e] 起始页：存在=${String(wc['present'])} 标题正确=${String(wc['hasTitle'])} 卡片数=${String(wc['cardCount'])} 卡片=${String(wc['titles'])} 快捷键提示=${String(wc['hasKeys'])}`,
            )
            if (!wc['present']) problems.push('启动时没有显示起始页')
            if (!wc['hasTitle']) problems.push('起始页缺少标题')
            if (Number(wc['cardCount']) !== 3) {
              problems.push(`起始页应有 3 张卡片（新建 / 打开 / 导入），实际 ${String(wc['cardCount'])}`)
            }
            if (!wc['hasKeys']) problems.push('起始页缺少快捷键提示')

            // —— 字重探针：顶栏选择器 + 改字重后宽度变化 ——
            const fwRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.fontWeightProbe().then(r => JSON.stringify(r))',
            )) as string
            const fw = JSON.parse(fwRaw) as Record<string, unknown>
            console.log(
              `[e2e] 字重：顶栏有选择器=${String(fw['hasWeightLabel'])} 选项数=${String(fw['optionCount'])}；常规尺寸=${String(fw['normal'])} → 900 后=${String(fw['bold'])} 数据=${String(fw['weight'])}`,
            )
            if (!fw['hasWeightLabel']) problems.push('文字工具顶栏没有字重选择器')
            if (Number(fw['optionCount']) < 5) {
              problems.push(`字重选择器选项太少（${String(fw['optionCount'])} 个）`)
            }
            if (Number(fw['weight']) !== 900) problems.push('改字重后图层数据没更新')
            if (String(fw['bold']) === String(fw['normal'])) {
              problems.push('改字重后画布上的字形没有任何变化')
            }

            // —— 文字编辑器字号探针：改字号后编辑框必须跟上 ——
            const efRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.editorFontProbe().then(r => JSON.stringify(r))',
            )) as string
            const ef = JSON.parse(efRaw) as Record<string, unknown>
            console.log(
              `[e2e] 编辑器字号：初始=${String(ef['before'])}；改整层字号(96)后=${String(ef['afterWhole'])}；再有选区改(24)后=${String(ef['afterRange'])}；图层字号=${String(ef['layerFontSize'])} 图层尺寸=${String(ef['layerSize'])} 编辑框=${String(ef['taRect'])} 行高 编辑框=${String(ef['taLineHeight'])} 画布=${String(ef['canvasLineHeight'])}`,
            )
            if (String(ef['afterWhole']) === String(ef['before'])) {
              problems.push('改整层字号后编辑框字号没变 —— 光标会按旧字号定位')
            }
            // 只改选中部分的字号后，编辑框应跟随「光标所在字符」的字号，
            // 否则拖选时光标会按全程同一字号计算位置
            if (String(ef['afterRange']) === String(ef['afterWhole'])) {
              problems.push('只改选中部分字号后编辑框字号没跟上 —— 光标无法精准定位')
            }

            // —— 新建项目预设探针：比例预设 + 点击填尺寸 ——
            const npRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.newDocPresetProbe().then(r => JSON.stringify(r))',
            )) as string
            const np = JSON.parse(npRaw) as Record<string, unknown>
            console.log(
              `[e2e] 新建预设：共 ${String(np['count'])} 个（带图标 ${String(np['icons'])}）=${String(np['labels'])}；点 16:9 后尺寸=${String(np['values'])}`,
            )
            if (Number(np['count']) !== 5) {
              problems.push(`新建项目应有 5 个比例预设，实际 ${String(np['count'])} 个`)
            }
            if (Number(np['icons']) !== 5) {
              problems.push('比例预设缺少图标')
            }
            if (String(np['values']) !== '1920|1080') {
              problems.push(`点 16:9 预设没有把尺寸填进输入框（实际 ${String(np['values'])}）`)
            }

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

            // —— 方向探针：屏幕上的图像不能上下颠倒 ——
            const oriRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.orientationProbe().then(r => JSON.stringify(r))',
            )) as string
            const ori = JSON.parse(oriRaw) as {
              screenTop: number[]
              screenBottom: number[]
              compositeTop: number[]
              compositeBottom: number[]
              screenOriented: boolean
              compositeOriented: boolean
            }
            console.log(
              `[e2e] 方向探针：屏幕上半=${JSON.stringify(ori.screenTop)} 下半=${JSON.stringify(ori.screenBottom)}；` +
                `合成上半=${JSON.stringify(ori.compositeTop)} 下半=${JSON.stringify(ori.compositeBottom)}`,
            )
            if (!ori.compositeOriented) problems.push('合成结果的文档坐标方向不对')
            if (!ori.screenOriented) problems.push('屏幕显示上下颠倒')

            // —— 复制图层探针：副本必须与原件逐字节一致 ——
            const dupRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.duplicateProbe().then(r => JSON.stringify(r))',
            )) as string
            const dup = JSON.parse(dupRaw) as {
              identical: boolean
              srcTop: number[]
              copyTop: number[]
              copyBottom: number[]
              copyName: string
            }
            console.log(
              `[e2e] 复制探针：副本名=${dup.copyName}，与原件一致=${dup.identical}，` +
                `原件上=${JSON.stringify(dup.srcTop)} 副本上=${JSON.stringify(dup.copyTop)} 副本下=${JSON.stringify(dup.copyBottom)}`,
            )
            if (!dup.identical) problems.push('复制出的图层像素与原件不一致（翻转或错位）')
            if (!(dup.copyTop[0]! > 180 && dup.copyBottom[2]! > 180)) {
              problems.push('复制出的图层上下方向反了')
            }

            // —— 选区复制探针：只能复制选区内的像素 ——
            const selCopyRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.selectionCopyProbe().then(r => JSON.stringify(r))',
            )) as string
            const sc = JSON.parse(selCopyRaw) as {
              copiedOpaque: number
              copyName: string
              copyCanvas: string
              srcCanvas: string
            }
            console.log(
              `[e2e] 选区复制探针：副本名=${sc.copyName}，复制到 ${sc.copiedOpaque} 个不透明像素（选区内应为 512）`,
            )
            console.log(
              `[e2e] 选区复制探针：原件画布=${sc.srcCanvas}（整层 32×32），副本画布=${sc.copyCanvas}（应裁到选区 16×32）`,
            )
            if (sc.copiedOpaque !== 512) problems.push('Ctrl+J 没有按选区裁剪像素')
            if (sc.copyCanvas === sc.srcCanvas) {
              problems.push('Ctrl+J 没有把副本裁到选区内容大小（框会比内容大出一圈）')
            }

            // —— 缩放探针：抓角手柄后能改变图层尺寸 ——
            const scaleRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.scaleProbe().then(r => JSON.stringify(r))',
            )) as string
            const spx = JSON.parse(scaleRaw) as { hit: string | null; size: number[]; resized: boolean }
            console.log(
              `[e2e] 缩放探针：命中手柄=${spx.hit}，调整后尺寸=${JSON.stringify(spx.size)}，成功=${spx.resized}`,
            )
            if (spx.hit !== 'se') problems.push('没有命中右下角缩放手柄')
            if (!spx.resized) problems.push('拖动角手柄没有改变图层尺寸')

            // —— 导入流程探针（诊断输出，同时断言副本与原件变换一致）——
            const flowRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.importFlowProbe().then(r => JSON.stringify(r))',
            )) as string
            const flow = JSON.parse(flowRaw) as Record<string, Record<string, unknown>>
            console.log(`[e2e] 导入流程：导入后=${JSON.stringify(flow['imported'])}`)
            console.log(`[e2e] 导入流程：缩放后=${JSON.stringify(flow['afterScale'])}`)
            console.log(`[e2e] 导入流程：复制后=${JSON.stringify(flow['copied'])}`)
            const fCopied = flow['copied']!
            const fScaled = flow['afterScale']!
            if (JSON.stringify(fCopied['size']) !== JSON.stringify(fScaled['size'])) {
              problems.push(
                `复制出的图层尺寸与原图层不一致：原件 ${JSON.stringify(fScaled['size'])}，副本 ${JSON.stringify(fCopied['size'])}`,
              )
            }
            if (JSON.stringify(fCopied['origin']) !== JSON.stringify(fScaled['origin'])) {
              problems.push('复制出的图层位置与原图层不一致')
            }

            // —— 移动探针：吸附不应把图层挪出预期位置太远 ——
            const moveRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.moveProbe().then(r => JSON.stringify(r))',
            )) as string
            const mv = JSON.parse(moveRaw) as {
              from: number[]
              to: number[]
              expected: number[]
              drift: number
            }
            console.log(
              `[e2e] 移动探针：从 ${JSON.stringify(mv.from)} 拖到 ${JSON.stringify(mv.to)}，期望 ${JSON.stringify(mv.expected)}（偏差 ${mv.drift.toFixed(2)}）`,
            )
            if (mv.drift > 20) {
              problems.push(`拖动图层时位置偏移过大（${mv.drift.toFixed(1)}），吸附可能过强`)
            }

            // —— 文字包围盒探针：文字不能被画布裁掉 ——
            const tbRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textBoundsProbe().then(r => JSON.stringify(r))',
            )) as string
            const tb = JSON.parse(tbRaw) as {
              size: number[]
              canvas: number[]
              bbox: number[]
              clipped: boolean
            }
            console.log(
              `[e2e] 文字包围盒：transform.size=${JSON.stringify(tb.size)} 画布=${JSON.stringify(tb.canvas)} 文字实际范围=${JSON.stringify(tb.bbox)} 被裁=${tb.clipped}`,
            )
            if (tb.clipped) problems.push('文字被画布裁切了（显示会不完整）')
            if (JSON.stringify(tb.size) !== JSON.stringify(tb.canvas)) {
              problems.push('文字图层的 transform.size 与画布尺寸不一致，变换框会对不上')
            }

            // —— 新建文字探针：点空白新建时不能显示任何字 ——
            const tnRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textNewProbe().then(r => JSON.stringify(r))',
            )) as string
            const tn = JSON.parse(tnRaw) as Record<string, unknown>
            console.log(
              `[e2e] 新建文字：建层后画布=${String(tn['emptyCanvas'])} 不透明像素=${String(tn['emptyOpaque'])}；输入后内容=「${String(tn['typedContent'])}」画布=${String(tn['typedCanvas'])} 不透明像素=${String(tn['typedOpaque'])}`,
            )
            if (Number(tn['emptyOpaque']) !== 0) {
              problems.push('新建文字图层时不该显示任何文字（应当为空）')
            }
            if (Number(tn['typedOpaque']) === 0) {
              problems.push('输入文字后没有渲染出内容')
            }

            // —— 文字编辑器探针：编辑框必须真的可用（够宽、文字透明）——
            const teRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textEditorProbe().then(r => JSON.stringify(r))',
            )) as string
            const te = JSON.parse(teRaw) as Record<string, unknown>
            console.log(
              `[e2e] 文字编辑器：存在=${String(te['exists'])} 尺寸=${String(te['width'])}×${String(te['height'])} 文字色=${String(te['textColor'])} 光标色=${String(te['caretColor'])} 已聚焦=${String(te['focused'])}`,
            )
            if (!te['exists']) {
              problems.push('用文字工具点击画布后没有出现编辑框（文字工具无反应）')
            } else {
              const rawColor = String(te['textColor']).replace(/\s+/g, '')
              const isTransparent =
                rawColor === 'rgba(0,0,0,0)' || rawColor === 'transparent' || /,0\)$/.test(rawColor)
              if (!isTransparent) {
                problems.push(`编辑框里的文字不是透明的（实际 ${rawColor}），会与画布文字重影`)
              }
              if (Number(te['width']) < 100) {
                problems.push(`编辑框宽度只有 ${String(te['width'])}px，窄到看不见`)
              }
              if (!te['focused']) {
                problems.push('编辑框没有获得焦点，无法直接输入')
              }
              if (!te['prevented']) {
                problems.push(
                  '文字工具没有阻止 pointerdown 的默认行为——真实鼠标点击会把焦点抢走，编辑框立刻失焦并删掉空图层（点下去像没反应）',
                )
              }
            }

            // —— 真实鼠标事件下的文字工具 ——
            // 前面的探针都是直接调事件处理函数，绕过了浏览器的默认行为（焦点转移）。
            // 这里用 sendInputEvent 发真实鼠标事件，才能覆盖「点下去没反应」这一类问题。
            const ptRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.prepareTextTool().then(r => JSON.stringify(r))',
            )) as string
            const pt = JSON.parse(ptRaw) as { x: number; y: number }
            win.webContents.sendInputEvent({
              type: 'mouseDown',
              x: pt.x,
              y: pt.y,
              button: 'left',
              clickCount: 1,
            })
            win.webContents.sendInputEvent({
              type: 'mouseUp',
              x: pt.x,
              y: pt.y,
              button: 'left',
              clickCount: 1,
            })
            await new Promise((resolve) => setTimeout(resolve, 180))
            const rsRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textEditorState().then(r => JSON.stringify(r))',
            )) as string
            const rs = JSON.parse(rsRaw) as Record<string, unknown>
            console.log(
              `[e2e] 真实点击文字工具：编辑框=${String(rs['exists'])} 宽=${String(rs['width'])} 焦点=${String(rs['focused'])} 图层数=${String(rs['layers'])}`,
            )
            if (!rs['exists'] || Number(rs['layers']) === 0) {
              problems.push('真实鼠标点击下文字工具没有留下编辑框或图层（点下去没反应）')
            }
            if (rs['exists'] && !rs['focused']) {
              problems.push('真实鼠标点击后编辑框没有保持焦点，用户无法直接输入')
            }

            // —— 文字显示探针：屏幕上必须真的出现文字，且第二次修改也要生效 ——
            const trRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textRenderProbe().then(r => JSON.stringify(r))',
            )) as string
            const tr = JSON.parse(trRaw) as Record<string, unknown>
            console.log(
              `[e2e] 文字显示：空图层白色像素=${String(tr['empty'])}；输入一次=${String(tr['once'])}；再改一次=${String(tr['twice'])}`,
            )
            if (Number(tr['empty']) !== 0) {
              problems.push('空文字图层在屏幕上不该出现白色像素')
            }
            if (Number(tr['once']) === 0) {
              problems.push('输入文字后屏幕上没有显示任何文字（打上字没有显示）')
            }
            if (Number(tr['twice']) <= Number(tr['once'])) {
              problems.push('第二次修改文字后屏幕没有更新（改了没反应）')
            }

            // —— 光标定位探针：在编辑框内点一下，光标必须能移到点到的位置 ——
            const cpRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textCaretProbe().then(r => JSON.stringify(r))',
            )) as string
            const cp = JSON.parse(cpRaw) as Record<string, unknown>
            if (cp['ok']) {
              const cx = Number(cp['x'])
              const cy = Number(cp['y'])
              win.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 })
              win.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 })
              await new Promise((resolve) => setTimeout(resolve, 140))
              const csRaw = (await win.webContents.executeJavaScript(
                'window.__e2e.textCaretState().then(r => JSON.stringify(r))',
              )) as string
              const cs = JSON.parse(csRaw) as Record<string, unknown>
              console.log(
                `[e2e] 文字光标：点击前=${String(cp['before'])} 点击后=${String(cs['selectionStart'])} 长度=${String(cp['length'])} 聚焦=${String(cs['focused'])}`,
              )
              if (Number(cs['selectionStart']) === Number(cp['length'])) {
                problems.push('在编辑框内点击后光标仍停在末尾，无法定位到文字中间')
              }
              if (!cs['focused']) {
                problems.push('在编辑框内点击后编辑框失去了焦点')
              }
            }

            // —— 富文本探针：局部换字体 / 换字号 / 换颜色 ——
            const richRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.richTextProbe().then(r => JSON.stringify(r))',
            )) as string
            const rich = JSON.parse(richRaw) as Record<string, unknown>
            console.log(
              `[e2e] 富文本：原尺寸=${JSON.stringify(rich['plain'])} 换字体=${JSON.stringify(rich['mixedFont'])} 换字号=${JSON.stringify(rich['bigSize'])} 红色像素=${String(rich['redPixels'])} runs=${String(rich['fontRunCount'])}/${String(rich['colorRunCount'])}/${String(rich['sizeRunCount'])}`,
            )
            if (Number(rich['redPixels']) <= 0) {
              problems.push('局部颜色 run 没有生效（画布上没有出现红色像素）')
            }
            const richBig = rich['bigSize'] as unknown as number[]
            const richPlain = rich['plain'] as unknown as number[]
            if (richBig[1]! <= richPlain[1]!) {
              problems.push('局部字号 run 没有生效（图层高度没有变大）')
            }
            if (Number(rich['fontRunCount']) !== 1) {
              problems.push('局部字体 run 没有被记录')
            }

            // —— 渐变纹理探针：纹理本身是否黑→白 ——
            const gtRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.gradientTextureProbe().then(r => JSON.stringify(r))',
            )) as string
            const gt = JSON.parse(gtRaw) as Record<string, unknown>
            console.log(
              `[e2e] 渐变纹理：左=${String(gt['left'])} 中=${String(gt['mid'])} 右=${String(gt['right'])}`,
            )
            if (String(gt['right']).startsWith('0,0,0')) {
              problems.push('渐变纹理右端仍是黑色 —— createLinearGradient 没有生效')
            }

            // —— 描边对话框探针：能添加多个描边 ——
            const sdRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.strokeDialogProbe().then(r => JSON.stringify(r))',
            )) as string
            const sd = JSON.parse(sdRaw) as Record<string, unknown>
            console.log(
              `[e2e] 描边对话框：有列表=${String(sd['hasList'])} 有添加按钮=${String(sd['hasAdd'])} 行数 ${String(sd['before'])}→${String(sd['one'])}→${String(sd['two'])}；首块 大小=${String(sd['hasSize'])} 颜色=${String(sd['hasColor'])} 删除=${String(sd['hasDel'])} 位置=${String(sd['segLabels'])}；数据里 strokes=${String(sd['strokes'])}`,
            )
            if (!sd['hasList'] || !sd['hasAdd']) {
              problems.push('图层效果对话框里没有多描边列表或添加按钮')
            }
            if (Number(sd['two']) <= Number(sd['one']) || Number(sd['one']) <= Number(sd['before'])) {
              problems.push('点「添加描边」没有真的增加一行')
            }
            if (!sd['hasSize'] || !sd['hasColor'] || !sd['hasDel']) {
              problems.push('描边块缺少控件（大小 / 颜色 / 删除）')
            }
            // 位置必须是「外侧 / 内侧」两个可选项，而不是一个「内侧」复选框
            if (Number(sd['segCount']) !== 2 || String(sd['segLabels']) !== '外侧|内侧') {
              problems.push(`描边位置不是「外侧 / 内侧」两个可选项（实际 ${String(sd['segLabels'])}）`)
            }
            if (Number(sd['strokes']) !== 2) {
              problems.push(`添加两个描边后数据里只有 ${String(sd['strokes'])} 个`)
            }

            // —— 多描边探针：同心环 ——
            const msRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.multiStrokeProbe().then(r => JSON.stringify(r))',
            )) as string
            const ms = JSON.parse(msRaw) as Record<string, unknown>
            console.log(
              `[e2e] 多描边：加之前 红=${String(ms['beforeRed'])} 蓝=${String(ms['beforeBlue'])}；加两个描边后 红=${String(ms['redPixels'])} 蓝=${String(ms['bluePixels'])} 数据=${String(ms['effects'])} 诊断=${String(ms['debug'])}`,
            )
            if (Number(ms['redPixels']) <= 0) {
              problems.push('外层描边（红）没有出现')
            }
            if (Number(ms['bluePixels']) <= 0) {
              problems.push('内层描边（蓝）没有出现 —— 多个描边没有叠加')
            }

            // —— 渐变叠加探针：横向渐变应让屏幕左暗右亮 ——
            const goRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.gradientOverlayProbe().then(r => JSON.stringify(r))',
            )) as string
            const go = JSON.parse(goRaw) as Record<string, unknown>
            console.log(
              `[e2e] 渐变叠加：加之前 暗=${String(go['beforeDark'])} 亮=${String(go['beforeLight'])}；加之后 暗=${String(go['afterDark'])} 亮=${String(go['afterLight'])} 新增暗=${String(go['newDark'])} 诊断=${String(go['debug'])}`,
            )
            if (Number(go['newDark']) < 200) {
              problems.push(
                `渐变叠加没有生效（新增暗色像素仅 ${String(go['newDark'])}）`,
              )
            }

            // —— PSD 往返探针：导出再读回必须一致 ——
            const psRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.psdRoundTripProbe().then(r => JSON.stringify(r))',
            )) as string
            const psv = JSON.parse(psRaw) as Record<string, unknown>
            console.log(
              `[e2e] PSD 往返：导出 ${String(psv['exportedBytes'])} 字节；读回 文档=${String(psv['docWidth'])}×${String(psv['docHeight'])} 图层数=${String(psv['layerCount'])} 名=${String(psv['firstName'])} 尺寸=${String(psv['firstWidth'])}×${String(psv['firstHeight'])} 位置=${String(psv['firstX'])},${String(psv['firstY'])} 中心像素=${String(psv['centerPixel'])}`,
            )
            if (Number(psv['exportedBytes']) <= 0) {
              problems.push('导出 PSD 得到的字节为空')
            }
            if (Number(psv['docWidth']) !== 120 || Number(psv['docHeight']) !== 90) {
              problems.push('PSD 读回的文档尺寸与原文档不一致')
            }
            if (Number(psv['layerCount']) !== 1) {
              problems.push(`PSD 读回的图层数不是 1（实际 ${String(psv['layerCount'])}）`)
            }
            if (Number(psv['firstWidth']) !== 40 || Number(psv['firstHeight']) !== 40) {
              problems.push('PSD 读回的图层尺寸与原来不一致')
            }
            if (Number(psv['firstX']) !== 17 || Number(psv['firstY']) !== 23) {
              problems.push('PSD 读回的图层位置与原来不一致')
            }
            if (String(psv['centerPixel']) !== '0,200,80,255') {
              problems.push(`PSD 读回的像素与原来不一致（${String(psv['centerPixel'])}）`)
            }

            // —— 面板定位探针：展开后必须完全落在窗口内 ——
            const pbRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.panelBoundsProbe().then(r => JSON.stringify(r))',
            )) as string
            const pb = JSON.parse(pbRaw) as Record<string, unknown>
            console.log(
              `[e2e] 面板定位：字体面板 右缘=${String(pb['fontRight'])}/窗口${String(pb['fontViewport'])} 超出=${String(pb['fontRightOverflow'])}；颜色面板 右缘=${String(pb['colorRight'])} 超出=${String(pb['colorRightOverflow'])}`,
            )
            for (const key of ['font', 'color']) {
              if (pb[`${key}Ok`] === false) {
                problems.push(`${key} 选择器面板没有找到或没有展开`)
                continue
              }
              if (pb[`${key}RightOverflow`] === true || pb[`${key}LeftOverflow`] === true) {
                problems.push(`${key} 选择器面板超出了窗口边界，会被裁掉`)
              }
            }

            // —— 颜色选择器探针：必须是自绘的 ——
            const cpkRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.colorPickerProbe().then(r => JSON.stringify(r))',
            )) as string
            const cpk = JSON.parse(cpkRaw) as Record<string, unknown>
            console.log(
              `[e2e] 颜色选择器：选项栏里原生颜色控件=${String(cpk['legacyCount'])} 个；自绘 展开=${String(cpk['open'])} 色相条=${String(cpk['hasHue'])} 明度区=${String(cpk['hasSv'])} hex=${String(cpk['hexValue'])}`,
            )
            if (!cpk['ok']) {
              problems.push('没有找到自绘颜色选择器')
            } else {
              if (Number(cpk['legacyCount']) > 0) {
                problems.push('选项栏里仍有原生颜色控件，风格无法统一')
              }
              if (!cpk['open']) problems.push('颜色选择器点击后没有展开')
              if (!cpk['hasHue'] || !cpk['hasSv']) {
                problems.push('颜色选择器缺少色相条或饱和度/明度区域')
              }
              if (!/^#[0-9a-f]{6}$/i.test(String(cpk['hexValue']))) {
                problems.push(`颜色选择器的十六进制输入值不是 #rrggbb（${String(cpk['hexValue'])}）`)
              }
            }

            // —— 选项栏稳定性探针：改样式不能重建选项栏 ——
            const obRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.optionsBarStabilityProbe().then(r => JSON.stringify(r))',
            )) as string
            const ob = JSON.parse(obRaw) as Record<string, unknown>
            console.log(
              `[e2e] 选项栏稳定性：改样式后颜色框还是同一个=${String(ob['colorSame'])}（仍挂在文档上=${String(ob['colorStillConnected'])}），字体按钮同一个=${String(ob['fontBtnSame'])}`,
            )
            if (!ob['colorSame']) {
              problems.push('改样式会重建选项栏，正在拖动的控件被销毁（取色器会立刻关闭）')
            }

            // —— 控件外观探针：滑块与颜色框 ——
            const wgRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.widgetStyleProbe().then(r => JSON.stringify(r))',
            )) as string
            const wg = JSON.parse(wgRaw) as Record<string, unknown>
            console.log(
              `[e2e] 控件外观：滑块 appearance=${String(wg['rangeAppearance'])} 高=${String(wg['rangeHeight'])}；颜色框 padding=${String(wg['colorPadding'])} 边框=${String(wg['colorBorderWidth'])}/${String(wg['colorBorderColor'])}`,
            )
            if (wg['rangeOk'] && String(wg['rangeAppearance']) !== 'none') {
              problems.push('滑块仍是系统默认外观（appearance 不是 none）')
            }
            if (wg['colorOk']) {
              if (String(wg['colorPadding']) !== '0px') {
                problems.push(`颜色框仍带原生内边距（${String(wg['colorPadding'])}），边框会显得很粗`)
              }
              if (String(wg['colorBorderWidth']) !== '1px') {
                problems.push(`颜色框边框宽度是 ${String(wg['colorBorderWidth'])}，应为 1px`)
              }
            }

            // —— 输入框样式探针：不能用浏览器默认外观 ——
            const inpRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.inputStyleProbe().then(r => JSON.stringify(r))',
            )) as string
            const inp = JSON.parse(inpRaw) as Record<string, unknown>
            console.log(
              `[e2e] 输入框样式：高=${String(inp['height'])} 背景=${String(inp['background'])} 边框=${String(inp['borderColor'])} appearance=${String(inp['appearance'])}`,
            )
            if (!inp['ok']) {
              problems.push('选项栏里没有找到数字输入框')
            } else {
              if (String(inp['appearance']) !== 'textfield') {
                problems.push('数字输入框仍带原生上下箭头（appearance 不是 textfield）')
              }
              const bg = String(inp['background']).replace(/\s+/g, '')
              if (/(255,255,255)|(250,250,250)/.test(bg)) {
                problems.push(`数字输入框背景仍是浏览器默认白色（${bg}）`)
              }
              if (String(inp['height']) === 'auto') {
                problems.push('数字输入框没有设置高度，会随浏览器默认尺寸变化')
              }
            }

            // —— 面板探针：文字栏去掉描边、图层面板底部有效果按钮 ——
            const peRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.panelEffectsProbe().then(r => JSON.stringify(r))',
            )) as string
            const pe = JSON.parse(peRaw) as Record<string, unknown>
            console.log(
              `[e2e] 面板布局：文字选项栏含描边=${String(pe['hasTextStroke'])}，图层面板底部有效果按钮=${String(pe['hasEffectsBtn'])}（共 ${String(pe['footCount'])} 个）`,
            )
            if (pe['hasTextStroke']) {
              problems.push('文字工具选项栏里仍然有「描边」控件')
            }
            if (!pe['hasEffectsBtn']) {
              problems.push('图层面板底部没有「图层效果」按钮')
            }

            // —— 图层描边探针：外侧描边必须是实色外扩 ——
            const lsRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.layerStrokeProbe().then(r => JSON.stringify(r))',
            )) as string
            const ls = JSON.parse(lsRaw) as Record<string, unknown>
            console.log(
              `[e2e] 图层描边：加描边前红色像素=${String(ls['beforeStroke'])}，加 6px 描边后=${String(ls['strokePixels'])}，实色占比=${String(ls['opaqueRatio'])}`,
            )
            if (Number(ls['strokePixels']) <= 0) {
              problems.push('图层描边没有画出来')
            }
            if (Number(ls['opaqueRatio']) < 0.5) {
              problems.push(
                `图层描边不是实色外扩（完全不透明占比仅 ${String(ls['opaqueRatio'])}），仍然发散`,
              )
            }

            // —— 选择同步探针：选一次就要立刻显示新字体 ——
            const fsRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.fontPickSyncProbe().then(r => JSON.stringify(r))',
            )) as string
            const fsp = JSON.parse(fsRaw) as Record<string, unknown>
            console.log(
              `[e2e] 字体选择同步：选前=${String(fsp['before'])} → 选中=${String(fsp['picked'])} → 选后显示=${String(fsp['after'])} 同步=${String(fsp['synced'])}`,
            )
            if (!fsp['ok']) {
              problems.push(`字体选择同步探针未就绪：${String(fsp['reason'])}`)
            } else if (!fsp['synced']) {
              problems.push('选择字体后，选择器显示的仍是旧字体（要再选一次才更新）')
            }

            // —— 字体选择器探针：按钮与列表项各自用各自字体 ——
            const ffRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.fontFieldProbe().then(r => JSON.stringify(r))',
            )) as string
            const ff = JSON.parse(ffRaw) as Record<string, unknown>
            const ffSample = (ff['sample'] as string[] | undefined) ?? []
            console.log(
              `[e2e] 字体选择器：展开=${String(ff['open'])} 列表项=${String(ff['rowCount'])} 不同字体数=${String(ff['distinct'])} 按钮=${String(ff['beforeText'])}`,
            )
            for (const line of ffSample) console.log(`[e2e]   行：${line}`)
            if (!ff['ok']) {
              problems.push('没有找到自绘字体选择器')
            } else {
              if (Number(ff['rowCount']) <= 0) problems.push('字体选择器展开后没有任何列表项')
              if (!ff['open']) problems.push('字体选择器点击后没有展开')
              if (Number(ff['distinct']) <= 1) {
                problems.push('字体列表各项没有用各自的字体渲染（全都是同一字体）')
              }
              if (!String(ff['beforeFamily']).includes('"')) {
                problems.push('字体选择器按钮没有设置字体')
              }
            }

            // —— 字体可用性探针：列出「能被选中、但选了其实不生效」的字体 ——
            const fuRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.fontUsabilityProbe().then(r => JSON.stringify(r))',
            )) as string
            const fu = JSON.parse(fuRaw) as Record<string, unknown>
            const fuRows = fu['rows'] as { font: string; width: number; ineffective: boolean }[]
            console.log(
              `[e2e] 字体可用性：下拉框共 ${String(fu['total'])} 项，选了不生效的 ${String(fu['ineffectiveCount'])} 项`,
            )
            for (const row of fuRows.filter((r) => r.ineffective).slice(0, 8)) {
              console.log(`[e2e]   ✗ 无效字体名：${row.font}`)
            }
            if (Number(fu['total']) < 20) {
              problems.push('过滤后字体列表太少（可能把可用字体也滤掉了）')
            }
            if (Number(fu['ineffectiveCount']) > 0) {
              problems.push(
                `字体下拉框里有 ${String(fu['ineffectiveCount'])} 项选了不生效（字体名无法被解析）`,
              )
            }

            // —— 字体替换探针：局部 run 不能挡住整层换字体 ——
            const frRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.fontReplaceProbe().then(r => JSON.stringify(r))',
            )) as string
            const fr = JSON.parse(frRaw) as Record<string, unknown>
            const frBefore = fr['before'] as { fontName?: string; runs?: number }
            const frAfter = fr['after'] as { fontName?: string; runs?: number }
            console.log(
              `[e2e] 字体替换：换前 字体=${String(frBefore?.['fontName'])} 局部run=${String(frBefore?.['runs'])}；换后 字体=${String(frAfter?.['fontName'])} 局部run=${String(frAfter?.['runs'])}`,
            )
            if (frAfter?.['fontName'] !== 'KaiTi') {
              problems.push('改整层字体没有生效')
            }
            if (Number(frAfter?.['runs']) !== 0) {
              problems.push(
                `改整层字体后仍残留 ${String(frAfter?.['runs'])} 个局部字体 run（部分字替换不成功）`,
              )
            }

            // —— 版本号压力探针：连续 20 次改动都必须反映到屏幕 ——
            const vsRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.versionStressProbe().then(r => JSON.stringify(r))',
            )) as string
            const vs = JSON.parse(vsRaw) as Record<string, unknown>
            console.log(
              `[e2e] 版本压力：${String(vs['rounds'])} 轮交替字号，不同结果数=${String(vs['distinct'])}，相邻重复（屏幕未更新）=${String(vs['stuck'])}`,
            )
            if (Number(vs['stuck']) > 0) {
              problems.push(`连续改动中有 ${String(vs['stuck'])} 次屏幕没有更新（渲染没跟上）`)
            }
            if (Number(vs['distinct']) < 2) {
              problems.push('连续改动后屏幕内容没有变化，渲染管线可能卡在旧数据')
            }

            // —— 描边探针：实色外扩，不是发散模糊 ——
            const stRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.textStrokeProbe().then(r => JSON.stringify(r))',
            )) as string
            const st = JSON.parse(stRaw) as Record<string, unknown>
            console.log(
              `[e2e] 文字描边：无描边尺寸=${JSON.stringify(st['plain'])} 加 4px 描边=${JSON.stringify(st['stroked'])} 描边像素=${String(st['redPixels'])} 实色占比=${String(st['opaqueRatio'])} 平均不透明度=${String(st['redAvgAlpha'])}`,
            )
            const stPlain = st['plain'] as unknown as number[]
            const stStroked = st['stroked'] as unknown as number[]
            if (Number(st['redPixels']) <= 0) {
              problems.push('文字描边没有画出来')
            }
            if (stStroked[0]! <= stPlain[0]!) {
              problems.push('加了描边后画布没有变大，描边会被切掉')
            }
            if (Number(st['opaqueRatio']) < 0.5) {
              problems.push(
                `描边不是实色外扩（完全不透明像素占比仅 ${String(st['opaqueRatio'])}），仍然发散`,
              )
            }

            // —— 字体列表探针：不能为空、不能有乱码 ——
            const fontListRaw = (await win.webContents.executeJavaScript(
              'window.compositor.listFonts().then(r => JSON.stringify(r))',
            )) as string
            const fonts = JSON.parse(fontListRaw) as string[]
            const mojibake = fonts.filter((f) => f.includes('\uFFFD')).length
            console.log(
              `[e2e] 字体列表：共 ${fonts.length} 个，乱码 ${mojibake} 个，样例=${fonts.slice(0, 5).join(' / ')}`,
            )
            if (fonts.length < 20) problems.push('系统字体列表太少或为空（读取失败）')
            if (mojibake > 0) problems.push(`字体列表里有 ${mojibake} 项是乱码`)

            // —— 选区样式探针：选中两个字改字体，整层字体不该变、只该多出一个 run ——
            const rs2Raw = (await win.webContents.executeJavaScript(
              'window.__e2e.rangeStyleProbe().then(r => JSON.stringify(r))',
            )) as string
            const rs2 = JSON.parse(rs2Raw) as Record<string, unknown>
            const before = rs2['before'] as { fontName?: string; runs?: number }
            const after = rs2['after'] as { fontName?: string; runs?: number; run?: unknown }
            console.log(
              `[e2e] 选区样式：整层字体 ${String(before?.['fontName'])}→${String(after?.['fontName'])}，run 数 ${String(before?.['runs'])}→${String(after?.['runs'])}，run=${JSON.stringify(after?.['run'])}`,
            )
            if (after?.['fontName'] !== before?.['fontName']) {
              problems.push('选中部分改字体时整层字体也被改了（应当只影响选区）')
            }
            if (Number(after?.['runs']) !== 1) {
              problems.push('选中部分改字体没有写出 fontRuns（只改选区不生效）')
            }

            // —— 框与图片对位探针：变换框必须正好框住图片 ——
            const fvRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.frameVsImageProbe().then(r => JSON.stringify(r))',
            )) as string
            const fv = JSON.parse(fvRaw) as {
              imageBBox: number[]
              frameRect: number[]
              dx: number
              dy: number
              matches: boolean
            }
            console.log(
              `[e2e] 框与图片对位：图片实际=${JSON.stringify(fv.imageBBox.map((v) => Math.round(v)))} 框应为=${JSON.stringify(fv.frameRect.map((v) => Math.round(v)))}（偏差 ${fv.dx.toFixed(1)}, ${fv.dy.toFixed(1)}）`,
            )
            if (!fv.matches) problems.push('变换框与图片的实际渲染位置不重合')

            // —— 自动选择探针：点图片要选中图片图层，而不是压在它上面的空白层 ——
            const asRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.autoSelectProbe().then(r => JSON.stringify(r))',
            )) as string
            const as = JSON.parse(asRaw) as {
              picked: string | null
              blankOnTop: boolean
              missIsNull: boolean
              ok: boolean
            }
            console.log(
              `[e2e] 自动选择：上层空白层=${as.blankOnTop}，点图片选中「${as.picked}」，点空白未选中=${as.missIsNull}`,
            )
            if (!as.ok) problems.push('移动工具的自动选择没有选中图片所在的图层')

            // —— 用户流程探针：拖入 → 选区 → Ctrl+J 后副本不能颠倒 ——
            const ufRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.userFlowProbe().then(r => JSON.stringify(r))',
            )) as string
            const uf = JSON.parse(ufRaw) as Record<string, unknown>
            console.log(`[e2e] 用户流程：原件=${String(uf['srcTransform'])} 画布=${String(uf['srcCanvas'])}`)
            console.log(`[e2e] 用户流程：副本=${String(uf['copyTransform'])} 画布=${String(uf['copyCanvas'])}`)
            console.log(`[e2e] 用户流程：原件颜色序列=${JSON.stringify(uf['srcColumn'])}`)
            console.log(`[e2e] 用户流程：副本颜色序列=${JSON.stringify(uf['copyColumn'])}`)
            {
              const srcCol = uf['srcColumn'] as string[]
              const copyCol = uf['copyColumn'] as string[]
              if (srcCol && copyCol && copyCol.join(',') !== srcCol.join(',')) {
                problems.push(`复制后颜色顺序变了：原件 ${srcCol.join('→')}，副本 ${copyCol.join('→')}`)
              }
            }

            // —— 无选区 JPEG 复制探针：对应「拖入 jpg → 直接 Ctrl+J」——
            const jpgRaw = (await win.webContents.executeJavaScript(
              'window.__e2e.jpegCopyProbe().then(r => JSON.stringify(r))',
            )) as string
            const jp = JSON.parse(jpgRaw) as Record<string, unknown>
            console.log(`[e2e] JPEG复制：原件=${String(jp['srcTransform'])}`)
            console.log(`[e2e] JPEG复制：副本=${String(jp['copyTransform'])} 位置相同=${String(jp['samePosition'])}`)
            console.log(`[e2e] JPEG复制：原件画布列=${JSON.stringify(jp['srcCanvasCol'])}`)
            console.log(`[e2e] JPEG复制：副本画布列=${JSON.stringify(jp['copyCanvasCol'])}`)
            console.log(`[e2e] JPEG复制：屏幕列（上/中/下）=${JSON.stringify(jp['screenCol'])}`)
            {
              const a = jp['srcCanvasCol'] as string[]
              const b = jp['copyCanvasCol'] as string[]
              if (a && b && a.join(',') !== b.join(',')) {
                problems.push(`无选区复制后副本画布方向变了：原件 ${a.join('→')}，副本 ${b.join('→')}`)
              }
              const sc = jp['screenCol'] as string[]
              if (sc) {
                const firstRed = sc.indexOf('红')
                const firstBlue = sc.indexOf('蓝')
                if (firstRed < 0 || firstBlue < 0) {
                  problems.push(`屏幕列里没有同时找到红色与蓝色：${sc.join(',')}`)
                } else if (firstRed > firstBlue) {
                  problems.push(`屏幕上下颠倒：蓝色出现在红色上方（${sc.join(',')}）`)
                }
              }
            }
            console.log(
              `[e2e] JPEG复制：视图 zoom=${await win.webContents.executeJavaScript('window.__app.view.zoom')} panY=${await win.webContents.executeJavaScript('window.__app.view.panY')}`,
            )
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
