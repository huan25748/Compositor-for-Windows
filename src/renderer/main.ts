/**
 * 应用主体：把编辑器状态、GPU 合成器与界面接起来。
 * 画布上的全部工具交互、菜单命令、文件读写都在这里收口。
 */
import { Compositor, type ViewTransform } from './gl/renderer.ts'
import { Editor, bumpPixels, type TextStyle } from './state/editor.ts'
import { FONT_CHOICES, charStyles, fontLabel, sortFonts } from './text.ts'
import { fontPicker, type FontPickerHandle } from './ui/fontpicker.ts'
import { colorPicker } from './ui/colorpicker.ts'
import { createWelcome } from './ui/welcome.ts'
import { exportPsd, importPsd } from './psd.ts'
import { SHAPE_KINDS, type ShapeKind } from './shape.ts'
import { cloneAt, healAt, liquifyAt, smudgeAt } from './retouch.ts'
import { clear, el, field, hexToRgb01, modal, need, numberInput, rgb01ToHex, toast } from './ui/dom.ts'
import { ICONS } from './ui/icons.ts'
import { LayersPanel, PropsPanel, openAdjustmentDialog, openEffectsDialog } from './ui/panels.ts'
import { TOOLS, TOOL_BY_ID, type ToolID } from './ui/tools.ts'
import { createDocument, createPixelLayer } from '../shared/factory.ts'
import { CompFormatError } from '../shared/manifest.ts'
import { LIMITS, type AdjustmentKind, type LayerRecord, type Manifest } from '../shared/types.ts'

interface ProjectPayload {
  dir: string
  manifest: Manifest
  assets: Record<string, Uint8Array>
}

interface CompositorBridge {
  openProject(): Promise<ProjectPayload | null>
  readProject(dir: string): Promise<ProjectPayload>
  pickSavePath(suggested: string): Promise<string | null>
  writeProject(p: ProjectPayload): Promise<{ dir: string }>
  pickImages(): Promise<{ name: string; bytes: Uint8Array }[]>
  saveImage(o: { suggested: string; format: 'png' | 'jpeg' | 'psd'; bytes: Uint8Array }): Promise<string | null>
  reveal(path: string): Promise<void>
  listFonts(): Promise<string[]>
  info(): Promise<{ version: string; electron: string; chrome: string }>
  onMenuCommand(h: (c: string) => void): void
}

declare global {
  interface Window {
    compositor: CompositorBridge
  }
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'pan'; startX: number; startY: number; panX: number; panY: number }
  | { kind: 'move'; id: string; startX: number; startY: number; origin: [number, number] }
  | { kind: 'marquee'; startX: number; startY: number; x: number; y: number; additive: boolean }
  | { kind: 'lasso'; points: [number, number][] }
  | { kind: 'brush'; id: string; lastX: number; lastY: number }
  | { kind: 'crop'; startX: number; startY: number; x: number; y: number }
  | { kind: 'shape'; startX: number; startY: number; x: number; y: number }
  | { kind: 'retouch'; id: string; lastX: number; lastY: number }
  | {
      kind: 'scale'
      id: string
      handle: 'nw' | 'ne' | 'sw' | 'se'
      startX: number
      startY: number
      origin: [number, number]
      size: [number, number]
    }

/** 需要逐笔改写像素的修图工具。 */
type RetouchTool = 'clone' | 'heal' | 'smudge' | 'liquify'

const RETOUCH_LABEL: Record<RetouchTool, string> = {
  clone: '仿制图章',
  heal: '修复画笔',
  smudge: '涂抹',
  liquify: '液化',
}

const isRetouchTool = (id: string): id is RetouchTool => id in RETOUCH_LABEL

class App {
  readonly editor: Editor
  readonly compositor: Compositor
  view: ViewTransform = { zoom: 1, panX: 0, panY: 0 }
  tool: ToolID = 'brush'
  brush = { size: 40, hardness: 0.8, opacity: 1, color: '#ff3b30' }
  /** 文字工具的当前样式：新建文字用它；选中文字图层时改样式会直接应用上去。 */
  textStyle = {
    fontName: 'Microsoft YaHei UI',
    fontSize: 48,
    color: '#ffffff',
    alignment: 'left' as 'left' | 'center' | 'right',
    tracking: 0,
    lineSpacing: 8,
    /** 字重（CSS font-weight）。同一字体族常常打包多种字重，用它来挑。 */
    fontWeight: 400,
    /** 描边：沿字形外缘向外扩一层实色。0 表示不描边。 */
    strokeWidth: 0,
    strokeColor: '#000000',
  }
  wandTolerance = 32
  /** 系统已安装字体（异步载入后替换内置的精简列表）。 */
  private systemFonts: string[] = []
  /** 文字工具当前那个字体选择器（用于就地更新，避免重建选项栏）。 */
  private fontPickerHandle: FontPickerHandle | null = null
  /** 形状工具的当前样式。 */
  shapeStyle = {
    kind: 'rectangle' as ShapeKind,
    color: '#4c8dff',
    cornerRadius: 16,
    lineWidth: 4,
  }
  /**
   * 文档尺寸的选区蒙版（0 或 255）。
   * 用 getter/setter 包一层：任何赋值都会让选区纹理失效并重传，
   * 否则蚂蚁线不会跟着变（选区此前完全不可见的原因之一）。
   */
  private _selectionMask: Uint8ClampedArray | null = null
  private selectionVersion = 0

  get selectionMask(): Uint8ClampedArray | null {
    return this._selectionMask
  }

  set selectionMask(next: Uint8ClampedArray | null) {
    this._selectionMask = next
    this.selectionVersion++
  }
  showGrid = false
  showPixelGrid = true
  /** 仿制图章的源点与偏移（文档坐标）。 */
  cloneSource: [number, number] | null = null
  private cloneOffset: [number, number] | null = null
  /** 网格间距（文档像素）。 */
  gridSpacing = 64
  showRulers = false
  snapEnabled = true
  /** 正在从标尺拖出的参考线。 */
  guideDraft: { axis: 'horizontal' | 'vertical'; position: number } | null = null

  private layersPanel!: LayersPanel
  private propsPanel!: PropsPanel
  private drag: DragMode = { kind: 'none' }
  private spaceDown = false
  private needsRender = true
  private lastStatus = ''
  /** 最近的操作日志（诊断用，最多保留 200 条）。 */
  private opLog: string[] = []
  /** 内部剪贴板：保存图层像素与它的**完整变换**（有选区时只保留选区内）。 */
  private clipboard: ImageData | null = null
  private clipboardTransform: LayerRecord['transform'] | null = null
  /** 标尺的两个 canvas。 */
  private rulerTop: HTMLCanvasElement | null = null
  private rulerLeft: HTMLCanvasElement | null = null
  /** 文字内联编辑器（叠在画布上的 textarea）。 */
  private textEditor: HTMLTextAreaElement | null = null
  private editingTextID: string | null = null
  private textEditOriginal = ''

  constructor() {
    this.editor = new Editor(createDocument(1280, 800))
    const canvas = need<HTMLCanvasElement>('glcanvas')
    this.compositor = new Compositor(canvas, (msg) => toast(msg))
    this.editor.onChange(() => this.invalidate())
    this.editor.onChange(() => this.layersPanel.render())
    this.editor.onChange(() => this.propsPanel.render())
  }

  init(): void {
    this.layersPanel = new LayersPanel(
      need('layerList'),
      need('layerActions'),
      need('layerCount'),
      need<HTMLSelectElement>('blendMode'),
      need<HTMLInputElement>('layerOpacity'),
      this.editor,
      this.editor.pixelStore,
      {
        onSelect: (id, additive) => {
          this.editor.select(id, additive)
          this.logOp(`选中图层 → ${this.describe(this.editor.find(id))}`)
          // 选中不同图层时，选项栏要反映该图层的文字样式
          if (this.tool === 'text') this.buildOptionsBar()
        },
        onToggleVisible: (id) => this.editor.toggleVisible(id),
        onRename: (id, name) => this.editor.rename(id, name),
        onToggleMask: (id) => this.editor.toggleMaskEnabled(id),
        onDrop: (id, target, pos) => this.editor.moveLayer(id, target, pos),
        onAction: (action) => this.panelAction(action),
      },
    )
    this.propsPanel = new PropsPanel(need('propsTitle'), need('propsBody'), this.editor, () => this.invalidate())

    this.buildToolbar()
    this.buildOptionsBar()
    this.installCanvasInput()
    this.installKeyboard()
    this.installDropTarget()
    this.buildRulers()
    void this.loadSystemFonts()
    window.compositor.onMenuCommand((cmd) => void this.handleCommand(cmd))

    this.editor.loadDocument(createDocument(1280, 800), null)
    this.fitToWindow()
    this.layersPanel.render()
    this.propsPanel.render()
    requestAnimationFrame(this.tick)
    void this.showWelcome()
  }

  private invalidate(): void {
    this.needsRender = true
  }

  // —— 渲染 ——

  private tick = (): void => {
    if (this.needsRender) {
      this.needsRender = false
      this.renderFrame()
    }
    // 画布缩放/平移时，让文字内联编辑器跟着走
    if (this.textEditor) this.syncTextEditor()
    if (this.showRulers) this.drawRulers()
    this.updateStatus()
    requestAnimationFrame(this.tick)
  }

  /**
   * 同步渲染一帧。rAF 循环与自检探针共用同一条路径，
   * 这样探针验证到的就是用户真正看到的画面。
   */
  renderFrame(): void {
    const host = need('canvasHost')
    const dpr = window.devicePixelRatio || 1
    if (host.clientWidth > 0 && host.clientHeight > 0) {
      this.compositor.resize(host.clientWidth, host.clientHeight, dpr)
    }

    const doc = this.editor.manifest
    const sel = this._selectionMask
    try {
      this.compositor.render({
        manifest: doc,
        pixels: this.pixelMap(),
        view: this.view,
        selection:
          sel && sel.length === doc.width * doc.height
            ? { mask: sel, width: doc.width, height: doc.height, version: this.selectionVersion }
            : null,
        marqueeRect:
          this.drag.kind === 'crop' || this.drag.kind === 'shape'
            ? dragRectOf(this.drag)
            : null,
        showGrid: this.showGrid,
        showPixelGrid: this.showPixelGrid,
        gridSpacing: this.gridSpacing,
        ...this.guidePayload(doc),
        transformRect: this.transformRectOf(),
      })
    } catch (err) {
      console.error(err)
      toast(`渲染失败：${(err as Error).message}`)
    }
  }

  /** 读回屏幕像素（自检用，必须紧跟 renderFrame 同步调用）。 */
  readScreen(): ImageData {
    const gl = this.compositor.gl
    const w = this.compositor.canvasWidth
    const h = this.compositor.canvasHeight
    const raw = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    const out = new Uint8ClampedArray(w * h * 4)
    const stride = w * 4
    for (let y = 0; y < h; y++) {
      out.set(raw.subarray((h - 1 - y) * stride, (h - 1 - y) * stride + stride), y * stride)
    }
    return new ImageData(out, w, h)
  }

  /** 合成器只认识 LayerPixels 的接口，这里把 PixelStore 转成 Map。 */
  private pixelMap(): Map<string, ReturnType<Editor['pixelStore']['get']> & object> {
    const map = new Map<string, NonNullable<ReturnType<Editor['pixelStore']['get']>>>()
    for (const layer of this.editor.manifest.layers) {
      const px = this.editor.pixelStore.get(layer.id)
      if (px) map.set(layer.id, px)
      const mk = this.editor.pixelStore.get(`${layer.id}:mask`)
      if (mk) map.set(`${layer.id}:mask`, mk)
    }
    return map as never
  }

  /** 当前文档的合成结果（导出、吸管与自检共用同一条路径）。 */
  readComposite(): ImageData {
    return this.compositor.readDocumentPixels(this.editor.manifest, this.pixelMap() as never)
  }

  private updateStatus(): void {
    const doc = this.editor.manifest
    const tool = TOOL_BY_ID.get(this.tool)
    const toolName = tool?.name ?? '未选择工具'
    // 注意：「提示层是否隐藏」不能放进这个提前返回里，
    // 否则画布提示不会随图层数变化而消失。
    if (toolName !== this.lastStatus) {
      this.lastStatus = toolName
      need('statusTool').textContent = toolName
    }
    need('statusZoom').textContent = `${Math.round(this.view.zoom * 100)}%`
    const activeLayer = this.editor.activeLayer
    need('statusDoc').textContent =
      `${doc.width} × ${doc.height} · ${doc.layers.length} 图层` +
      (activeLayer ? ` · 当前：${activeLayer.name}` : '')
    need('canvasHint').hidden = doc.layers.length > 0
  }

  // —— 视图 ——

  private fitToWindow(): void {
    const host = need('canvasHost')
    const doc = this.editor.manifest
    const pad = 48
    const zoom = Math.min((host.clientWidth - pad) / doc.width, (host.clientHeight - pad) / doc.height, 8)
    this.view.zoom = Math.max(0.02, zoom)
    this.view.panX = (host.clientWidth - doc.width * this.view.zoom) / 2
    this.view.panY = (host.clientHeight - doc.height * this.view.zoom) / 2
    this.invalidate()
  }

  private actualPixels(): void {
    const host = need('canvasHost')
    const doc = this.editor.manifest
    this.view.zoom = 1
    this.view.panX = (host.clientWidth - doc.width) / 2
    this.view.panY = (host.clientHeight - doc.height) / 2
    this.invalidate()
  }

  private zoomBy(factor: number, cx?: number, cy?: number): void {
    const host = need('canvasHost')
    const px = cx ?? host.clientWidth / 2
    const py = cy ?? host.clientHeight / 2
    const before = this.view.zoom
    const next = Math.min(32, Math.max(0.02, before * factor))
    if (next === before) return
    // 以指针为锚点缩放
    this.view.panX = px - ((px - this.view.panX) / before) * next
    this.view.panY = py - ((py - this.view.panY) / before) * next
    this.view.zoom = next
    this.invalidate()
  }

  private screenToDoc(clientX: number, clientY: number): [number, number] {
    const host = need('canvasHost')
    const r = host.getBoundingClientRect()
    return [(clientX - r.left - this.view.panX) / this.view.zoom, (clientY - r.top - this.view.panY) / this.view.zoom]
  }

  // —— 界面：工具栏与选项栏 ——

  private buildToolbar(): void {
    const bar = need('toolbar')
    clear(bar)
    for (const t of TOOLS) {
      const btn = el('button', {
        class: `tool-btn${t.id === this.tool ? ' active' : ''}`,
        title: `${t.name}（${t.shortcut}）`,
        html: ICONS[t.icon],
        'data-tool': t.id,
        onClick: () => this.setTool(t.id),
      })
      bar.append(btn)
    }
  }

  private setTool(id: ToolID): void {
    this.tool = id
    document.querySelectorAll('.tool-btn').forEach((n) => {
      n.classList.toggle('active', (n as HTMLElement).dataset['tool'] === id)
    })
    this.buildOptionsBar()
    this.lastStatus = ''
    this.invalidate()
  }

  private buildOptionsBar(): void {
    const bar = need('optionsBar')
    clear(bar)
    // 字体/颜色选择器的面板挂在 body 上（选项栏会裁剪它们），重建时必须一并清掉，
    // 否则每重建一次就多留一个看不见的旧面板。
    for (const stale of document.querySelectorAll(
      'body > .font-picker-panel, body > .color-picker-panel',
    )) {
      stale.remove()
    }
    const tool = TOOL_BY_ID.get(this.tool)
    if (!tool) return

    bar.append(el('span', { class: 'opt-label', text: tool.name }))
    bar.append(el('span', { class: 'divider' }))

    if (tool.id === 'brush' || tool.id === 'eraser') {
      bar.append(el('span', { class: 'opt-label', text: '大小' }))
      const size = numberInput(this.brush.size, { min: 1, max: 2000, step: 1 })
      size.addEventListener('change', () => {
        this.brush.size = Math.max(1, Number(size.value))
        this.invalidate()
      })
      bar.append(size)

      bar.append(el('span', { class: 'opt-label', text: '硬度' }))
      const hardness = el('input', { type: 'range', min: 0, max: 100, value: String(this.brush.hardness * 100) })
      hardness.addEventListener('input', () => {
        this.brush.hardness = Number(hardness.value) / 100
      })
      bar.append(hardness)

      bar.append(el('span', { class: 'opt-label', text: '不透明度' }))
      const opacity = el('input', { type: 'range', min: 1, max: 100, value: String(this.brush.opacity * 100) })
      opacity.addEventListener('input', () => {
        this.brush.opacity = Number(opacity.value) / 100
      })
      bar.append(opacity)

      if (tool.id === 'brush') {
        bar.append(el('span', { class: 'opt-label', text: '颜色' }))
        const color = colorPicker({
          value: this.brush.color,
          onChange: (hex) => {
            this.brush.color = hex
          },
        })
        bar.append(color.root)
      }
    } else if (tool.id === 'wand') {
      bar.append(el('span', { class: 'opt-label', text: '容差' }))
      const tol = numberInput(this.wandTolerance, { min: 0, max: 255, step: 1 })
      tol.addEventListener('change', () => {
        this.wandTolerance = Math.max(0, Math.min(255, Number(tol.value)))
      })
      bar.append(tol)
      bar.append(el('span', { class: 'opt-label', text: '（对当前图层取样）' }))
    } else if (tool.id === 'marquee' || tool.id === 'lasso') {
      bar.append(el('span', { class: 'opt-label', text: '按住 Shift 追加选区' }))
      const clearBtn = el('button', { class: 'btn', text: '取消选择', onClick: () => this.clearSelection() })
      bar.append(clearBtn)
    } else if (tool.id === 'crop') {
      bar.append(el('button', { class: 'btn', text: '裁剪画布', onClick: () => this.applyCropFromSelection() }))
    } else if (tool.id === 'text') {
      const style = this.activeTextStyle()

      // 候选字体：优先用系统字体表（已过滤掉「选了不生效」的名字），否则退回内置精简表。
      // 当前字体不在候选里就补到最前面，避免选择器显示成别的字体。
      const candidates =
        this.systemFonts.length > 0 ? this.systemFonts : FONT_CHOICES.map((f) => f.value)
      const fontOptions = candidates.includes(style.fontName)
        ? candidates
        : [style.fontName, ...candidates]
      const picker = fontPicker({
        fonts: fontOptions,
        value: style.fontName,
        onPick: (name) => this.updateTextStyle({ fontName: name }),
      })
      this.fontPickerHandle = picker
      bar.append(el('span', { class: 'opt-label', text: '字体' }), picker.root)
      // 装了新字体不必重启：点一下重新读一次字体注册表
      bar.append(
        el('button', {
          class: 'btn',
          text: '刷新',
          title: '重新读取系统字体（刚装的字体点这里）',
          onClick: () => void this.loadSystemFonts(),
        }),
      )

      const size = numberInput(style.fontSize, { min: 4, max: 800, step: 1 })
      size.addEventListener('change', () =>
        this.updateTextStyle({ fontSize: Math.max(4, Number(size.value)) }),
      )
      bar.append(el('span', { class: 'opt-label', text: '字号' }), size)

      // 字重：同一字体族常打包多种字重（Thin/Regular/Medium/Bold…），
      // CSS 只能按「族名 + font-weight」去选，所以这里单独给一个选择器。
      const weight = el('select', { class: 'select' })
      for (const [value, label] of [
        [100, '极细'],
        [200, '特细'],
        [300, '细'],
        [400, '常规'],
        [500, '中等'],
        [600, '半粗'],
        [700, '粗'],
        [800, '特粗'],
        [900, '极粗'],
      ] as [number, string][]) {
        weight.append(el('option', { value: String(value), text: `${label} ${value}` }))
      }
      weight.value = String(style.fontWeight ?? 400)
      weight.addEventListener('change', () =>
        this.updateTextStyle({ fontWeight: Number(weight.value) }),
      )
      bar.append(el('span', { class: 'opt-label', text: '字重' }), weight)

      const color = colorPicker({
        value: style.color,
        onChange: (hex) => this.updateTextStyle({ color: hex }),
      })
      bar.append(el('span', { class: 'opt-label', text: '颜色' }), color.root)

      const align = el('select', { class: 'select' })
      align.append(el('option', { value: 'left', text: '左对齐' }))
      align.append(el('option', { value: 'center', text: '居中' }))
      align.append(el('option', { value: 'right', text: '右对齐' }))
      align.value = style.alignment
      align.addEventListener('change', () =>
        this.updateTextStyle({ alignment: align.value as 'left' | 'center' | 'right' }),
      )
      bar.append(el('span', { class: 'opt-label', text: '对齐' }), align)

      const tracking = numberInput(style.tracking, { min: -20, max: 100, step: 0.5 })
      tracking.addEventListener('change', () =>
        this.updateTextStyle({ tracking: Number(tracking.value) }),
      )
      bar.append(el('span', { class: 'opt-label', text: '字距' }), tracking)

      const leading = numberInput(style.lineSpacing, { min: -20, max: 200, step: 1 })
      leading.addEventListener('change', () =>
        this.updateTextStyle({ lineSpacing: Number(leading.value) }),
      )
      bar.append(el('span', { class: 'opt-label', text: '行距' }), leading)
      // 文字描边不再放在这里：描边已归图层效果统一管理（图层面板底部的「图层效果」按钮）。
      // textStroke 字段仍保留，用于读取既有 .comp 文件里的设置。
    } else if (tool.id === 'shape') {
      const kind = el('select', { class: 'select' })
      for (const k of SHAPE_KINDS) kind.append(el('option', { value: k.value, text: k.label }))
      kind.value = this.shapeStyle.kind
      kind.addEventListener('change', () => {
        this.shapeStyle.kind = kind.value as ShapeKind
        this.buildOptionsBar()
      })
      bar.append(el('span', { class: 'opt-label', text: '形状' }), kind)

      const color = colorPicker({
        value: this.shapeStyle.color,
        onChange: (hex) => {
          this.shapeStyle.color = hex
          this.applyShapeStyle()
        },
      })
      bar.append(el('span', { class: 'opt-label', text: '颜色' }), color.root)

      if (this.shapeStyle.kind === 'roundedRectangle') {
        const radius = numberInput(this.shapeStyle.cornerRadius, { min: 0, max: 500, step: 1 })
        radius.addEventListener('change', () => {
          this.shapeStyle.cornerRadius = Math.max(0, Number(radius.value))
          this.applyShapeStyle()
        })
        bar.append(el('span', { class: 'opt-label', text: '圆角' }), radius)
      }
      if (this.shapeStyle.kind === 'line') {
        const lw = numberInput(this.shapeStyle.lineWidth, { min: 1, max: 200, step: 1 })
        lw.addEventListener('change', () => {
          this.shapeStyle.lineWidth = Math.max(1, Number(lw.value))
          this.applyShapeStyle()
        })
        bar.append(el('span', { class: 'opt-label', text: '线宽' }), lw)
      }
    } else if (isRetouchTool(tool.id)) {
      bar.append(el('span', { class: 'opt-label', text: '大小' }))
      const size = numberInput(this.brush.size, { min: 1, max: 2000, step: 1 })
      size.addEventListener('change', () => {
        this.brush.size = Math.max(1, Number(size.value))
      })
      bar.append(size)

      bar.append(el('span', { class: 'opt-label', text: '强度' }))
      const opacity = el('input', {
        type: 'range',
        min: 1,
        max: 100,
        value: String(this.brush.opacity * 100),
      })
      opacity.addEventListener('input', () => {
        this.brush.opacity = Number(opacity.value) / 100
      })
      bar.append(opacity)

      if (tool.id === 'clone') {
        bar.append(
          el('button', {
            class: 'btn',
            text: this.cloneSource ? '重设仿制源点' : 'Alt+点击设置源点',
            onClick: () => {
              this.cloneSource = null
              this.cloneOffset = null
              this.buildOptionsBar()
            },
          }),
        )
      }
    }

    const spacer = el('span', { style: { flex: '1' } })
    bar.append(spacer)
    if (this.selectionMask) {
      bar.append(el('button', { class: 'btn', text: '反选', onClick: () => this.invertSelection() }))
      bar.append(el('button', { class: 'btn', text: '取消选择', onClick: () => this.clearSelection() }))
    }
  }

  // —— 画布交互 ——

  private installCanvasInput(): void {
    const host = need('canvasHost')
    host.addEventListener('pointerdown', (ev) => this.onPointerDown(ev))
    host.addEventListener('pointermove', (ev) => this.onPointerMove(ev))
    host.addEventListener('pointerup', (ev) => this.onPointerUp(ev))
    host.addEventListener('pointercancel', (ev) => this.onPointerUp(ev))
    // 双击文字图层即可再次编辑
    host.addEventListener('dblclick', (ev) => {
      const [dx, dy] = this.screenToDoc(ev.clientX, ev.clientY)
      const hit = this.textLayerAt(dx, dy)
      if (hit) this.openTextEditor(hit.id)
    })
    host.addEventListener('wheel', (ev) => {
      ev.preventDefault()
      const r = host.getBoundingClientRect()
      if (ev.ctrlKey || ev.metaKey) {
        this.zoomBy(ev.deltaY < 0 ? 1.1 : 1 / 1.1, ev.clientX - r.left, ev.clientY - r.top)
      } else {
        this.view.panX -= ev.deltaX
        this.view.panY -= ev.deltaY
        this.invalidate()
      }
    }, { passive: false })
  }

  private onPointerDown(ev: PointerEvent): void {
    // 点在文字编辑框内时，一律交给浏览器处理（定位光标、拖选文本）。
    // 编辑框是画布的子元素，事件会冒泡到这里；若继续走下面的逻辑并
    // preventDefault，用户就没法在文字中间点光标或选中文字。
    if (ev.target instanceof HTMLTextAreaElement) return

    const host = need('canvasHost')
    host.setPointerCapture(ev.pointerId)
    const [dx, dy] = this.screenToDoc(ev.clientX, ev.clientY)
    this.logOp(
      `按下 工具=${this.tool} 位置=(${Math.round(dx)},${Math.round(dy)}) 当前图层=${this.describe(
        this.editor.activeLayer,
      )}`,
    )

    // 空格 / 中键 / 抓手 = 平移
    if (this.spaceDown || ev.button === 1 || this.tool === 'hand') {
      this.drag = { kind: 'pan', startX: ev.clientX, startY: ev.clientY, panX: this.view.panX, panY: this.view.panY }
      host.classList.add('panning')
      return
    }
    if (ev.button !== 0) return

    switch (this.tool) {
      case 'zoom':
        this.zoomBy(ev.altKey ? 1 / 1.4 : 1.4, ev.clientX - host.getBoundingClientRect().left, ev.clientY - host.getBoundingClientRect().top)
        return
      case 'eyedropper':
        this.pickColor(dx, dy)
        return
      case 'move': {
        // 自动选择：**优先保持当前图层**——只有当前图层在点击处是透明的，
        // 才往下层找。否则用户刚选中副本、一点它的透明区域就被切到下层，
        // 拖动时移动的就是别的图层（用户感知为「方向反了」「框和图片不在一起」）。
        if (!ev.shiftKey && !ev.ctrlKey) {
          const current = this.editor.activeLayer
          if (!current || !this.layerHasPixelAt(current, dx, dy)) {
            const hit = this.layerAtDoc(dx, dy)
            if (hit && hit.id !== this.editor.activeLayerID) this.editor.select(hit.id)
          }
        }

        const layer = this.editor.activeLayer
        if (!layer) return
        // 先看是不是抓住了四角手柄：抓住就是缩放，否则是移动
        const handle = this.handleAt(dx, dy, layer)
        if (handle && !layer.isGroup && !layer.adjustment) {
          this.drag = {
            kind: 'scale',
            id: layer.id,
            handle,
            startX: dx,
            startY: dy,
            origin: [...layer.transform.origin] as [number, number],
            size: [...layer.transform.size] as [number, number],
          }
          return
        }
        this.drag = {
          kind: 'move',
          id: layer.id,
          startX: dx,
          startY: dy,
          origin: [...layer.transform.origin] as [number, number],
        }
        return
      }
      case 'marquee':
        this.drag = { kind: 'marquee', startX: dx, startY: dy, x: dx, y: dy, additive: ev.shiftKey }
        return
      case 'lasso':
        this.drag = { kind: 'lasso', points: [[dx, dy]] }
        return
      case 'wand':
        this.magicWand(dx, dy, ev.shiftKey)
        return
      case 'brush':
      case 'eraser': {
        const layer = this.editor.activeLayer
        if (!layer || layer.isGroup || layer.adjustment) {
          toast('请先选择一个像素图层')
          return
        }
        this.editor.edit(
          this.tool === 'brush' ? '画笔' : '擦除',
          () => {
            this.beginStroke(layer.id, dx, dy)
          },
          [layer.id],
        )
        this.drag = { kind: 'brush', id: layer.id, lastX: dx, lastY: dy }
        return
      }
      case 'crop':
        this.drag = { kind: 'crop', startX: dx, startY: dy, x: dx, y: dy }
        return
      case 'shape':
        this.drag = { kind: 'shape', startX: dx, startY: dy, x: dx, y: dy }
        return
      case 'clone':
      case 'heal':
      case 'smudge':
      case 'liquify': {
        const layer = this.editor.activeLayer
        if (!layer || layer.isGroup || layer.adjustment) {
          toast('请先选择一个像素图层')
          return
        }
        if (this.tool === 'clone') {
          // Alt 点击设定仿制源点
          if (ev.altKey) {
            this.cloneSource = [dx, dy]
            this.buildOptionsBar()
            toast('已设置仿制源点')
            return
          }
          if (!this.cloneSource) {
            toast('请先按住 Alt 点击设置仿制源点')
            return
          }
          this.cloneOffset = [this.cloneSource[0] - dx, this.cloneSource[1] - dy]
        }
        const name = RETOUCH_LABEL[this.tool]
        this.editor.edit(
          name,
          () => {
            this.retouchSegment(layer.id, dx, dy, dx, dy)
          },
          [layer.id],
        )
        this.drag = { kind: 'retouch', id: layer.id, lastX: dx, lastY: dy }
        return
      }
      case 'text': {
        // 必须阻止 pointerdown 的默认行为：否则浏览器会把焦点交给画布，
        // 刚打开的编辑框立刻 blur，空图层又被「未输入就删除」的逻辑清掉 ——
        // 表现就是「点下去没反应，也没有图层」。
        ev.preventDefault()
        // 点在已有文字上就继续编辑它，否则新建一个文字图层
        const hit = this.textLayerAt(dx, dy)
        if (hit) {
          this.openTextEditor(hit.id)
          return
        }
        // 用空内容建层：画布极小、不显示任何字，避免「点一下空白就冒出一个
        // 『文字』占位」——那正是你看到的那两个字。用户输入后才会画出真正的文字；
        // 若一直没输入，离开编辑器时会自动删掉这一层。
        const layer = this.editor.addTextLayer('', this.currentTextMeta(), [dx, dy])
        this.openTextEditor(layer.id, true)
        return
      }
    }
  }

  private onPointerMove(ev: PointerEvent): void {
    const [dx, dy] = this.screenToDoc(ev.clientX, ev.clientY)
    switch (this.drag.kind) {
      case 'pan':
        this.view.panX = this.drag.panX + (ev.clientX - this.drag.startX)
        this.view.panY = this.drag.panY + (ev.clientY - this.drag.startY)
        this.invalidate()
        return
      case 'move': {
        const layer = this.editor.find(this.drag.id)
        if (!layer) return
        const nx = this.drag.origin[0] + (dx - this.drag.startX)
        const ny = this.drag.origin[1] + (dy - this.drag.startY)
        layer.transform.origin = [Math.round(this.snap(nx, 'x')), Math.round(this.snap(ny, 'y'))]
        this.invalidate()
        return
      }
      case 'marquee':
        this.drag.x = dx
        this.drag.y = dy
        this.previewMarquee()
        return
      case 'lasso':
        this.drag.points.push([dx, dy])
        this.previewLasso()
        return
      case 'brush': {
        const layer = this.editor.find(this.drag.id)
        if (!layer) return
        this.strokeSegment(this.drag.id, this.drag.lastX, this.drag.lastY, dx, dy)
        this.drag.lastX = dx
        this.drag.lastY = dy
        return
      }
      case 'crop':
        this.drag.x = dx
        this.drag.y = dy
        return
      case 'shape':
        this.drag.x = dx
        this.drag.y = dy
        this.invalidate()
        return
      case 'retouch': {
        this.retouchSegment(this.drag.id, this.drag.lastX, this.drag.lastY, dx, dy)
        this.drag.lastX = dx
        this.drag.lastY = dy
        return
      }
      case 'scale': {
        const layer = this.editor.find(this.drag.id)
        if (!layer) return
        const d = this.drag
        const ddx = dx - d.startX
        const ddy = dy - d.startY
        let w = d.size[0]
        let h = d.size[1]
        let ox = d.origin[0]
        let oy = d.origin[1]

        if (d.handle.includes('e')) w = d.size[0] + ddx
        if (d.handle.includes('s')) h = d.size[1] + ddy
        if (d.handle.includes('w')) {
          w = d.size[0] - ddx
          ox = d.origin[0] + (d.size[0] - w)
        }
        if (d.handle.includes('n')) {
          h = d.size[1] - ddy
          oy = d.origin[1] + (d.size[1] - h)
        }
        w = Math.max(1, w)
        h = Math.max(1, h)

        // 按住 Shift 锁定原始宽高比
        if (ev.shiftKey && d.size[0] > 0 && d.size[1] > 0) {
          const ratio = d.size[0] / d.size[1]
          if (w / h > ratio) w = h * ratio
          else h = w / ratio
          if (d.handle.includes('w')) ox = d.origin[0] + (d.size[0] - w)
          if (d.handle.includes('n')) oy = d.origin[1] + (d.size[1] - h)
        }

        layer.transform.size = [Math.round(w), Math.round(h)]
        layer.transform.origin = [Math.round(this.snap(ox, 'x')), Math.round(this.snap(oy, 'y'))]
        this.invalidate()
        return
      }
      default:
        return
    }
  }

  private onPointerUp(ev: PointerEvent): void {
    const host = need('canvasHost')
    host.classList.remove('panning')
    if (host.hasPointerCapture(ev.pointerId)) host.releasePointerCapture(ev.pointerId)
    const [dx, dy] = this.screenToDoc(ev.clientX, ev.clientY)

    switch (this.drag.kind) {
      case 'move': {
        // 提交这次移动（拖动过程中直接改了 transform，这里落一次历史）
        const layer = this.editor.find(this.drag.id)
        if (layer) {
          const origin = layer.transform.origin
          layer.transform.origin = this.drag.origin
          const target = [Math.round(origin[0]), Math.round(origin[1])] as [number, number]
          this.editor.setTransform(layer.id, { origin: target })
        }
        break
      }
      case 'marquee':
        this.commitMarquee(dx, dy)
        break
      case 'lasso':
        this.commitLasso()
        break
      case 'crop':
        this.commitCrop(dx, dy)
        break
      case 'shape':
        this.commitShape(dx, dy)
        break
      case 'retouch':
        this.editor.pixelStore.touch(this.drag.id)
        this.invalidate()
        break
      case 'scale': {
        const layer = this.editor.find(this.drag.id)
        if (layer) {
          const size = [...layer.transform.size] as [number, number]
          const origin = [...layer.transform.origin] as [number, number]
          // 先把拖动结果撤回原值，再走一次带历史的修改
          layer.transform.size = this.drag.size
          layer.transform.origin = this.drag.origin
          this.editor.setTransform(layer.id, {
            size: [Math.round(size[0]), Math.round(size[1])],
            origin: [Math.round(origin[0]), Math.round(origin[1])],
          })
        }
        break
      }
      case 'brush':
        this.editor.pixelStore.touch(this.drag.id)
        this.invalidate()
        break
      default:
        break
    }
    this.logOp(`松开 kind=${this.drag.kind} 当前图层=${this.describe(this.editor.activeLayer)}`)
    this.drag = { kind: 'none' }
    this.buildOptionsBar()
  }

  private installKeyboard(): void {
    window.addEventListener('keydown', (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement || ev.target instanceof HTMLTextAreaElement) return
      if (ev.code === 'Space') {
        this.spaceDown = true
        need('canvasHost').style.cursor = 'grab'
        return
      }
      if (ev.ctrlKey || ev.metaKey) return
      const key = ev.key.toUpperCase()
      const tool = TOOLS.find((t) => t.shortcut === key)
      if (tool) {
        ev.preventDefault()
        this.setTool(tool.id)
        return
      }
      if (ev.key === '[') {
        this.brush.size = Math.max(1, Math.round(this.brush.size / 1.2))
        this.buildOptionsBar()
      } else if (ev.key === ']') {
        this.brush.size = Math.round(this.brush.size * 1.2)
        this.buildOptionsBar()
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        this.editor.deleteLayers([...this.editor.selection])
      }
    })
    window.addEventListener('keyup', (ev) => {
      if (ev.code === 'Space') {
        this.spaceDown = false
        need('canvasHost').style.cursor = ''
      }
    })
  }

  /**
   * 拖放导入。
   *
   * 绑在 window 而不是画布上：拖到工具栏、面板上同样有效。
   * 只接管「拖的是文件」（dataTransfer.types 含 Files），否则会抢走
   * 图层面板自身的拖拽排序。
   */
  private installDropTarget(): void {
    const overlay = need('dropOverlay')
    const hasFiles = (ev: DragEvent): boolean =>
      Array.from(ev.dataTransfer?.types ?? []).includes('Files')
    const hideOverlay = (): void => {
      overlay.hidden = true
    }

    // 无论如何都不让拖入的文件变成页面导航（这是拖放失效的头号原因）
    window.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      if (hasFiles(ev) && ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
    })

    window.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return
      overlay.hidden = false
    })

    // 这里刻意不用 enter/leave 计数：鼠标在窗口内各元素之间移动会不断触发
    // 这对事件，计数迟早失衡，提示层就会卡在屏幕上。只有指针真正移出
    // 窗口（坐标越界）时才隐藏。
    window.addEventListener('dragleave', (ev) => {
      if (!hasFiles(ev)) return
      const outside =
        ev.clientX <= 0 ||
        ev.clientY <= 0 ||
        ev.clientX >= window.innerWidth ||
        ev.clientY >= window.innerHeight
      if (outside) hideOverlay()
    })

    // 拖拽被取消（例如按 Esc）时也要收尾
    window.addEventListener('dragend', hideOverlay)

    window.addEventListener('drop', (ev) => {
      ev.preventDefault()
      hideOverlay()
      const files = [...(ev.dataTransfer?.files ?? [])]
      if (files.length === 0) return
      void this.handleDroppedFiles(files)
    })
  }

  /** 处理拖入的文件。任何失败都必须让用户看见，绝不能静默。 */
  private async handleDroppedFiles(files: File[]): Promise<void> {
    for (const file of files) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const lower = file.name.toLowerCase()
        if (lower.endsWith('.psd') || lower.endsWith('.psb')) {
          await this.importPSD(file.name, bytes)
        } else {
          await this.importImageBytes(file.name, bytes)
        }
      } catch (err) {
        console.error(err)
        modal({
          title: '导入失败',
          body: [
            el('div', {
              class: 'error-box',
              text: `无法导入「${file.name}」：\n${(err as Error).message}`,
            }),
          ],
          infoOnly: true,
        })
      }
    }
  }

  /** 把参考线（含正在拖出的那一条）整理给渲染器。 */
  private guidePayload(doc: Manifest): {
    guides: { axis: 'horizontal' | 'vertical'; position: number }[]
    activeGuide: number
  } {
    const guides = (doc.guides ?? []).map((g) => ({ axis: g.axis, position: g.position }))
    let active = -1
    if (this.guideDraft) {
      active = guides.length
      guides.push({ axis: this.guideDraft.axis, position: this.guideDraft.position })
    }
    return { guides, activeGuide: active }
  }

  // —— 参考线与吸附 ——

  /** 记一条操作日志（诊断用）。 */
  private logOp(message: string): void {
    const t = new Date()
    const stamp =
      `${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}.` +
      `${String(t.getMilliseconds()).padStart(3, '0')}`
    this.opLog.push(`${stamp} ${message}`)
    if (this.opLog.length > 200) this.opLog.shift()
  }

  /** 图层的一句话摘要。 */
  private describe(layer: LayerRecord | null | undefined): string {
    if (!layer) return '（无）'
    const px = this.editor.pixelStore.get(layer.id)
    return (
      `${layer.name} o=(${Math.round(layer.transform.origin[0])},${Math.round(layer.transform.origin[1])}) ` +
      `s=(${Math.round(layer.transform.size[0])},${Math.round(layer.transform.size[1])}) ` +
      `画布=${px ? `${px.canvas.width}×${px.canvas.height}` : '无'}${layer.isVisible ? '' : ' 隐藏'}`
    )
  }

  /** 列出当前状态，反馈问题时一并提供即可精确定位。 */
  private showDiagnostics(): void {
    const doc = this.editor.manifest
    const lines: string[] = []
    lines.push(`工具：${TOOL_BY_ID.get(this.tool)?.name ?? this.tool}`)
    lines.push(
      `视图：缩放 ${(this.view.zoom * 100).toFixed(1)}%，平移 (${Math.round(this.view.panX)}, ${Math.round(
        this.view.panY,
      )})，像素比 ${window.devicePixelRatio}`,
    )
    lines.push(`画布：${doc.width} × ${doc.height}`)
    lines.push(`选区：${this._selectionMask ? '有' : '无'}　参考线：${doc.guides?.length ?? 0} 条`)
    lines.push('')
    lines.push('图层（自下而上）：')
    doc.layers.forEach((l, i) => {
      const px = this.editor.pixelStore.get(l.id)
      const flags = [
        l.isGroup ? '组' : '',
        l.adjustment ? '调整' : '',
        l.text ? '文字' : '',
        l.shape ? '形状' : '',
        l.imageFile ? '' : '无图',
        l.isVisible ? '' : '隐藏',
        l.id === this.editor.activeLayerID ? '←活动' : '',
      ]
        .filter(Boolean)
        .join(' ')
      lines.push(
        `[${i}] ${l.name}  origin=(${Math.round(l.transform.origin[0])},${Math.round(
          l.transform.origin[1],
        )}) size=(${Math.round(l.transform.size[0])},${Math.round(l.transform.size[1])}) ` +
          `画布=${px ? `${px.canvas.width}×${px.canvas.height}` : '无'} ${flags}`,
      )
    })

    lines.push('')
    lines.push('最近操作（最多 60 条）：')
    for (const line of this.opLog.slice(-60)) lines.push(`  ${line}`)

    // 活动图层的像素采样：上/中/下各三点，用来判断是否上下颠倒
    const active = this.editor.activeLayer
    if (active) {
      const px = this.editor.pixelStore.get(active.id)
      const ctx = px?.canvas.getContext('2d')
      if (px && ctx) {
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        const at = (fx: number, fy: number): string => {
          const x = Math.min(px.canvas.width - 1, Math.floor(px.canvas.width * fx))
          const y = Math.min(px.canvas.height - 1, Math.floor(px.canvas.height * fy))
          const i = (y * px.canvas.width + x) * 4
          const a = img.data[i + 3]!
          return a === 0 ? '透明' : `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`
        }
        lines.push('')
        lines.push(`活动图层像素采样（左/中/右）：`)
        lines.push(`  上：${at(0.2, 0.1)} | ${at(0.5, 0.1)} | ${at(0.8, 0.1)}`)
        lines.push(`  中：${at(0.2, 0.5)} | ${at(0.5, 0.5)} | ${at(0.8, 0.5)}`)
        lines.push(`  下：${at(0.2, 0.9)} | ${at(0.5, 0.9)} | ${at(0.8, 0.9)}`)
      }
    }

    modal({
      title: '诊断信息（可直接截图或复制）',
      body: [el('pre', { class: 'diag', text: lines.join('\n') })],
      confirmLabel: '好',
      infoOnly: true,
    })
  }

  /** 建立/重建标尺（两个 canvas）。 */
  private buildRulers(): void {
    const host = need('rulers')
    clear(host)
    host.hidden = !this.showRulers
    this.rulerTop = null
    this.rulerLeft = null
    if (!this.showRulers) return

    const top = document.createElement('canvas')
    top.className = 'ruler ruler-top'
    const left = document.createElement('canvas')
    left.className = 'ruler ruler-left'
    host.append(top, left)

    // 从标尺拖出来就是新建参考线
    top.addEventListener('pointerdown', (ev) => this.startGuideDrag('horizontal', ev))
    left.addEventListener('pointerdown', (ev) => this.startGuideDrag('vertical', ev))

    this.rulerTop = top
    this.rulerLeft = left
    this.drawRulers()
  }

  /** 按住标尺拖动 → 松开处落下一条参考线。 */
  private startGuideDrag(axis: 'horizontal' | 'vertical', ev: PointerEvent): void {
    ev.preventDefault()
    const move = (e: PointerEvent): void => {
      const [x, y] = this.screenToDoc(e.clientX, e.clientY)
      this.guideDraft = { axis, position: Math.round(axis === 'horizontal' ? y : x) }
      this.invalidate()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const draft = this.guideDraft
      this.guideDraft = null
      if (draft) this.addGuide(draft.axis, draft.position)
      this.invalidate()
    }
    move(ev)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  /** 重画标尺刻度（跟随缩放与平移）。 */
  private drawRulers(): void {
    const top = this.rulerTop
    const left = this.rulerLeft
    if (!this.showRulers || !top || !left) return

    const host = need('canvasHost')
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, host.clientWidth)
    const ch = Math.max(1, host.clientHeight)
    const TOP_H = 20
    const LEFT_W = 20

    if (top.width !== Math.round(cw * dpr) || top.height !== TOP_H) {
      top.width = Math.round(cw * dpr)
      top.height = TOP_H
    }
    if (left.width !== LEFT_W || left.height !== Math.round(ch * dpr)) {
      left.width = LEFT_W
      left.height = Math.round(ch * dpr)
    }
    top.style.width = `${cw - LEFT_W}px`
    top.style.height = `${TOP_H}px`
    top.style.left = `${LEFT_W}px`
    left.style.width = `${LEFT_W}px`
    left.style.height = `${ch - TOP_H}px`
    left.style.top = `${TOP_H}px`

    const zoom = this.view.zoom
    const step = chooseRulerStep(zoom)
    const bg = '#24262b'
    const fg = '#9aa0aa'

    // 顶部标尺
    const ct = top.getContext('2d')
    if (ct) {
      ct.fillStyle = bg
      ct.fillRect(0, 0, top.width, top.height)
      ct.fillStyle = fg
      ct.font = '9px "Microsoft YaHei UI", sans-serif'
      const first = Math.floor(-this.view.panX / zoom / step) * step
      for (let d = first; ; d += step) {
        const sx = (this.view.panX + d * zoom - LEFT_W) * dpr
        if (sx > top.width) break
        if (sx < -60) continue
        ct.fillRect(Math.round(sx), 12, 1, 8)
        ct.fillText(String(Math.round(d)), Math.round(sx) + 2, 10)
      }
    }

    // 左侧标尺（数值竖排）
    const cl = left.getContext('2d')
    if (cl) {
      cl.fillStyle = bg
      cl.fillRect(0, 0, left.width, left.height)
      cl.fillStyle = fg
      cl.font = '9px "Microsoft YaHei UI", sans-serif'
      const first = Math.floor(-this.view.panY / zoom / step) * step
      for (let d = first; ; d += step) {
        const sy = (this.view.panY + d * zoom - TOP_H) * dpr
        if (sy > left.height) break
        if (sy < -60) continue
        cl.fillRect(12, Math.round(sy), 8, 1)
        cl.save()
        cl.translate(9, Math.round(sy) + 2)
        cl.rotate(-Math.PI / 2)
        cl.fillText(String(Math.round(d)), 0, 0)
        cl.restore()
      }
    }
  }

  /** 新建一条参考线（文档坐标）。 */
  private addGuide(axis: 'horizontal' | 'vertical', position: number): void {
    const value = Math.round(position)
    this.editor.edit('新建参考线', () => {
      const doc = this.editor.manifest
      doc.guides = doc.guides ?? []
      doc.guides.push({ id: `guide-${Date.now()}-${doc.guides.length}`, axis, position: value })
    })
  }

  /** 清空全部参考线。 */
  private clearGuides(): void {
    if (!this.editor.manifest.guides?.length) return
    this.editor.edit('清除参考线', () => {
      this.editor.manifest.guides = []
    })
  }

  /**
   * 吸附：把坐标对齐到画布边缘/中心、参考线与网格。
   * 阈值按屏幕像素给（6px），所以缩放后手感一致。
   */
  private snap(value: number, axis: 'x' | 'y'): number {
    if (!this.snapEnabled) return value
    const doc = this.editor.manifest
    const size = axis === 'x' ? doc.width : doc.height
    const targets: number[] = [0, size / 2, size]
    for (const g of doc.guides ?? []) {
      if ((g.axis === 'vertical') === (axis === 'x')) targets.push(g.position)
    }
    if (this.showGrid && this.gridSpacing > 0) {
      targets.push(Math.round(value / this.gridSpacing) * this.gridSpacing)
    }
    // 阈值固定为屏幕 6px；再给一个文档单位上限，
    // 否则视图缩得很小时吸附半径会大到「拖不动」的程度
    const threshold = Math.min(6 / Math.max(this.view.zoom, 0.01), 20)
    let best = value
    let bestDist = threshold
    for (const t of targets) {
      const d = Math.abs(value - t)
      if (d < bestDist) {
        bestDist = d
        best = t
      }
    }
    return best
  }

  // —— 剪贴板 ——

  /** 复制或剪切当前图层的像素；有选区时只作用于选区内。 */
  private copyLayerToClipboard(cut: boolean): void {
    const layer = this.editor.activeLayer
    if (!layer || layer.isGroup || layer.adjustment) {
      toast('请先选择一个像素图层')
      return
    }
    const px = this.editor.pixelStore.get(layer.id)
    if (!px) return
    const ctx = px.canvas.getContext('2d')
    if (!ctx) return

    const doc = this.editor.manifest
    const mask = this._selectionMask
    const usable = Boolean(mask && mask.length === doc.width * doc.height)

    // 复制出去的内容：有选区就只保留选区内
    const image = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
    if (usable) {
      applySelectionMask(image, mask!, doc.width, doc.height, layer.transform, true)
    }
    this.clipboard = image
    this.clipboardTransform = {
      ...layer.transform,
      origin: [...layer.transform.origin] as [number, number],
      size: [...layer.transform.size] as [number, number],
    }

    if (cut) {
      this.editor.edit(
        usable ? '剪切选区内容' : '剪切图层内容',
        () => {
          if (usable) {
            const fresh = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
            applySelectionMask(fresh, mask!, doc.width, doc.height, layer.transform, false)
            ctx.putImageData(fresh, 0, 0)
          } else {
            ctx.clearRect(0, 0, px.canvas.width, px.canvas.height)
          }
          bumpPixels(px)
        },
        [layer.id],
      )
    }
    toast(cut ? (usable ? '已剪切选区内内容' : '已剪切图层内容') : usable ? '已复制选区内内容' : '已复制图层')
  }

  /** 粘贴为新的图层，落回复制时的位置。 */
  private pasteClipboard(): void {
    const clip = this.clipboard
    if (!clip) {
      toast('剪贴板是空的')
      return
    }
    const layer = this.editor.addImageLayer('粘贴', clip)
    // 连尺寸/旋转/翻转一起还原，否则粘贴出来的图层会与复制时不一致
    if (this.clipboardTransform) {
      this.editor.setTransform(layer.id, { ...this.clipboardTransform })
    }
    toast('已粘贴为新图层')
  }

  /** Ctrl+J：通过拷贝新建图层；有选区时只拷贝选区内像素。 */
  private copyToNewLayer(): void {
    const layer = this.editor.activeLayer
    if (!layer || layer.isGroup || layer.adjustment) {
      toast('请先选择一个像素图层')
      return
    }
    const px = this.editor.pixelStore.get(layer.id)
    if (!px) return
    const ctx = px.canvas.getContext('2d')
    if (!ctx) return

    const doc = this.editor.manifest
    const mask = this._selectionMask
    const usable = Boolean(mask && mask.length === doc.width * doc.height)
    let image = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
    if (usable) {
      applySelectionMask(image, mask!, doc.width, doc.height, layer.transform, true)
    }

    const sx = layer.transform.size[0] / Math.max(px.canvas.width, 1)
    const sy = layer.transform.size[1] / Math.max(px.canvas.height, 1)
    let origin: [number, number] = [layer.transform.origin[0], layer.transform.origin[1]]
    let size: [number, number] = [layer.transform.size[0], layer.transform.size[1]]

    if (usable) {
      // 有选区时把副本裁成「内容本身」的大小。
      // 否则副本的框仍是整层大小、而内容只占一角，在画布上就成了
      // 「框在的地方没有图片」——这正是用户看到的现象。
      const box = opaqueBounds(image)
      if (!box) {
        toast('选区里没有可以拷贝的内容')
        return
      }
      const [bx, by, bw, bh] = box
      image = cropImageData(image, box)
      origin = [layer.transform.origin[0] + bx * sx, layer.transform.origin[1] + by * sy]
      size = [bw * sx, bh * sy]
    }

    const copy = this.editor.addImageLayer(`${layer.name} 副本`, image)
    // 必须连尺寸/旋转/翻转一起复制：addImageLayer 是按画布尺寸建层的，
    // 只抄位置的话，缩放过的图层一复制就会缩回原始大小，与原图层错位重叠。
    this.editor.setTransform(copy.id, {
      origin: [Math.round(origin[0]), Math.round(origin[1])],
      size: [Math.round(size[0]), Math.round(size[1])],
      rotation: layer.transform.rotation,
      flipX: layer.transform.flipX,
      flipY: layer.transform.flipY,
      sampling: layer.transform.sampling,
    })
    this.logOp(`Ctrl+J → ${this.describe(copy)}`)
    toast(usable ? '已通过拷贝的图层（仅选区内，已裁到内容大小）' : '已通过拷贝的图层')
  }

  // —— 文字工具 ——

  /**
   * 只保留浏览器真正能用的字体名。
   *
   * 系统报告的字体名常常是「族名 + 字重」（如 `阿里巴巴普惠体 3.0 105 Heavy`），而 CSS/Canvas
   * 需要的是族名。名字对不上时浏览器会**静默回退**到默认字体，于是表现为「选了某个字体却没有任何
   * 变化」。这里逐个实测：先用原名，失败就逐层剥掉尾部的字重/样式词（含纯数字字重）再试，
   * 两者都失败才丢弃。这样列出来的每一项都是真正生效的。
   */
  private async filterUsableFonts(fonts: string[]): Promise<string[]> {
    const ctx = new OffscreenCanvas(1, 1).getContext('2d')
    if (!ctx) return fonts
    const missing = '__no_such_family__'
    const text = '漢字ABCxyz'
    ctx.font = `48px "${missing}", sans-serif`
    const fallback = ctx.measureText(text).width
    /** 与「不存在的族」渲染宽度相同 → 该名字没被解析，浏览器回退了。 */
    const usable = (family: string): boolean => {
      ctx.font = `48px "${family}", "${missing}", sans-serif`
      return ctx.measureText(text).width !== fallback
    }

    // 尾部可能是字重词、纯数字字重，或两者叠加（"… 3.0 105 Heavy"）
    const tail = /\s+(\d+|Thin|ExtraLight|UltraLight|Light|Regular|Book|Medium|SemiBold|DemiBold|Bold|ExtraBold|UltraBold|Black|Heavy|Italic|Oblique|Condensed|Narrow|L[1-9])$/i
    const out = new Set<string>()
    for (const name of fonts) {
      if (usable(name)) {
        out.add(name)
        continue
      }
      let base = name
      for (let i = 0; i < 4; i++) {
        const next = base.replace(tail, '').trim()
        if (!next || next === base) break
        base = next
        if (usable(base)) {
          out.add(base)
          break
        }
      }
    }
    return [...out]
  }

  /** 载入系统已安装字体，替换内置的精简列表。 */
  private async loadSystemFonts(): Promise<void> {
    try {
      const fonts = await window.compositor.listFonts()
      if (fonts.length > 0) {
        this.systemFonts = sortFonts(await this.filterUsableFonts(fonts))
        if (this.tool === 'text') this.buildOptionsBar()
        this.logOp(`已载入 ${fonts.length} 个系统字体`)
      }
    } catch {
      /* 读不到就继续用内置列表 */
    }
  }

  /** 把选项栏上的样式转成官方 text 元数据（RGB 为 0–1）。 */
  /** 当前描边设置（宽度为 0 时不描边）。 */
  private strokeMeta(): { width: number; red: number; green: number; blue: number } | undefined {
    if (this.textStyle.strokeWidth <= 0) return undefined
    const [r, g, b] = hexToRgb01(this.textStyle.strokeColor)
    return { width: this.textStyle.strokeWidth, red: r, green: g, blue: b }
  }

  private currentTextMeta(): TextStyle {
    const [r, g, b] = hexToRgb01(this.textStyle.color)
    const stroke = this.strokeMeta()
    return {
      fontName: this.textStyle.fontName,
      fontSize: this.textStyle.fontSize,
      fontWeight: this.textStyle.fontWeight,
      red: r,
      green: g,
      blue: b,
      alignment: this.textStyle.alignment,
      tracking: this.textStyle.tracking,
      lineSpacing: this.textStyle.lineSpacing,
      ...(stroke ? { textStroke: stroke } : {}),
    }
  }

  /** 命中最上层的可见文字图层。 */
  private textLayerAt(x: number, y: number): LayerRecord | null {
    for (const { layer } of this.editor.flattenForPanel()) {
      if (!layer.text || !layer.isVisible) continue
      const t = layer.transform
      if (
        x >= t.origin[0] &&
        x <= t.origin[0] + t.size[0] &&
        y >= t.origin[1] &&
        y <= t.origin[1] + t.size[1]
      ) {
        return layer
      }
    }
    return null
  }

  /** 在画布上叠一个 textarea 做内联编辑，边输入边重绘图层像素。 */
  /** selectAll 用于刚新建的空文字，方便直接覆盖输入；编辑已有文字时把光标放到末尾。 */
  private openTextEditor(layerID: string, selectAll = false): void {
    const layer = this.editor.find(layerID)
    if (!layer?.text) return
    this.closeTextEditor(false)

    const host = need('canvasHost')
    const ta = document.createElement('textarea')
    ta.className = 'text-editor'
    ta.spellcheck = false
    ta.value = layer.text.content
    host.append(ta)

    this.textEditor = ta
    this.editingTextID = layerID
    this.textEditOriginal = layer.text.content
    this.syncTextEditor()

    ta.addEventListener('input', () => {
      this.editor.previewText(layerID, (t) => {
        t.content = ta.value
      })
    })
    ta.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Escape') {
        ev.preventDefault()
        this.closeTextEditor(true)
      }
    })
    // 延迟一帧再确认失焦：焦点有可能被瞬时抢走又还回来，
    // 立刻提交会把刚建的空图层误删（表现为「点了没反应」）。
    ta.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (this.textEditor !== ta) return
        if (document.activeElement === ta) return
        // 焦点落回选项栏或工具栏时不要关闭编辑器：用户正是要点那里改字体/颜色/字号，
        // 一旦关掉就丢了选中的那段文字，没法再给选区单独设样式。
        const next = document.activeElement
        if (next instanceof Element && next.closest('.options-bar, .toolbar')) return
        this.closeTextEditor(true)
      }, 0)
    })

    // 放到下一帧再聚焦：若 pointerdown 的默认行为发生在 focus() 之后，
    // 会把焦点抢走。与上面的 preventDefault 互为双保险。
    const takeFocus = (): void => {
      if (this.textEditor !== ta) return
      ta.focus()
      if (selectAll) ta.select()
      else ta.setSelectionRange(ta.value.length, ta.value.length)
    }
    takeFocus()
    window.requestAnimationFrame(takeFocus)
  }

  /**
   * 关闭内联编辑器。
   *
   * 输入过程走的是「不进历史」的实时预览，所以提交时要先把内容还原成进入编辑
   * 之前的样子，再走一次带历史的修改 —— 否则历史里记的就已经是新文本，撤销无效。
   */
  private closeTextEditor(commit: boolean): void {
    const ta = this.textEditor
    const id = this.editingTextID
    const original = this.textEditOriginal
    this.textEditor = null
    this.editingTextID = null
    if (ta) ta.remove()
    if (!commit || !id) return

    const layer = this.editor.find(id)
    if (!layer?.text) return
    const value = ta?.value ?? ''

    if (!value.trim()) {
      // 空文字就把这个图层删掉，避免留下看不见的空层
      this.editor.deleteLayers([id])
      this.invalidate()
      return
    }
    layer.text.content = original
    if (value !== original) {
      this.editor.applyText(
        id,
        (t) => {
          t.content = value
        },
        '编辑文字',
      )
    }
    this.invalidate()
  }

  /** 让编辑器跟着画布的缩放与平移走。 */
  private syncTextEditor(): void {
    const ta = this.textEditor
    const id = this.editingTextID
    if (!ta || !id) return
    const layer = this.editor.find(id)
    if (!layer?.text) return
    const t = layer.transform
    const z = this.view.zoom
    ta.style.left = `${this.view.panX + t.origin[0] * z}px`
    ta.style.top = `${this.view.panY + t.origin[1] * z}px`
    // 空文字图层的画布只有 2px 宽，编辑框会窄到看不见（点下去像「没反应」），
    // 所以给一个可用的下限。
    ta.style.width = `${Math.max(240, t.size[0] * z)}px`
    ta.style.height = `${Math.max(t.size[1] * z, layer.text.fontSize * z * 1.4, 28)}px`
    ta.style.fontFamily = `"${layer.text.fontName}", "Microsoft YaHei UI", sans-serif`
    // 编辑框只能有一个字号，但富文本下每个字符的字号可能不同（sizeRuns）。
    // 取「光标所在字符」的字号：这样至少在光标附近，编辑器与画布上的字是对齐的，
    // 拖选时光标才不会按全程同一字号去算位置。整层字号相同时结果与原来一致。
    const styles = charStyles(layer.text)
    const caret = Math.min(Math.max(0, ta.selectionStart), Math.max(0, styles.length - 1))
    const caretSize = styles[caret]?.fontSize ?? layer.text.fontSize
    ta.style.fontSize = `${caretSize * z}px`
    ta.style.lineHeight = `${(caretSize + layer.text.lineSpacing) * z}px`
    // 字重也要带上，否则编辑框的字形宽度与画布不一致，光标同样会对不上
    ta.style.fontWeight = String(styles[caret]?.fontWeight ?? layer.text.fontWeight ?? 400)
    ta.style.textAlign = layer.text.alignment
    ta.style.letterSpacing = `${layer.text.tracking * z}px`
    // 绝对不要在这里设置 color：编辑器里的字必须保持透明（见 styles.css），
    // 用户看到的应当是画布上实时渲染的文字。这里一旦设成图层颜色，
    // 两套字形就会叠在一起——那正是「重影」的来源。
  }

  /** 选项栏显示用的样式：选中文字图层就显示它的，否则显示新建默认值。 */
  private activeTextStyle(): typeof this.textStyle {
    const layer = this.editor.activeLayer
    if (layer?.text) {
      const t = layer.text
      return {
        fontName: t.fontName,
        fontSize: t.fontSize,
        fontWeight: t.fontWeight ?? 400,
        color: rgb01ToHex(t.red, t.green, t.blue),
        alignment: t.alignment,
        tracking: t.tracking,
        lineSpacing: t.lineSpacing,
        strokeWidth: t.textStroke?.width ?? 0,
        strokeColor: t.textStroke
          ? rgb01ToHex(t.textStroke.red, t.textStroke.green, t.textStroke.blue)
          : '#000000',
      }
    }
    return this.textStyle
  }

  /** 改文字样式：有选中的文字图层就应用上去，同时记为下次新建的默认样式。 */
  private updateTextStyle(patch: Partial<typeof this.textStyle>): void {
    this.textStyle = { ...this.textStyle, ...patch }

    // 选项栏的显示来自「当前图层的样式」，所以重建**必须放在应用之后**。
    // 原先在开头重建，读到的是尚未更新的旧值 —— 于是选了新字体，选择栏还显示旧字体，
    // 得再选一次才跟上。用 finally 保证提前 return 的分支也会重建。
    try {
      const layer = this.editor.activeLayer
      if (!layer?.text) return

      // 编辑框里有选区时，只把改动应用到选中的那一段（富文本 run），整层样式保持不变
      // —— 这就是「单独修改选中文字」。
      const ta = this.textEditor
      if (ta && this.editingTextID === layer.id && ta.selectionEnd > ta.selectionStart) {
        this.paintTextRuns(layer.id, ta.selectionStart, ta.selectionEnd - ta.selectionStart, patch)
        return
      }

      const rgb = patch.color ? hexToRgb01(patch.color) : null
      this.editor.applyText(layer.id, (t) => {
        // 改整层样式时，必须清掉对应的局部 run —— 否则被 run 覆盖的那几个字仍用旧值，
        // 看上去就像「部分文字替换不成功」（改了字体，偏偏有几个字纹丝不动）。
        if (patch.fontName !== undefined) {
          t.fontName = patch.fontName
          delete t.fontRuns
        }
        if (patch.fontSize !== undefined) {
          t.fontSize = patch.fontSize
          delete t.sizeRuns
        }
        // 字重是整层的：不清 sizeRuns（那是字号），只改 weight
        if (patch.fontWeight !== undefined) t.fontWeight = patch.fontWeight
        if (patch.alignment !== undefined) t.alignment = patch.alignment
        if (patch.tracking !== undefined) t.tracking = patch.tracking
        if (patch.lineSpacing !== undefined) t.lineSpacing = patch.lineSpacing
        if (patch.strokeWidth !== undefined || patch.strokeColor !== undefined) {
          t.textStroke = this.strokeMeta()
        }
        if (rgb) {
          t.red = rgb[0]
          t.green = rgb[1]
          t.blue = rgb[2]
          delete t.colorRuns
        }
      })
      this.invalidate()
    } finally {
      // 只**就地更新**选项栏，绝不整体重建。
      // 重建（clear + 重新 append）会把用户正在操作的控件从 DOM 里移除：
      // 拖动 <input type="color"> 时原生取色器会立刻关闭、拖动滑块会被打断。
      // 字体选择器的显示改成调它的 setValue()，效果一样但对既有控件零干扰。
      if (patch.fontName !== undefined) this.fontPickerHandle?.setValue(patch.fontName)
    }
  }

  /**
   * 把样式改动写到 [start, start+len) 这段字符上（fontRuns / colorRuns / sizeRuns）。
   * 与这段相交的旧 run 会被裁掉，然后把新 run 并进来。
   */
  private paintTextRuns(
    layerID: string,
    start: number,
    length: number,
    patch: Partial<typeof this.textStyle>,
  ): void {
    const rgb = patch.color ? hexToRgb01(patch.color) : null
    this.editor.applyText(
      layerID,
      (t) => {
        if (patch.fontName !== undefined) {
          const name = patch.fontName
          t.fontRuns = paintRun(t.fontRuns, start, length, (loc, len) => ({
            location: loc,
            length: len,
            fontName: name,
          }))
        }
        if (rgb) {
          const [r0, g0, b0] = rgb
          t.colorRuns = paintRun(t.colorRuns, start, length, (loc, len) => ({
            location: loc,
            length: len,
            red: r0,
            green: g0,
            blue: b0,
          }))
        }
        if (patch.fontSize !== undefined) {
          const size = patch.fontSize
          t.sizeRuns = paintRun(t.sizeRuns, start, length, (loc, len) => ({
            location: loc,
            length: len,
            fontSize: size,
          }))
        }
      },
      '局部文字样式',
    )
    this.invalidate()
  }

  // —— 选区 ——

  private ensureSelectionMask(): Uint8ClampedArray {
    const doc = this.editor.manifest
    if (!this.selectionMask || this.selectionMask.length !== doc.width * doc.height) {
      this.selectionMask = new Uint8ClampedArray(doc.width * doc.height)
    }
    return this.selectionMask
  }

  private previewMarquee(): void {
    if (this.drag.kind !== 'marquee') return
    const m = new Uint8ClampedArray(this.editor.manifest.width * this.editor.manifest.height)
    fillRect(m, this.editor.manifest.width, this.editor.manifest.height, this.drag.startX, this.drag.startY, this.drag.x, this.drag.y)
    this.selectionMask = m
    this.invalidate()
  }

  private commitMarquee(ex: number, ey: number): void {
    if (this.drag.kind !== 'marquee') return
    const m = new Uint8ClampedArray(this.editor.manifest.width * this.editor.manifest.height)
    fillRect(m, this.editor.manifest.width, this.editor.manifest.height, this.drag.startX, this.drag.startY, ex, ey)
    if (this.drag.additive && this.selectionMask) {
      for (let i = 0; i < m.length; i++) m[i] = Math.max(m[i]!, this.selectionMask[i]!)
    }
    this.selectionMask = m
    toast('已建立矩形选区')
    this.invalidate()
  }

  private previewLasso(): void {
    if (this.drag.kind !== 'lasso') return
    const m = new Uint8ClampedArray(this.editor.manifest.width * this.editor.manifest.height)
    fillPolygon(m, this.editor.manifest.width, this.editor.manifest.height, this.drag.points)
    this.selectionMask = m
    this.invalidate()
  }

  private commitLasso(): void {
    if (this.drag.kind !== 'lasso') return
    if (this.drag.points.length < 3) {
      this.selectionMask = null
      toast('套索需要至少三个点')
      this.invalidate()
      return
    }
    this.previewLasso()
    toast('已建立套索选区')
  }

  private clearSelection(): void {
    this.selectionMask = null
    this.buildOptionsBar()
    this.invalidate()
  }

  private invertSelection(): void {
    const m = this.ensureSelectionMask()
    for (let i = 0; i < m.length; i++) m[i] = m[i]! > 127 ? 0 : 255
    // 原地修改不会触发 setter，这里手动让选区纹理失效
    this.selectionVersion++
    this.invalidate()
  }

  /** 魔棒：对当前图层做洪水填充，得到选区。 */
  private magicWand(dx: number, dy: number, additive: boolean): void {
    const layer = this.editor.activeLayer
    if (!layer || layer.isGroup || layer.adjustment) {
      toast('魔棒需要先选中一个像素图层')
      return
    }
    const px = this.editor.pixelStore.get(layer.id)
    if (!px) return
    // 把文档坐标换算到图层本地像素
    const lx = dx - layer.transform.origin[0]
    const ly = dy - layer.transform.origin[1]
    const sx = Math.floor((lx / layer.transform.size[0]) * px.canvas.width)
    const sy = Math.floor((ly / layer.transform.size[1]) * px.canvas.height)
    if (sx < 0 || sy < 0 || sx >= px.canvas.width || sy >= px.canvas.height) {
      toast('请点击图层范围内的像素')
      return
    }
    const ctx = px.canvas.getContext('2d')!
    const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
    const local = floodSelect(img, sx, sy, this.wandTolerance)

    // 映射回文档坐标（MVP：仅在图层未旋转且与文档同尺寸时精确）
    const doc = this.editor.manifest
    const m = additive && this.selectionMask ? this.selectionMask : new Uint8ClampedArray(doc.width * doc.height)
    const sxScale = layer.transform.size[0] / px.canvas.width
    const syScale = layer.transform.size[1] / px.canvas.height
    for (let y = 0; y < px.canvas.height; y++) {
      const docY = Math.round(layer.transform.origin[1] + y * syScale)
      if (docY < 0 || docY >= doc.height) continue
      for (let x = 0; x < px.canvas.width; x++) {
        if (!local[y * px.canvas.width + x]) continue
        const docX = Math.round(layer.transform.origin[0] + x * sxScale)
        if (docX < 0 || docX >= doc.width) continue
        m[docY * doc.width + docX] = 255
      }
    }
    this.selectionMask = m
    toast('魔棒已选取相近颜色区域')
    this.buildOptionsBar()
    this.invalidate()
  }

  // —— 绘画 ——

  /** 把一次落笔记进历史（在 edit() 内调用）。 */
  private beginStroke(id: string, x: number, y: number): void {
    this.strokeSegment(id, x, y, x, y)
  }

  private strokeSegment(id: string, x0: number, y0: number, x1: number, y1: number): void {
    const layer = this.editor.find(id)
    const px = this.editor.pixelStore.get(id)
    if (!layer || !px) return
    const ctx = px.canvas.getContext('2d')!
    const t = layer.transform
    // 文档坐标 -> 图层本地像素
    const toLocal = (x: number, y: number): [number, number] => [
      ((x - t.origin[0]) / t.size[0]) * px.canvas.width,
      ((y - t.origin[1]) / t.size[1]) * px.canvas.height,
    ]
    const [ax, ay] = toLocal(x0, y0)
    const [bx, by] = toLocal(x1, y1)
    // 笔刷直径按文档尺寸给定，换算到图层像素
    const radius = (this.brush.size / 2) * (px.canvas.width / t.size[0])

    ctx.save()
    ctx.globalCompositeOperation = this.tool === 'eraser' ? 'destination-out' : 'source-over'
    ctx.globalAlpha = this.brush.opacity
    const paint = (x: number, y: number): void => {
      const grad = ctx.createRadialGradient(x, y, radius * this.brush.hardness, x, y, radius)
      const color = this.tool === 'eraser' ? '#000' : this.brush.color
      grad.addColorStop(0, color)
      grad.addColorStop(1, this.tool === 'eraser' ? 'rgba(0,0,0,0)' : hexToRgba(this.brush.color, 0))
      ctx.fillStyle = grad
      ctx.beginPath()
      ctx.arc(x, y, radius, 0, Math.PI * 2)
      ctx.fill()
    }
    const dist = Math.hypot(bx - ax, by - ay)
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.25)))
    for (let i = 0; i <= steps; i++) {
      const k = i / steps
      paint(ax + (bx - ax) * k, ay + (by - ay) * k)
    }
    ctx.restore()
    this.showGrid = this.showGrid
    void this.showGrid
    bumpPixels(px)
    this.invalidate()
  }

  /** 修图工具的一小段笔画（全部在图层本地像素空间里做）。 */
  private retouchSegment(id: string, x0: number, y0: number, x1: number, y1: number): void {
    const layer = this.editor.find(id)
    const px = this.editor.pixelStore.get(id)
    if (!layer || !px) return

    const t = layer.transform
    const scaleX = px.canvas.width / Math.max(t.size[0], 1e-6)
    const scaleY = px.canvas.height / Math.max(t.size[1], 1e-6)
    const toLocal = (x: number, y: number): [number, number] => [
      (x - t.origin[0]) * scaleX,
      (y - t.origin[1]) * scaleY,
    ]
    const radius = Math.max(1, (this.brush.size / 2) * scaleX)
    const dist = Math.hypot(x1 - x0, y1 - y0)
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, radius * 0.3)))
    const tool = this.tool as RetouchTool

    for (let i = 1; i <= steps; i++) {
      const k = i / steps
      const prevK = (i - 1) / steps
      const [lx, ly] = toLocal(x0 + (x1 - x0) * k, y0 + (y1 - y0) * k)
      const [plx, ply] = toLocal(x0 + (x1 - x0) * prevK, y0 + (y1 - y0) * prevK)

      switch (tool) {
        case 'clone': {
          if (!this.cloneOffset) return
          cloneAt(
            px.canvas,
            lx,
            ly,
            radius,
            this.cloneOffset[0] * scaleX,
            this.cloneOffset[1] * scaleY,
            this.brush.opacity,
          )
          break
        }
        case 'heal':
          healAt(px.canvas, lx, ly, radius)
          break
        case 'smudge':
          smudgeAt(px.canvas, plx, ply, lx, ly, radius, this.brush.opacity * 0.9)
          break
        case 'liquify':
          liquifyAt(px.canvas, lx, ly, lx - plx, ly - ply, radius, this.brush.opacity * 0.8)
          break
      }
    }
    bumpPixels(px)
    this.invalidate()
  }

  private pickColor(dx: number, dy: number): void {
    const doc = this.editor.manifest
    const sx = Math.floor(dx)
    const sy = Math.floor(dy)
    if (sx < 0 || sy < 0 || sx >= doc.width || sy >= doc.height) return
    const image = this.readComposite()
    const i = (sy * image.width + sx) * 4
    const hex = `#${[image.data[i]!, image.data[i + 1]!, image.data[i + 2]!].map((v) => v.toString(16).padStart(2, '0')).join('')}`
    this.brush.color = hex
    this.buildOptionsBar()
    toast(`已拾取颜色 ${hex}`)
  }

  // —— 裁剪 ——

  private commitCrop(ex: number, ey: number): void {
    if (this.drag.kind !== 'crop') return
    const x0 = Math.max(0, Math.min(this.drag.startX, ex))
    const y0 = Math.max(0, Math.min(this.drag.startY, ey))
    const w = Math.abs(ex - this.drag.startX)
    const h = Math.abs(ey - this.drag.startY)
    if (w < 2 || h < 2) {
      toast('裁剪区域太小')
      return
    }
    this.applyCrop(x0, y0, w, h)
  }

  /** 该图层在文档坐标 (x,y) 处是否有不透明像素。 */
  private layerHasPixelAt(layer: LayerRecord, x: number, y: number): boolean {
    if (layer.isGroup || layer.adjustment || !layer.isVisible) return false
    const px = this.editor.pixelStore.get(layer.id)
    if (!px) return false
    const t = layer.transform
    if (x < t.origin[0] || x > t.origin[0] + t.size[0]) return false
    if (y < t.origin[1] || y > t.origin[1] + t.size[1]) return false
    const lx = Math.floor(((x - t.origin[0]) / Math.max(t.size[0], 1e-6)) * px.canvas.width)
    const ly = Math.floor(((y - t.origin[1]) / Math.max(t.size[1], 1e-6)) * px.canvas.height)
    if (lx < 0 || ly < 0 || lx >= px.canvas.width || ly >= px.canvas.height) return false
    const ctx = px.canvas.getContext('2d')
    if (!ctx) return false
    return (ctx.getImageData(lx, ly, 1, 1).data[3] ?? 0) > 8
  }

  /** 命中最上层「该处确实有像素」的图层（用于移动工具的自动选择）。 */
  private layerAtDoc(x: number, y: number): LayerRecord | null {
    for (const { layer } of this.editor.flattenForPanel()) {
      if (this.layerHasPixelAt(layer, x, y)) return layer
    }
    return null
  }

  /**
   * 命中四角手柄（容差按屏幕像素给，缩放后手感一致）。
   * 取**最近**的那个角：容差范围内可能同时罩住两个角，选错会跳到错误的缩放方向。
   */
  private handleAt(x: number, y: number, layer: LayerRecord): 'nw' | 'ne' | 'sw' | 'se' | null {
    const t = layer.transform
    // 容差取「屏幕 10px」与「图层短边的 1/4」中较小者。
    // 只按 10/zoom 算的话，视图缩小时容差会大到覆盖整个图层——
    // 用户在图层中间按下想拖动，实际抓到的却是角手柄，
    // 而缩放是对角固定的，表现就是「往右拖却往左缩」。
    const screenTol = 10 / Math.max(this.view.zoom, 0.01)
    const sizeLimit = Math.max(2, Math.min(t.size[0], t.size[1]) * 0.25)
    const tol = Math.min(screenTol, sizeLimit)
    const right = t.origin[0] + t.size[0]
    const bottom = t.origin[1] + t.size[1]
    const corners: ['nw' | 'ne' | 'sw' | 'se', number, number][] = [
      ['nw', t.origin[0], t.origin[1]],
      ['ne', right, t.origin[1]],
      ['sw', t.origin[0], bottom],
      ['se', right, bottom],
    ]
    let best: 'nw' | 'ne' | 'sw' | 'se' | null = null
    let bestDist = tol
    for (const [name, cx, cy] of corners) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= bestDist) {
        bestDist = d
        best = name
      }
    }
    return best
  }

  /** 移动工具下要显示变换框的图层矩形（文档坐标）。 */
  private transformRectOf(): [number, number, number, number] | null {
    if (this.tool !== 'move') return null
    const layer = this.editor.activeLayer
    if (!layer) return null
    const t = layer.transform
    return [t.origin[0], t.origin[1], t.size[0], t.size[1]]
  }

  /** 提交一个形状：按拖出的矩形建立形状图层。 */
  private commitShape(ex: number, ey: number): void {
    if (this.drag.kind !== 'shape') return
    const x = Math.min(this.drag.startX, ex)
    const y = Math.min(this.drag.startY, ey)
    const w = Math.abs(ex - this.drag.startX)
    const h = Math.abs(ey - this.drag.startY)
    if (w < 2 || h < 2) {
      toast('形状太小，请拖出一个更大的区域')
      return
    }
    const [r, g, b] = hexToRgb01(this.shapeStyle.color)
    this.editor.addShapeLayer(
      this.shapeStyle.kind,
      {
        red: r,
        green: g,
        blue: b,
        cornerRadius: this.shapeStyle.cornerRadius,
        lineWidth: this.shapeStyle.lineWidth,
      },
      [x, y],
      [w, h],
    )
    this.invalidate()
  }

  /** 把当前样式应用到选中的形状图层（保持可再编辑）。 */
  private applyShapeStyle(): void {
    const layer = this.editor.activeLayer
    if (!layer?.shape) return
    const [r, g, b] = hexToRgb01(this.shapeStyle.color)
    this.editor.applyShape(layer.id, (s) => {
      s.red = r
      s.green = g
      s.blue = b
      if (s.kind === 'roundedRectangle') s.cornerRadius = this.shapeStyle.cornerRadius
      if (s.kind === 'line') s.lineWidth = this.shapeStyle.lineWidth
    })
    this.invalidate()
  }

  private applyCropFromSelection(): void {
    const m = this.selectionMask
    if (!m) {
      toast('请先建立选区再裁剪')
      return
    }
    const doc = this.editor.manifest
    let minX = doc.width
    let minY = doc.height
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < doc.height; y++) {
      for (let x = 0; x < doc.width; x++) {
        if (m[y * doc.width + x]! > 127) {
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) {
      toast('选区为空')
      return
    }
    this.applyCrop(minX, minY, maxX - minX + 1, maxY - minY + 1)
  }

  /** 裁剪画布：保留 [x, y, w, h] 区域。 */
  private applyCrop(x: number, y: number, w: number, h: number): void {
    this.editor.edit('裁剪画布', () => {
      const doc = this.editor.manifest
      for (const layer of doc.layers) {
        layer.transform.origin = [layer.transform.origin[0] - x, layer.transform.origin[1] - y]
      }
      doc.width = Math.max(1, Math.round(w))
      doc.height = Math.max(1, Math.round(h))
      this.selectionMask = null
    })
    this.fitToWindow()
    toast('已裁剪画布')
  }

  // —— 面板与命令 ——

  private panelAction(
    action:
      | 'new'
      | 'newGroup'
      | 'newAdjust'
      | 'effects'
      | 'duplicate'
      | 'delete'
      | 'mask'
      | 'clip'
      | 'up'
      | 'down',
  ): void {
    const active = this.editor.activeLayer
    switch (action) {
      case 'new':
        this.editor.addLayer()
        break
      case 'newGroup':
        this.editor.addGroup()
        break
      case 'newAdjust':
        this.askAdjustmentKind((kind) => this.editor.addAdjustmentLayer(kind))
        break
      case 'duplicate':
        this.editor.duplicateLayers([...this.editor.selection])
        break
      case 'delete':
        this.editor.deleteLayers([...this.editor.selection])
        break
      case 'mask':
        if (active) this.editor.addMask(active.id, true)
        break
      case 'clip':
        if (active) this.editor.toggleClipping(active.id)
        break
      case 'effects': {
        if (!active || active.isGroup || active.adjustment) {
          toast('请先选中一个像素或文字图层')
          break
        }
        openEffectsDialog(this.editor, active, () => {
          this.layersPanel.render()
          this.invalidate()
        })
        break
      }
      case 'up':
        if (active) this.editor.raiseLayer(active.id, false)
        break
      case 'down':
        if (active) this.editor.lowerLayer(active.id, false)
        break
    }
  }

  private askAdjustmentKind(onPick: (kind: AdjustmentKind) => void): void {
    const kinds: AdjustmentKind[] = [
      'Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map',
      'Black & White', 'Color Balance', 'Invert', 'Gaussian Blur', 'Motion Blur',
      'Add Noise', 'Grain',
    ]
    const grid = el('div', { class: 'preset-grid' })
    const close = modal({ title: '新建调整图层', body: [grid], infoOnly: true })
    for (const kind of kinds) {
      grid.append(
        el('button', {
          class: 'preset',
          text: kind,
          onClick: () => {
            close()
            onPick(kind)
          },
        }),
      )
    }
  }

  private async handleCommand(cmd: string): Promise<void> {
    try {
      if (cmd.startsWith('adjust.')) {
        const map: Record<string, AdjustmentKind> = {
          'adjust.hueSaturation': 'Hue/Saturation',
          'adjust.levels': 'Levels',
          'adjust.curves': 'Curves',
          'adjust.exposure': 'Exposure',
          'adjust.gradientMap': 'Gradient Map',
          'adjust.blackWhite': 'Black & White',
          'adjust.colorBalance': 'Color Balance',
          'adjust.invert': 'Invert',
        }
        const kind = map[cmd]
        if (kind) {
          const layer = this.editor.addAdjustmentLayer(kind)
          if (kind !== 'Invert') openAdjustmentDialog(this.editor, layer, () => this.invalidate())
          return
        }
      }
      switch (cmd) {
        // 文件
        case 'file.new':
          return this.askNewDocument()
        case 'file.open':
          return await this.openProject()
        case 'file.save':
          return await this.saveProject(false)
        case 'file.saveAs':
          return await this.saveProject(true)
        case 'file.import':
          return await this.importImages()
        case 'file.exportPsd':
          return await this.exportPSD()
        case 'file.exportPng':
          return await this.exportImage('png')
        case 'file.exportJpeg':
          return await this.exportImage('jpeg')
        case 'file.close':
          this.editor.loadDocument(createDocument(1280, 800), null)
          this.fitToWindow()
          return
        // 编辑
        case 'edit.undo':
          this.editor.undo()
          this.selectionMask = null
          return
        case 'edit.redo':
          this.editor.redo()
          return
        case 'edit.copy':
          return this.copyLayerToClipboard(false)
        case 'edit.cut':
          return this.copyLayerToClipboard(true)
        case 'edit.paste':
          return this.pasteClipboard()
        case 'select.all':
          this.selectionMask = new Uint8ClampedArray(this.editor.manifest.width * this.editor.manifest.height).fill(255)
          this.buildOptionsBar()
          this.invalidate()
          return
        case 'select.none':
          return this.clearSelection()
        case 'select.invert':
          return this.invertSelection()
        // 图层
        case 'layer.new':
          this.editor.addLayer()
          return
        case 'layer.duplicate':
          // Ctrl+J：有选区时只拷贝选区内的像素
          return this.copyToNewLayer()
        case 'layer.delete':
          this.editor.deleteLayers([...this.editor.selection])
          return
        case 'layer.group':
          this.editor.addGroup()
          return
        case 'layer.groupSelected':
          this.editor.groupSelected()
          return
        case 'layer.ungroup':
          this.editor.ungroup([...this.editor.selection])
          return
        case 'layer.addMask': {
          const a = this.editor.activeLayer
          if (a) this.editor.addMask(a.id, true)
          return
        }
        case 'layer.deleteMask': {
          const a = this.editor.activeLayer
          if (a) this.editor.deleteMask(a.id)
          return
        }
        case 'layer.clip': {
          const a = this.editor.activeLayer
          if (a) this.editor.toggleClipping(a.id)
          return
        }
        case 'layer.raise': {
          const a = this.editor.activeLayer
          if (a) this.editor.raiseLayer(a.id, false)
          return
        }
        case 'layer.lower': {
          const a = this.editor.activeLayer
          if (a) this.editor.lowerLayer(a.id, false)
          return
        }
        case 'layer.toTop': {
          const a = this.editor.activeLayer
          if (a) this.editor.raiseLayer(a.id, true)
          return
        }
        case 'layer.toBottom': {
          const a = this.editor.activeLayer
          if (a) this.editor.lowerLayer(a.id, true)
          return
        }
        case 'layer.flipH': {
          const a = this.editor.activeLayer
          if (a) this.editor.flipLayer(a.id, 'x')
          return
        }
        case 'layer.flipV': {
          const a = this.editor.activeLayer
          if (a) this.editor.flipLayer(a.id, 'y')
          return
        }
        case 'canvas.flipH':
          return this.flipCanvas('x')
        case 'canvas.flipV':
          return this.flipCanvas('y')
        // 视图
        case 'view.zoomIn':
          return this.zoomBy(1.25)
        case 'view.zoomOut':
          return this.zoomBy(1 / 1.25)
        case 'view.fit':
          return this.fitToWindow()
        case 'view.actual':
          return this.actualPixels()
        case 'view.toggleGrid':
          this.showGrid = !this.showGrid
          toast(this.showGrid ? '已显示网格' : '已隐藏网格')
          this.invalidate()
          return
        case 'view.togglePixelGrid':
          this.showPixelGrid = !this.showPixelGrid
          toast(this.showPixelGrid ? '已显示像素网格' : '已隐藏像素网格')
          this.invalidate()
          return
        case 'view.toggleRulers':
          this.showRulers = !this.showRulers
          this.buildRulers()
          toast(this.showRulers ? '已显示标尺：从标尺往外拖可创建参考线' : '已隐藏标尺')
          return
        case 'view.clearGuides':
          this.clearGuides()
          toast('已清除参考线')
          return
        case 'help.about':
          return this.showAbout()
        case 'help.diagnostics':
          return this.showDiagnostics()
      }
    } catch (err) {
      const msg = err instanceof CompFormatError ? err.message : (err as Error).message
      modal({ title: '操作失败', body: [el('div', { class: 'error-box', text: msg })], infoOnly: true })
    }
  }

  private flipCanvas(axis: 'x' | 'y'): void {
    this.editor.edit(`翻转画布（${axis === 'x' ? '水平' : '垂直'}）`, () => {
      const doc = this.editor.manifest
      for (const layer of doc.layers) {
        const t = layer.transform
        const cx = doc.width - (t.origin[0] + t.size[0])
        const cy = doc.height - (t.origin[1] + t.size[1])
        if (axis === 'x') {
          t.origin = [cx, t.origin[1]]
          t.flipX = !t.flipX
        } else {
          t.origin = [t.origin[0], cy]
          t.flipY = !t.flipY
        }
      }
    })
  }

  // —— 文件 ——

  /**
   * 新建项目的常用比例预设。
   * 图标是「相同高度、不同宽高比」的框，形状本身就提示了比例，再配文字标签。
   */
  private sizePresets(): { label: string; w: number; h: number; icon: string }[] {
    const box = (x: number, y: number, w: number, h: number, rx = 1.5): string =>
      `<svg viewBox="0 0 24 24"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/></svg>`
    return [
      { label: '1:1', w: 1080, h: 1080, icon: box(5, 5, 14, 14) },
      { label: '4:3', w: 1600, h: 1200, icon: box(4, 6, 16, 12) },
      { label: '3:2', w: 1800, h: 1200, icon: box(3, 6.5, 18, 11) },
      { label: '16:9', w: 1920, h: 1080, icon: box(2.5, 7, 19, 10) },
      { label: '9:16', w: 1080, h: 1920, icon: box(8, 2.5, 8, 19) },
    ]
  }

  private askNewDocument(): void {
    const w = numberInput(1280, { min: 1, max: LIMITS.maxPixelsPerSide })
    const h = numberInput(800, { min: 1, max: LIMITS.maxPixelsPerSide })

    // 预设按钮排：点一下把尺寸填进上面的输入框，用户仍可继续手改
    const presetRow = el('div', { class: 'preset-row' })
    for (const preset of this.sizePresets()) {
      const btn = el('button', {
        class: 'preset-btn',
        title: `${preset.w} × ${preset.h}`,
        onClick: () => {
          w.value = String(preset.w)
          h.value = String(preset.h)
        },
      })
      btn.append(
        el('span', { class: 'preset-icon', html: preset.icon }),
        el('span', { class: 'preset-label', text: preset.label }),
      )
      presetRow.append(btn)
    }

    const fill = el('select')
    fill.append(el('option', { value: 'transparent', text: '透明' }))
    fill.append(el('option', { value: 'white', text: '白色' }))
    fill.append(el('option', { value: 'black', text: '黑色' }))
    modal({
      title: '新建项目',
      body: [
        el('div', { class: 'prop-hint', text: '常用比例' }),
        presetRow,
        el('div', { class: 'prop-hint', text: '或手动输入尺寸' }),
        field('宽度（像素）', w),
        field('高度（像素）', h),
        field('背景', fill),
      ],
      confirmLabel: '创建',
      onConfirm: () => {
        const width = Math.max(1, Math.min(LIMITS.maxPixelsPerSide, Math.round(Number(w.value))))
        const height = Math.max(1, Math.min(LIMITS.maxPixelsPerSide, Math.round(Number(h.value))))
        if (width * height > LIMITS.maxTotalPixels) {
          toast('画布像素总数超出上限（1 亿）')
          return false
        }
        const doc = createDocument(width, height)
        if (fill.value !== 'transparent') {
          const layer = createPixelLayer('背景', 0, 0, width, height)
          layer.imageFile = `${layer.id}.png`
          doc.layers.push(layer)
          doc.activeLayerID = layer.id
          this.editor.loadDocument(doc, null)
          this.editor.pixelStore.create(
            layer.id,
            width,
            height,
            fill.value === 'white' ? '#ffffff' : '#000000',
          )
        } else {
          this.editor.loadDocument(doc, null)
        }
        this.selectionMask = null
        this.fitToWindow()
        return undefined
      },
    })
  }

  private async openProject(): Promise<void> {
    const payload = await window.compositor.openProject()
    if (!payload) return
    await this.loadPayload(payload)
  }

  private async loadPayload(payload: ProjectPayload): Promise<void> {
    const doc = payload.manifest
    this.editor.loadDocument(doc, payload.dir)
    // 解码每个图层的 PNG
    for (const layer of doc.layers) {
      if (layer.imageFile) {
        const bytes = payload.assets[layer.imageFile]
        if (bytes) {
          const image = await decodeImage(bytes)
          if (image) this.editor.pixelStore.createFromImageData(layer.id, image)
        }
      }
      if (layer.maskFile) {
        const bytes = payload.assets[layer.maskFile]
        if (bytes) {
          const image = await decodeImage(bytes)
          if (image) this.editor.pixelStore.createFromImageData(`${layer.id}:mask`, image)
        }
      }
    }
    this.selectionMask = null
    this.fitToWindow()
    toast(`已打开 ${doc.width} × ${doc.height} 的项目`)
  }

  /** 保存；另存为时先选路径。 */
  private async saveProject(saveAs: boolean): Promise<void> {
    const doc = this.editor.manifest
    let dir = this.editor.projectDir
    if (saveAs || !dir) {
      const suggested = `未命名-${doc.width}x${doc.height}.comp`
      dir = await window.compositor.pickSavePath(suggested)
      if (!dir) return
    }
    await this.saveInto(dir)
  }

  /** 把当前文档写到指定目录（「保存」与端到端自检共用同一条代码路径）。 */
  async saveInto(dir: string): Promise<void> {
    const doc = this.editor.manifest
    const assets: Record<string, Uint8Array> = {}
    for (const layer of doc.layers) {
      if (layer.imageFile) {
        const px = this.editor.pixelStore.get(layer.id)
        if (px) assets[layer.imageFile] = await encodePNG(px.canvas)
      }
      if (layer.maskFile) {
        const mk = this.editor.pixelStore.get(`${layer.id}:mask`)
        if (mk) assets[layer.maskFile] = await encodeMaskPNG(mk.canvas)
      }
    }
    doc.activeLayerID = this.editor.activeLayerID ?? undefined
    await window.compositor.writeProject({ dir, manifest: doc, assets })
    this.editor.projectDir = dir
    this.editor.dirty = false
    toast('已保存项目')
  }

  private async importImages(): Promise<void> {
    const files = await window.compositor.pickImages()
    if (files.length === 0) return
    for (const file of files) {
      if (file.name.toLowerCase().endsWith('.psd') || file.name.toLowerCase().endsWith('.psb')) {
        await this.importPSD(file.name, file.bytes)
      } else {
        await this.importImageBytes(file.name, file.bytes)
      }
    }
  }

  private async importImageBytes(name: string, bytes: Uint8Array): Promise<void> {
    const image = await decodeImage(bytes)
    if (!image) {
      toast(`无法解码 ${name}`)
      return
    }
    const layer = this.editor.addImageLayer(name.replace(/\.[^.]+$/, ''), image)
    // 居中摆放
    const doc = this.editor.manifest
    this.editor.setTransform(layer.id, {
      origin: [Math.round((doc.width - image.width) / 2), Math.round((doc.height - image.height) / 2)],
    })
    this.logOp(`导入 ${name}（图片 ${image.width}×${image.height}）→ ${this.describe(layer)}`)
    toast(`已导入 ${name}`)
  }

  /** PSD/PSB：按合成预览导入为一个图层（分层解析不在 MVP 范围内）。 */
  /**
   * 读取分层 PSD，把每个像素图层建成一个图层。
   *
   * 支持范围见 `psd.ts` 的说明（分层 RGB 子集）。PSD 里的组、蒙版、图层效果、
   * 文字/形状的可编辑性都不保留 —— 写出时它们本来就是光栅。
   */
  private async importPSD(name: string, bytes: Uint8Array): Promise<void> {
    let parsed: ReturnType<typeof importPsd>
    try {
      // Uint8Array 可能只是底层 buffer 的一段，必须按 offset/length 切出准确范围
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
      parsed = importPsd(buf)
    } catch (err) {
      modal({
        title: '无法读取该 PSD',
        body: [
          el('div', {
            class: 'error-box',
            text: `读取「${name}」时出错：\n${(err as Error).message}\n\n当前版本支持分层 RGB 的 PSD；CMYK、16 位或带图层蒙版的复杂文件可能读不了。`,
          }),
        ],
        infoOnly: true,
      })
      return
    }

    if (parsed.layers.length === 0) {
      // 只有合成图、没有可用像素图层时，退回浏览器解码（至少能把画面带进来）
      await this.importImageBytes(name, bytes)
      return
    }

    // 尺寸不一致就按 PSD 新建文档；一致则并入当前文档
    const doc = this.editor.manifest
    if (doc.width !== parsed.width || doc.height !== parsed.height) {
      this.editor.replaceDocument(createDocument(parsed.width, parsed.height))
      this.fitToWindow()
    }

    for (const item of parsed.layers) {
      const layer = this.editor.addImageLayer(item.name, item.image)
      this.editor.edit('导入 PSD 图层', () => {
        layer.transform.origin = [item.x, item.y]
        layer.transform.size = [item.image.width, item.image.height]
        layer.opacity = item.opacity
        layer.isVisible = item.visible
        layer.blendMode = item.blendMode
      })
    }
    this.invalidate()
    this.layersPanel.render()
    this.propsPanel.render()
    toast(`已导入 ${name}：${parsed.layers.length} 个图层`)
  }

  /** 把当前文档导出为分层 PSD。 */
  private async exportPSD(): Promise<void> {
    let bytes: Uint8Array
    try {
      bytes = exportPsd(this.editor.manifest, (id) => this.editor.pixelStore.get(id))
    } catch (err) {
      toast(`导出 PSD 失败：${(err as Error).message}`)
      return
    }
    const path = await window.compositor.saveImage({
      suggested: '未命名',
      format: 'psd',
      bytes,
    })
    if (path) toast(`已导出 ${path}`)
  }

  private async exportImage(format: 'png' | 'jpeg'): Promise<void> {
    const image = this.readComposite()
    const canvas = new OffscreenCanvas(image.width, image.height)
    const ctx = canvas.getContext('2d')!
    ctx.putImageData(image, 0, 0)
    const blob = await canvas.convertToBlob({
      type: format === 'png' ? 'image/png' : 'image/jpeg',
      quality: format === 'jpeg' ? 0.92 : undefined,
    })
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const name = this.editor.projectDir
      ? this.editor.projectDir.replace(/\\/g, '/').split('/').pop()?.replace(/\.comp$/i, '') ?? 'compositor'
      : 'compositor'
    const saved = await window.compositor.saveImage({ suggested: name, format, bytes })
    if (saved) toast(`已导出到 ${saved}`)
  }

  // —— 提示类对话 ——

  /**
   * 启动时显示整屏起始页：新建 / 打开 / 导入之后才进入工作区。
   * （原先只是一个版本信息对话框，关掉就直接掉进空工作区。）
   */
  /** 起始页的根元素（存在时说明还没进入工作区）。 */
  private welcomeEl: HTMLElement | null = null

  /** 供自检使用：关掉起始页，直接进入工作区。 */
  dismissWelcome(): void {
    this.welcomeEl?.remove()
    this.welcomeEl = null
  }

  private showWelcome(): Promise<void> {
    return window.compositor.info().then((v) => {
      const { root, hide } = createWelcome(
        {
          newDocument: () => {
            hide()
            this.welcomeEl = null
            this.askNewDocument()
          },
          openProject: () => {
            hide()
            this.welcomeEl = null
            void this.handleCommand('file.open')
          },
          importImage: () => {
            hide()
            this.welcomeEl = null
            void this.handleCommand('file.import')
          },
        },
        v,
      )
      this.welcomeEl = root
      need('app').append(root)
    })
  }

  private showAbout(): void {
    void this.showWelcome()
  }
}

// —— 像素辅助 ——

function fillRect(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const left = Math.max(0, Math.floor(Math.min(x0, x1)))
  const right = Math.min(width - 1, Math.ceil(Math.max(x0, x1)))
  const top = Math.max(0, Math.floor(Math.min(y0, y1)))
  const bottom = Math.min(height - 1, Math.ceil(Math.max(y0, y1)))
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) mask[y * width + x] = 255
  }
}

/** 扫描线填充多边形。 */
function fillPolygon(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  points: [number, number][],
): void {
  if (points.length < 3) return
  let minY = Infinity
  let maxY = -Infinity
  for (const [, y] of points) {
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(height - 1, Math.ceil(maxY))
  for (let y = y0; y <= y1; y++) {
    const xs: number[] = []
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const a = points[i]!
      const b = points[j]!
      if (a[1] > y !== b[1] > y) {
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]))
      }
    }
    xs.sort((p, q) => p - q)
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const left = Math.max(0, Math.floor(xs[k]!))
      const right = Math.min(width - 1, Math.ceil(xs[k + 1]!))
      for (let x = left; x <= right; x++) mask[y * width + x] = 255
    }
  }
}

/** 颜色相似度洪水填充，返回 0/1 蒙版。 */
function floodSelect(image: ImageData, sx: number, sy: number, tolerance: number): Uint8Array {
  const { width, height, data } = image
  const out = new Uint8Array(width * height)
  const start = (sy * width + sx) * 4
  const r0 = data[start]!
  const g0 = data[start + 1]!
  const b0 = data[start + 2]!
  const a0 = data[start + 3]!
  const tol = tolerance * tolerance * 4
  const stack: number[] = [sy * width + sx]
  while (stack.length) {
    const idx = stack.pop()!
    if (out[idx]) continue
    const p = idx * 4
    const dr = data[p]! - r0
    const dg = data[p + 1]! - g0
    const db = data[p + 2]! - b0
    const da = data[p + 3]! - a0
    if (dr * dr + dg * dg + db * db + da * da > tol) continue
    out[idx] = 1
    const x = idx % width
    const y = (idx - x) / width
    if (x > 0) stack.push(idx - 1)
    if (x < width - 1) stack.push(idx + 1)
    if (y > 0) stack.push(idx - width)
    if (y < height - 1) stack.push(idx + width)
  }
  return out
}

/**
 * 按文档坐标的选区蒙版处理图层像素。
 * keepInside = true 保留选区内（复制），false 保留选区外（剪切 / 删除）。
 */
function applySelectionMask(
  image: ImageData,
  mask: Uint8ClampedArray,
  docW: number,
  docH: number,
  transform: { origin: readonly [number, number]; size: readonly [number, number] },
  keepInside: boolean,
): void {
  const { width, height, data } = image
  const [ox, oy] = transform.origin
  const [sw, sh] = transform.size
  if (sw <= 0 || sh <= 0) return

  for (let y = 0; y < height; y++) {
    const docY = Math.floor(oy + ((y + 0.5) / height) * sh)
    for (let x = 0; x < width; x++) {
      const docX = Math.floor(ox + ((x + 0.5) / width) * sw)
      const inDoc = docX >= 0 && docX < docW && docY >= 0 && docY < docH
      const inside = inDoc && mask[docY * docW + docX]! > 127
      if (inside !== keepInside) data[(y * width + x) * 4 + 3] = 0
    }
  }
}

/**
 * 求不透明像素的包围盒（图层本地像素坐标）。空图返回 null。
 */
function opaqueBounds(image: ImageData): [number, number, number, number] | null {
  const { width, height, data } = image
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return null
  return [minX, minY, maxX - minX + 1, maxY - minY + 1]
}

/** 从 ImageData 里裁出一块。 */
function cropImageData(image: ImageData, box: [number, number, number, number]): ImageData {
  const [bx, by, bw, bh] = box
  const out = new ImageData(bw, bh)
  const rowBytes = bw * 4
  for (let y = 0; y < bh; y++) {
    const src = ((by + y) * image.width + bx) * 4
    out.data.set(image.data.subarray(src, src + rowBytes), y * rowBytes)
  }
  return out
}

/** 在 run 列表上把 [start, start+len) 设为新 run；与之相交的旧 run 会被裁掉两侧保留。 */
function paintRun<T extends { location: number; length: number }>(
  runs: T[] | undefined,
  start: number,
  length: number,
  make: (location: number, length: number) => T,
): T[] {
  const end = start + length
  const out: T[] = []
  for (const run of runs ?? []) {
    const a = run.location
    const b = run.location + run.length
    if (b <= start || a >= end) {
      out.push(run)
      continue
    }
    if (a < start) out.push({ ...run, length: start - a })
    if (b > end) out.push({ ...run, location: end, length: b - end })
  }
  out.push(make(start, length))
  return out.sort((p, q) => p.location - q.location)
}

/** 选一个「屏幕上大约 80px 一格」的标尺步长（文档像素）。 */
function chooseRulerStep(zoom: number): number {
  const wanted = 80 / Math.max(zoom, 1e-6)
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(wanted, 1e-6))))
  for (const m of [1, 2, 5]) {
    if (pow * m >= wanted) return pow * m
  }
  return pow * 10
}

/** 由拖拽状态算出矩形（文档坐标）。 */
function dragRectOf(d: {  startX: number
  startY: number
  x: number
  y: number
}): [number, number, number, number] {
  return [
    Math.min(d.startX, d.x),
    Math.min(d.startY, d.y),
    Math.abs(d.x - d.startX),
    Math.abs(d.y - d.startY),
  ]
}

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16) || 0
  const g = parseInt(h.slice(2, 4), 16) || 0
  const b = parseInt(h.slice(4, 6), 16) || 0
  return `rgba(${r},${g},${b},${alpha})`
}

async function decodeImage(bytes: Uint8Array): Promise<ImageData | null> {
  try {
    const blob = new Blob([bytes as unknown as BlobPart])
    const bitmap = await createImageBitmap(blob)
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
    return ctx.getImageData(0, 0, canvas.width, canvas.height)
  } catch {
    return null
  }
}

async function encodePNG(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return new Uint8Array(await blob.arrayBuffer())
}

/** 蒙版按官方要求存成 8 位灰度 PNG（白显示、黑隐藏）。 */
async function encodeMaskPNG(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const ctx = canvas.getContext('2d')!
  const src = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const out = new OffscreenCanvas(canvas.width, canvas.height)
  const octx = out.getContext('2d')!
  const dst = octx.createImageData(canvas.width, canvas.height)
  for (let i = 0; i < src.data.length; i += 4) {
    const lum = Math.round(0.3 * src.data[i]! + 0.59 * src.data[i + 1]! + 0.11 * src.data[i + 2]!)
    dst.data[i] = lum
    dst.data[i + 1] = lum
    dst.data[i + 2] = lum
    dst.data[i + 3] = 255
  }
  octx.putImageData(dst, 0, 0)
  return encodePNG(out)
}

// —— 启动 ——

interface SmokeGlobal {
  __app?: App
  __ready?: boolean
  __initError?: string
}

try {
  const app = new App()
  app.init()
  const w = window as unknown as SmokeGlobal
  w.__app = app
  w.__ready = true

  // 端到端自检入口：建一个含像素图层、蒙版与调整图层的小项目并写盘。
  ;(w as unknown as { __e2e?: unknown }).__e2e = {
    async buildAndSave(dir: string): Promise<{ layers: number; width: number; height: number }> {
      app.editor.replaceDocument(createDocument(64, 48))
      const layer = app.editor.addLayer('红块')
      const px = app.editor.pixelStore.get(layer.id)
      if (!px) throw new Error('图层像素未创建')
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(8, 8, 32, 24)
      bumpPixels(px)
      app.editor.addMask(layer.id, true)
      app.editor.addAdjustmentLayer('Invert', '反相')
      await app.saveInto(dir)
      const doc = app.editor.manifest
      return { layers: doc.layers.length, width: doc.width, height: doc.height }
    },

    /**
     * 导入探针：造一张纯色 PNG，走真实导入路径，再读回合成结果。
     * 验证的是「图片真的被解码、建层、渲染出来」，而不只是没抛异常。
     */
    async importProbe(
      width: number,
      height: number,
    ): Promise<{
      before: number
      after: number
      file: string | null
      pixel: number[] | null
      ms: number
    }> {
      app.editor.replaceDocument(createDocument(64, 48))

      const c = new OffscreenCanvas(width, height)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('无法创建画布')
      cx.fillStyle = '#00c853'
      cx.fillRect(0, 0, width, height)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())

      const before = app.editor.manifest.layers.length
      const t0 = performance.now()
      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('探针.png', bytes)
      const ms = performance.now() - t0

      const img = app.readComposite()
      const at = (24 * img.width + 32) * 4
      const layer = app.editor.manifest.layers.find((l) => l.name.includes('探针'))
      return {
        before,
        after: app.editor.manifest.layers.length,
        file: layer?.imageFile ?? null,
        pixel: [img.data[at] ?? -1, img.data[at + 1] ?? -1, img.data[at + 2] ?? -1, img.data[at + 3] ?? -1],
        ms: Math.round(ms),
      }
    },

    /**
     * 压力探针：导入一张大图后连续做 40 次操作。
     * 修复前每步都会把所有图层像素整幅拷贝进历史，大图下会卡死；
     * 按需快照之后这里应该只需几十毫秒。
     */
    async stressProbe(): Promise<{ ms: number }> {
      app.editor.replaceDocument(createDocument(64, 48))

      const c = new OffscreenCanvas(2000, 1500)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('无法创建画布')
      cx.fillStyle = '#00c853'
      cx.fillRect(0, 0, 2000, 1500)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('压力.png', bytes)

      const layer = app.editor.activeLayer
      if (!layer) throw new Error('导入后没有活动图层')

      const t0 = performance.now()
      for (let i = 0; i < 20; i++) {
        app.editor.setOpacity(layer.id, Math.max(0.1, 1 - i * 0.03))
        app.editor.setTransform(layer.id, { origin: [i, i] })
      }
      return { ms: Math.round(performance.now() - t0) }
    },

    /** 拖放探针：合成一次真实的 drop 事件，验证渲染进程侧的导入链路。 */
    async dropProbe(): Promise<{ before: number; after: number; name: string | null }> {
      app.editor.replaceDocument(createDocument(64, 48))

      const c = new OffscreenCanvas(8, 8)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('无法创建画布')
      cx.fillStyle = '#00c853'
      cx.fillRect(0, 0, 8, 8)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())

      const dt = new DataTransfer()
      dt.items.add(new File([bytes], '拖入.png', { type: 'image/png' }))

      const before = app.editor.manifest.layers.length
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 400))

      const layer = app.editor.manifest.layers.find((l) => l.name.includes('拖入'))
      return { before, after: app.editor.manifest.layers.length, name: layer?.name ?? null }
    },

    /**
     * 覆盖层探针：确认 [hidden] 真的让覆盖层消失。
     * 此前 display:grid 盖掉了 hidden，模态遮罩一直挂在窗口上拦截所有鼠标操作。
     */
    async overlayProbe(): Promise<Record<string, string | boolean>> {
      // 先走真实流程：关掉启动时的起始页（它是全屏遮罩，留着会拦掉后面所有真实点击）。
      await new Promise((resolve) => setTimeout(resolve, 250))
      app.dismissWelcome()
      const dismiss = document.querySelector('#modalRoot .btn.primary')
      if (dismiss instanceof HTMLElement) dismiss.click()
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

      app.editor.replaceDocument(createDocument(64, 48))

      const c = new OffscreenCanvas(8, 8)
      const cx = c.getContext('2d')
      if (cx) {
        cx.fillStyle = '#00c853'
        cx.fillRect(0, 0, 8, 8)
        const blob = await c.convertToBlob({ type: 'image/png' })
        const bytes = new Uint8Array(await blob.arrayBuffer())
        await (
          app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
        ).importImageBytes('覆盖层.png', bytes)
      }
      // 等一帧，让 updateStatus 把提示层状态刷上
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

      const read = (id: string): Record<string, string | boolean> => {
        const node = document.getElementById(id)
        if (!node) return { hidden: true, display: 'missing', visible: false }
        const style = getComputedStyle(node)
        return {
          hidden: node.hidden,
          display: style.display,
          visible: style.display !== 'none' && node.getBoundingClientRect().height > 0,
        }
      }
      const modal = read('modalRoot')
      const overlay = read('dropOverlay')
      const hint = read('canvasHint')
      return {
        modalHidden: modal['hidden'] === true,
        modalDisplay: String(modal['display']),
        modalVisible: modal['visible'] === true,
        overlayHidden: overlay['hidden'] === true,
        overlayDisplay: String(overlay['display']),
        overlayVisible: overlay['visible'] === true,
        hintHidden: hint['hidden'] === true,
        hintDisplay: String(hint['display']),
        hintVisible: hint['visible'] === true,
      }
    },

    /**
     * 选区探针：建立居中的矩形选区，渲染一帧后读回屏幕像素，
     * 检查选区左边界上是否真的出现了蚂蚁线。
     */
    async selectionProbe(): Promise<{ sampled: number; white: number; column: number }> {
      const w = 64
      const h = 48
      app.editor.replaceDocument(createDocument(w, h))

      const mask = new Uint8ClampedArray(w * h)
      for (let y = 16; y < 32; y++) {
        for (let x = 20; x < 44; x++) mask[y * w + x] = 255
      }
      app.selectionMask = mask

      app.renderFrame()
      const screen = app.readScreen()

      const dpr = window.devicePixelRatio || 1
      const z = app.view.zoom * dpr
      const col = Math.round(app.view.panX * dpr + 20 * z)
      const rowTop = Math.round(app.view.panY * dpr + 16 * z)
      const rowBottom = Math.round(app.view.panY * dpr + 32 * z)

      let sampled = 0
      let white = 0
      for (let y = rowTop + 1; y < rowBottom; y++) {
        for (let dx = -2; dx <= 2; dx++) {
          const x = col + dx
          if (x < 0 || x >= screen.width || y < 0 || y >= screen.height) continue
          const i = (y * screen.width + x) * 4
          sampled++
          if (screen.data[i]! > 200 && screen.data[i + 1]! > 200 && screen.data[i + 2]! > 200) white++
        }
      }
      return { sampled, white, column: col }
    },

    /**
     * 文字探针：新建文字图层 → 检查像素真的被画出来 → 改字号后应当重绘并改变画布尺寸。
     */
    async textProbe(): Promise<{
      created: boolean
      layerName: string
      hasTextMeta: boolean
      content: string
      canvasSize: string
      opaquePixels: number
      restyled: boolean
    }> {
      app.editor.replaceDocument(createDocument(200, 100))
      const before = app.editor.manifest.layers.length
      const layer = app.editor.addTextLayer(
        '测试 Text',
        (app as unknown as { currentTextMeta(): TextStyle }).currentTextMeta(),
        [10, 20],
      )

      const countOpaque = (): { size: string; opaque: number } => {
        const px = app.editor.pixelStore.get(layer.id)
        if (!px) return { size: '', opaque: 0 }
        const ctx = px.canvas.getContext('2d')
        if (!ctx) return { size: '', opaque: 0 }
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        let opaque = 0
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) opaque++
        return { size: `${px.canvas.width}x${px.canvas.height}`, opaque }
      }

      const first = countOpaque()

      // 改字号，文字应变大、画布随之变大
      ;(
        app as unknown as { updateTextStyle(patch: Record<string, unknown>): void }
      ).updateTextStyle({ fontSize: 72 })
      const second = countOpaque()

      return {
        created: app.editor.manifest.layers.length === before + 1,
        layerName: layer.name,
        hasTextMeta: Boolean(layer.text),
        content: layer.text?.content ?? '',
        canvasSize: first.size,
        opaquePixels: first.opaque,
        restyled: second.size !== first.size && second.opaque > 0,
      }
    },

    /**
     * 图层效果探针：给一个小方块加外发光，比较方块外一点的像素。
     * 效果是画在合成里的，所以能直接从合成的文档像素读出来。
     */
    async effectsProbe(): Promise<{
      inside: number[]
      outsideBefore: number[]
      outsideAfter: number[]
      hasEffect: boolean
      changed: boolean
    }> {
      app.editor.replaceDocument(createDocument(64, 48))
      const layer = app.editor.addLayer('方块')
      // 画布必须是 8x8 且与 transform 尺寸一致，映射才是 1:1
      const px = app.editor.pixelStore.create(layer.id, 8, 8)
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 8, 8)
      bumpPixels(px)
      app.editor.setTransform(layer.id, { origin: [28, 20], size: [8, 8] })

      const sample = (x: number, y: number): number[] => {
        const img = app.readComposite()
        const i = (y * img.width + x) * 4
        return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!, img.data[i + 3]!]
      }

      // 方块覆盖文档 (28,20)-(36,28)
      const inside = sample(31, 24) // 方块内部
      const outsideBefore = sample(40, 24) // 方块右侧 4 像素处

      app.editor.setEffects(layer.id, (f) => {
        f.outerGlow = { size: 10, color: [1, 0, 0], opacity: 1 }
      })

      const outsideAfter = sample(40, 24)
      return {
        inside,
        outsideBefore,
        outsideAfter,
        hasEffect: Boolean(layer.effects?.outerGlow),
        changed: outsideAfter[3]! > 0 && outsideAfter[0]! > outsideAfter[2]!,
      }
    },

    /**
     * 形状探针：画一个椭圆 → 像素被画出 → 放大尺寸后应按新尺寸重画。
     */
    async shapeProbe(): Promise<{ kind: string; hasShape: boolean; opaque: number; resized: boolean }> {
      app.editor.replaceDocument(createDocument(64, 48))
      const layer = app.editor.addShapeLayer(
        'ellipse',
        { red: 1, green: 0, blue: 0, cornerRadius: 0, lineWidth: 4 },
        [10, 10],
        [20, 20],
      )

      const count = (): number => {
        const px = app.editor.pixelStore.get(layer.id)
        if (!px) return 0
        const ctx = px.canvas.getContext('2d')
        if (!ctx) return 0
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        let n = 0
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++
        return n
      }

      const first = count()
      app.editor.setTransform(layer.id, { size: [40, 30] })
      const px2 = app.editor.pixelStore.get(layer.id)
      const second = count()

      return {
        kind: layer.shape?.kind ?? '',
        hasShape: Boolean(layer.shape),
        opaque: first,
        resized: Boolean(px2 && px2.canvas.width === 40 && px2.canvas.height === 30 && second > first),
      }
    },

    /**
     * 参考线探针：加一条垂直参考线，读回屏幕像素统计它的颜色。
     * 参考线用固定的青色，便于从画面里认出来。
     */
    async guideProbe(): Promise<{ before: number; after: number }> {
      app.editor.replaceDocument(createDocument(64, 48))
      app.showGrid = false
      app.showPixelGrid = false
      app.renderFrame()

      const countGuide = (): number => {
        const img = app.readScreen()
        let n = 0
        for (let i = 0; i < img.data.length; i += 4) {
          if (
            Math.abs(img.data[i]! - 77) < 45 &&
            Math.abs(img.data[i + 1]! - 217) < 45 &&
            Math.abs(img.data[i + 2]! - 255) < 45
          ) {
            n++
          }
        }
        return n
      }

      const before = countGuide()
      app.editor.edit('测试参考线', () => {
        app.editor.manifest.guides = [{ id: 'probe-guide', axis: 'vertical', position: 32 }]
      })
      app.renderFrame()
      const after = countGuide()
      return { before, after }
    },

    /**
     * 修图工具探针：在「左红右蓝」的图层上分别用四种工具操作，
     * 统计像素真的被改动的数量。
     */
    async retouchProbe(): Promise<Record<string, number>> {
      const setup = (): string => {
        app.editor.replaceDocument(createDocument(32, 32))
        const layer = app.editor.addLayer('测试')
        const px = app.editor.pixelStore.create(layer.id, 32, 32)
        const ctx = px.canvas.getContext('2d')
        if (!ctx) throw new Error('缺少 2D 上下文')
        ctx.fillStyle = '#ff0000'
        ctx.fillRect(0, 0, 16, 32)
        ctx.fillStyle = '#0000ff'
        ctx.fillRect(16, 0, 16, 32)
        bumpPixels(px)
        app.editor.setTransform(layer.id, { origin: [0, 0], size: [32, 32] })
        return layer.id
      }

      const snapshot = (id: string): Uint8ClampedArray => {
        const px = app.editor.pixelStore.get(id)!
        return px.canvas.getContext('2d')!.getImageData(0, 0, 32, 32).data
      }
      const diff = (id: string, before: Uint8ClampedArray): number => {
        const after = snapshot(id)
        let n = 0
        for (let i = 0; i < after.length; i += 4) {
          if (Math.abs(after[i]! - before[i]!) > 8) n++
        }
        return n
      }

      const internals = app as unknown as {
        tool: string
        cloneOffset: [number, number] | null
        retouchSegment(id: string, x0: number, y0: number, x1: number, y1: number): void
      }
      const result: Record<string, number> = {}

      app.brush.opacity = 1
      app.brush.size = 12

      // 仿制图章：把左侧红色复制到右侧
      let id = setup()
      let before = snapshot(id)
      internals.tool = 'clone'
      internals.cloneOffset = [-20, 0]
      internals.retouchSegment(id, 24, 16, 24, 16)
      result['clone'] = diff(id, before)

      // 修复画笔：跨过红蓝边界修复
      id = setup()
      before = snapshot(id)
      internals.tool = 'heal'
      internals.retouchSegment(id, 16, 16, 16, 16)
      result['heal'] = diff(id, before)

      // 涂抹：从边界上取色推到右侧
      id = setup()
      before = snapshot(id)
      internals.tool = 'smudge'
      internals.retouchSegment(id, 16, 16, 22, 16)
      result['smudge'] = diff(id, before)

      // 液化：在边界附近推挤
      id = setup()
      before = snapshot(id)
      internals.tool = 'liquify'
      internals.retouchSegment(id, 16, 16, 20, 16)
      result['liquify'] = diff(id, before)

      return result
    },

    /**
     * 方向探针：图层上半红下半蓝，检查**屏幕**上那一半是红的。
     * 用来确诊渲染管线是否发生了垂直翻转。
     */
    async orientationProbe(): Promise<{
      screenTop: number[]
      screenBottom: number[]
      compositeTop: number[]
      compositeBottom: number[]
      screenOriented: boolean
      compositeOriented: boolean
    }> {
      app.editor.replaceDocument(createDocument(32, 32))
      // 同样必须重新适配视图，否则采样坐标会沿用上一个文档的缩放/平移
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const layer = app.editor.addLayer('方向')
      const px = app.editor.pixelStore.create(layer.id, 32, 32)
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 32, 16) // 上半红
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(0, 16, 32, 16) // 下半蓝
      bumpPixels(px)
      app.editor.setTransform(layer.id, { origin: [0, 0], size: [32, 32] })

      const at = (img: ImageData, x: number, y: number): number[] => {
        const i = (Math.round(y) * img.width + Math.round(x)) * 4
        return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]
      }

      // 屏幕：按文档在屏幕上的矩形取上半/下半
      app.renderFrame()
      const screen = app.readScreen()
      const dpr = window.devicePixelRatio || 1
      const z = app.view.zoom * dpr
      const cx = app.view.panX * dpr + 16 * z
      const screenTop = at(screen, cx, app.view.panY * dpr + 4 * z)
      const screenBottom = at(screen, cx, app.view.panY * dpr + 28 * z)

      // 合成结果：按文档坐标取上半/下半
      const composite = app.readComposite()
      const compositeTop = at(composite, 16, 4)
      const compositeBottom = at(composite, 16, 28)

      const isRed = (c: number[]): boolean => c[0]! > 180 && c[2]! < 80
      return {
        screenTop,
        screenBottom,
        compositeTop,
        compositeBottom,
        screenOriented: isRed(screenTop) && !isRed(screenBottom),
        compositeOriented: isRed(compositeTop) && !isRed(compositeBottom),
      }
    },

    /**
     * 复制图层探针：复制一个「上红下蓝」的图层，
     * 检查副本的像素是否与原件逐字节一致（不能发生翻转或错位）。
     */
    async duplicateProbe(): Promise<{
      identical: boolean
      srcTop: number[]
      copyTop: number[]
      copyBottom: number[]
      copyName: string
    }> {
      app.editor.replaceDocument(createDocument(32, 32))
      const layer = app.editor.addLayer('原层')
      const px = app.editor.pixelStore.create(layer.id, 32, 32)
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 32, 16)
      ctx.fillStyle = '#0000ff'
      ctx.fillRect(0, 16, 32, 16)
      bumpPixels(px)
      app.editor.setTransform(layer.id, { origin: [0, 0], size: [32, 32] })

      app.editor.select(layer.id)
      app.editor.duplicateLayers([layer.id])

      const copy = app.editor.manifest.layers.find((l) => l.id !== layer.id)
      const read = (id: string): Uint8ClampedArray => {
        const p = app.editor.pixelStore.get(id)
        if (!p) return new Uint8ClampedArray()
        return p.canvas.getContext('2d')!.getImageData(0, 0, 32, 32).data
      }
      const src = read(layer.id)
      const dst = copy ? read(copy.id) : new Uint8ClampedArray()

      let identical = src.length > 0 && src.length === dst.length
      if (identical) {
        for (let i = 0; i < src.length; i++) {
          if (src[i] !== dst[i]) {
            identical = false
            break
          }
        }
      }
      const at = (d: Uint8ClampedArray, x: number, y: number): number[] => {
        const i = (y * 32 + x) * 4
        return [d[i]!, d[i + 1]!, d[i + 2]!]
      }
      return {
        identical,
        srcTop: at(src, 16, 4),
        copyTop: at(dst, 16, 4),
        copyBottom: at(dst, 16, 28),
        copyName: copy?.name ?? '',
      }
    },

    /** 选区复制探针：整张红色图层 + 左半边选区，Ctrl+J 应只复制左半边。 */
    async selectionCopyProbe(): Promise<{
      copiedOpaque: number
      copyName: string
      copyCanvas: string
      srcCanvas: string
    }> {
      app.editor.replaceDocument(createDocument(32, 32))
      const layer = app.editor.addLayer('源')
      const px = app.editor.pixelStore.create(layer.id, 32, 32)
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#ff0000'
      ctx.fillRect(0, 0, 32, 32)
      bumpPixels(px)
      app.editor.setTransform(layer.id, { origin: [0, 0], size: [32, 32] })
      app.editor.select(layer.id)

      // 选区 = 左半边
      const mask = new Uint8ClampedArray(32 * 32)
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 16; x++) mask[y * 32 + x] = 255
      }
      app.selectionMask = mask

      ;(app as unknown as { copyToNewLayer(): void }).copyToNewLayer()

      const copy = app.editor.manifest.layers.find((l) => l.name.includes('副本'))
      const cpx = copy ? app.editor.pixelStore.get(copy.id) : null
      let copiedOpaque = 0
      if (cpx) {
        // 副本现在会被裁到选区内容的大小，必须按它自己的尺寸遍历
        const cw = cpx.canvas.width
        const ch = cpx.canvas.height
        const img = cpx.canvas.getContext('2d')!.getImageData(0, 0, cw, ch)
        for (let i = 3; i < img.data.length; i += 4) {
          if (img.data[i]! > 0) copiedOpaque++
        }
      }
      return {
        copiedOpaque,
        copyName: copy?.name ?? '',
        copyCanvas: cpx ? `${cpx.canvas.width}×${cpx.canvas.height}` : '无',
        srcCanvas: `${px.canvas.width}×${px.canvas.height}`,
      }
    },

    /** 缩放探针：命中右下角手柄后放大，尺寸应当改变。 */
    async scaleProbe(): Promise<{ hit: string | null; size: number[]; resized: boolean }> {
      app.editor.replaceDocument(createDocument(64, 48))
      const layer = app.editor.addLayer('缩放')
      const px = app.editor.pixelStore.create(layer.id, 20, 10)
      const ctx = px.canvas.getContext('2d')
      if (!ctx) throw new Error('缺少 2D 上下文')
      ctx.fillStyle = '#00c853'
      ctx.fillRect(0, 0, 20, 10)
      bumpPixels(px)
      app.editor.setTransform(layer.id, { origin: [10, 10], size: [20, 10] })
      app.editor.select(layer.id)
      app.tool = 'move'

      const live = app.editor.find(layer.id)!
      const hit = (
        app as unknown as { handleAt(x: number, y: number, l: unknown): string | null }
      ).handleAt(30, 20, live)

      app.editor.setTransform(layer.id, { size: [40, 20], origin: [10, 10] })
      const after = app.editor.find(layer.id)!
      const size = [...after.transform.size]
      return { hit, size, resized: size[0] === 40 && size[1] === 20 }
    },

    /**
     * 导入流程探针：导入一张「三色横条 + 左白条」的图（能同时看出左右与上下），
     * 缩放后再复制，逐步打印每个阶段的 transform 与画布尺寸。
     */
    async importFlowProbe(): Promise<Record<string, unknown>> {
      const info = (l: LayerRecord): Record<string, unknown> => {
        const p = app.editor.pixelStore.get(l.id)
        return {
          name: l.name,
          origin: [...l.transform.origin],
          size: [...l.transform.size],
          flipX: l.transform.flipX,
          flipY: l.transform.flipY,
          rotation: l.transform.rotation,
          canvas: p ? [p.canvas.width, p.canvas.height] : [0, 0],
        }
      }

      app.editor.replaceDocument(createDocument(400, 300))

      const c = new OffscreenCanvas(80, 60)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('缺少 2D 上下文')
      cx.fillStyle = '#ff0000'
      cx.fillRect(0, 0, 80, 20)
      cx.fillStyle = '#00ff00'
      cx.fillRect(0, 20, 80, 20)
      cx.fillStyle = '#0000ff'
      cx.fillRect(0, 40, 80, 20)
      cx.fillStyle = '#ffffff'
      cx.fillRect(0, 0, 8, 60)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())

      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('流程.png', bytes)
      const src = app.editor.activeLayer!
      const imported = info(src)

      // 模拟用户拖角手柄放大 2 倍
      app.editor.setTransform(src.id, { size: [160, 120] })
      const afterScale = info(app.editor.find(src.id)!)

      // 再复制
      app.selectionMask = null
      ;(app as unknown as { copyToNewLayer(): void }).copyToNewLayer()
      const copy = app.editor.manifest.layers.find((l) => l.id !== src.id)!

      return { imported, afterScale, copied: info(copy), copyIsDifferent: info(copy)['size'] }
    },

    /** 移动探针：模拟真实的 pointermove，检查图层位移是否跟手。 */
    async moveProbe(): Promise<{
      from: number[]
      to: number[]
      expected: number[]
      drift: number
    }> {
      app.editor.replaceDocument(createDocument(400, 300))
      const layer = app.editor.addLayer('移动')
      app.editor.setTransform(layer.id, { origin: [40, 40], size: [100, 80] })
      app.editor.select(layer.id)

      const host = document.getElementById('canvasHost')
      if (!host) throw new Error('缺少画布宿主')
      const rect = host.getBoundingClientRect()
      const docToClient = (x: number, y: number): [number, number] => [
        rect.left + app.view.panX + x * app.view.zoom,
        rect.top + app.view.panY + y * app.view.zoom,
      ]

      const internals = app as unknown as {
        drag: unknown
        onPointerMove(ev: PointerEvent): void
      }
      const from: [number, number] = [40, 40]
      const target: [number, number] = [103.5, 81.5] // 位移 (63.5, 41.5)
      internals.drag = {
        kind: 'move',
        id: layer.id,
        startX: from[0],
        startY: from[1],
        origin: [...from],
      }
      const [cx, cy] = docToClient(target[0], target[1])
      internals.onPointerMove(new PointerEvent('pointermove', { clientX: cx, clientY: cy }))

      const after = app.editor.find(layer.id)!
      const to = [...after.transform.origin]
      return {
        from: [...from],
        to,
        expected: [target[0], target[1]],
        drift: Math.hypot(to[0]! - target[0], to[1]! - target[1]),
      }
    },

    /** 渐变纹理探针：直接用 gradientTexture 的方式画一张，检查它是否真的是黑→白。 */
    async gradientTextureProbe(): Promise<Record<string, unknown>> {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 1
      const ctx = canvas.getContext('2d')!
      const grad = ctx.createLinearGradient(0, 0, 256, 0)
      grad.addColorStop(0, 'rgb(0, 0, 0)')
      grad.addColorStop(1, 'rgb(255, 255, 255)')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, 256, 1)
      const px = ctx.getImageData(0, 0, 256, 1).data
      const at = (x: number): string =>
        `${px[x * 4]},${px[x * 4 + 1]},${px[x * 4 + 2]},${px[x * 4 + 3]}`
      return { left: at(2), mid: at(128), right: at(253) }
    },

    /** 字重探针：顶栏要有字重选择器；改字重后画布上的字形宽度应当变化。 */
    async fontWeightProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      app.tool = 'text'
      const internals = app as unknown as {
        currentTextMeta(): TextStyle
        updateTextStyle(patch: Record<string, unknown>): void
        buildOptionsBar(): void
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])
      app.editor.previewText(layer.id, (t) => {
        t.content = 'ABCD'
      })
      const normal = [...layer.transform.size].join('x')

      internals.buildOptionsBar()
      const hasWeightLabel = (document.getElementById('optionsBar')?.textContent ?? '').includes(
        '字重',
      )
      const weightSelect = [...document.querySelectorAll('.options-bar select')].find((s) =>
        [...(s as HTMLSelectElement).options].some((o) => o.value === '900'),
      ) as HTMLSelectElement | undefined
      const optionCount = weightSelect?.options.length ?? 0

      internals.updateTextStyle({ fontWeight: 900 })
      const bold = [...layer.transform.size].join('x')
      return {
        normal,
        bold,
        weight: layer.text?.fontWeight ?? 0,
        hasWeightLabel,
        optionCount,
      }
    },

    /** 文字编辑器字号探针：改字号后编辑框的字号必须跟上，否则光标定位会按旧字号算。 */
    async editorFontProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      app.tool = 'text'
      const internals = app as unknown as {
        currentTextMeta(): TextStyle
        openTextEditor(id: string, all?: boolean): void
        updateTextStyle(patch: Record<string, unknown>): void
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])
      internals.openTextEditor(layer.id, true)
      const ta = document.querySelector('.text-editor') as HTMLTextAreaElement | null
      // 必须先有内容，否则「选中一部分」无从谈起（空文本的 selectionStart/End 恒为 0）
      app.editor.previewText(layer.id, (t) => {
        t.content = 'ABCD'
      })
      if (ta) {
        ta.value = 'ABCD'
        ta.dispatchEvent(new Event('input'))
      }
      // 等两帧：syncTextEditor 是在 tick（rAF）里调用的，不等的话量到的是旧样式
      const nextFrame = (): Promise<void> =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      await nextFrame()
      const before = ta ? getComputedStyle(ta).fontSize : '(无编辑框)'

      // 情况一：无选区，改整层字号
      ta?.setSelectionRange(0, 0)
      internals.updateTextStyle({ fontSize: 96 })
      await nextFrame()
      const afterWhole = ta ? getComputedStyle(ta).fontSize : ''

      // 情况二：有选区，只改选中部分的字号
      ta?.setSelectionRange(0, 1)
      internals.updateTextStyle({ fontSize: 24 })
      await nextFrame()
      const afterRange = ta ? getComputedStyle(ta).fontSize : ''

      return {
        before,
        afterWhole,
        afterRange,
        layerFontSize: layer.text?.fontSize ?? 0,
        sizeRuns: layer.text?.sizeRuns?.length ?? 0,
        // 编辑框的实际盒子 vs 图层变换尺寸：两者不一致时光标就对不上文字
        taRect: ta ? `${Math.round(ta.getBoundingClientRect().width)}x${Math.round(ta.getBoundingClientRect().height)}` : '',
        layerSize: layer.transform.size.map((v) => Math.round(v)).join('x'),
        taLineHeight: ta ? getComputedStyle(ta).lineHeight : '',
        canvasLineHeight: `${Math.round((layer.text?.fontSize ?? 0) + (layer.text?.lineSpacing ?? 0))}px`,
      }
    },

    /** 新建项目预设探针：应有 5 个比例预设（各带图标），点击能把尺寸填进输入框。 */
    async newDocPresetProbe(): Promise<Record<string, unknown>> {
      app.dismissWelcome()
      ;(app as unknown as { askNewDocument(): void }).askNewDocument()

      const btns = [...document.querySelectorAll('.preset-btn')] as HTMLElement[]
      const labels = btns.map((b) => b.querySelector('.preset-label')?.textContent ?? '')
      const icons = btns.filter((b) => b.querySelector('.preset-icon svg')).length

      // 点 16:9，看尺寸输入框是否变成 1920 / 1080
      const idx = labels.indexOf('16:9')
      if (idx >= 0) btns[idx]!.click()
      const inputs = [
        ...document.querySelectorAll('#modalRoot input[type=number]'),
      ] as HTMLInputElement[]
      const values = inputs.map((i) => i.value)

      // 关掉对话框，避免挡住后面的探针
      const cancel = [...document.querySelectorAll('#modalRoot button')].find((b) =>
        /取消|关闭/.test(b.textContent ?? ''),
      )
      ;(cancel as HTMLElement | undefined)?.click()
      return {
        count: btns.length,
        labels: labels.join('|'),
        icons,
        values: values.join('|'),
      }
    },

    /** 起始页探针：启动时应当有起始页，且三张卡片齐全；随后关掉它进入工作区。 */
    async welcomeProbe(): Promise<Record<string, unknown>> {
      const el2 = document.querySelector('.welcome')
      const titles = [...document.querySelectorAll('.welcome-card-title')].map(
        (t) => t.textContent ?? '',
      )
      const keys = document.querySelector('.welcome-keys')?.textContent ?? ''
      const result = {
        present: Boolean(el2),
        cardCount: titles.length,
        titles: titles.join('|'),
        hasKeys: keys.length > 0,
        hasTitle: (document.querySelector('.welcome-title')?.textContent ?? '') === 'Compositor',
      }
      // 关掉它，免得挡住后面的探针（真实点击会打在起始页上）
      app.dismissWelcome()
      return result
    },

    /** 描边对话框探针：列表能为空、能通过「添加描边」新增多行。 */
    async strokeDialogProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(160, 120))
      const layer = app.editor.addLayer('测试')
      openEffectsDialog(app.editor, layer, () => undefined)

      // 每次修改都可能重建容器，所以按整块 .stroke-item 计数、每次都重新查询
      const rows = (): number =>
        document.querySelector('.stroke-list')?.querySelectorAll('.stroke-item').length ?? 0
      const before = rows()
      const addBtn = [...document.querySelectorAll('.stroke-list button')].find((b) =>
        (b.textContent ?? '').includes('添加描边'),
      )
      const clickAdd = (): void => {
        const btn = [...document.querySelectorAll('.stroke-list button')].find((b) =>
          (b.textContent ?? '').includes('添加描边'),
        )
        ;(btn as HTMLElement | undefined)?.click()
      }
      clickAdd()
      const one = rows()
      clickAdd()
      const two = rows()

      // 整个描边块里的控件（不是某一行）
      const firstBlock = document.querySelector('.stroke-list .stroke-item')
      const hasSize = Boolean(firstBlock?.querySelector('input[type=number]'))
      const hasColor = Boolean(firstBlock?.querySelector('.color-picker-swatch'))
      const hasDel = [...(firstBlock?.querySelectorAll('button') ?? [])].some((b) =>
        (b.textContent ?? '').includes('删除'),
      )
      const segLabels = [...(firstBlock?.querySelectorAll('.segment-btn') ?? [])].map(
        (b) => b.textContent ?? '',
      )
      const strokes = layer.effects?.strokes?.length ?? 0
      return {
        hasList: Boolean(document.querySelector('.stroke-list')),
        hasAdd: Boolean(
          [...document.querySelectorAll('.stroke-list button')].find((b) =>
            (b.textContent ?? '').includes('添加描边'),
          ),
        ),
        before,
        one,
        two,
        hasSize,
        hasColor,
        hasDel,
        segLabels: segLabels.join('|'),
        segCount: segLabels.length,
        strokes,
      }
    },

    /** 多描边探针：外层描边与内层描边应同时出现在画面上。 */
    async multiStrokeProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(160, 160))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const image = new ImageData(60, 60)
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 255
        image.data[i + 1] = 255
        image.data[i + 2] = 255
        image.data[i + 3] = 255
      }
      const layer = app.editor.addImageLayer('方块', image)

      const count = (): { red: number; blue: number } => {
        app.renderFrame()
        const img = app.readScreen()
        let red = 0
        let blue = 0
        for (let i = 0; i < img.data.length; i += 4) {
          const a = img.data[i + 3]!
          if (a < 200) continue
          const r = img.data[i]!
          const g = img.data[i + 1]!
          const b = img.data[i + 2]!
          if (r > 150 && g < 90 && b < 90) red++
          if (b > 150 && r < 90 && g < 90) blue++
        }
        return { red, blue }
      }

      const before = count()
      app.editor.setEffects(
        layer.id,
        (f) => {
          ;(f as Record<string, unknown>)['strokes'] = [
            // 外层：8px 红
            { size: 8, inside: false, color: [1, 0, 0], opacity: 1 },
            // 内层：4px 蓝（覆盖在红之上，形成同心环）
            { size: 4, inside: false, color: [0, 0, 1], opacity: 1 },
          ]
        },
        '测试多描边',
      )
      const after = count()
      return {
        beforeRed: before.red,
        beforeBlue: before.blue,
        redPixels: after.red,
        bluePixels: after.blue,
        // 直接回报写进去的效果数据，用于区分「没写进去」和「写了但没渲染」
        effects: JSON.stringify({ strokes: layer.effects?.strokes, stroke: layer.effects?.stroke }),
        debug: JSON.stringify(
          (app as unknown as { compositor: { lastEffectDebug: unknown } }).compositor
            .lastEffectDebug,
        ),
      }
    },

    /** 渐变叠加探针：加一个左黑右白的渐变后，屏幕左半应明显暗于右半。 */
    async gradientOverlayProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(160, 120))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const image = new ImageData(100, 60)
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 255
        image.data[i + 1] = 255
        image.data[i + 2] = 255
        image.data[i + 3] = 255
      }
      const layer = app.editor.addImageLayer('底', image)

      /** 统计屏幕上「接近纯黑」与「接近纯白」的像素数。
       *  不能用左右平均亮度：图层只占屏幕一部分，而渐变是相对图层铺开的，
       *  拿整屏左右平均比会得出误导性的结论。 */
      const stats = (): { dark: number; light: number } => {
        app.renderFrame()
        const img = app.readScreen()
        let dark = 0
        let light = 0
        for (let i = 0; i < img.data.length; i += 4) {
          const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3
          if (v < 30) dark++
          else if (v > 225) light++
        }
        return { dark, light }
      }

      const before = stats()
      app.editor.setEffects(
        layer.id,
        (f) => {
          ;(f as Record<string, unknown>)['gradientOverlay'] = {
            angle: 0,
            opacity: 1,
            stops: [
              { position: 0, color: [0, 0, 0] },
              { position: 1, color: [1, 1, 1] },
            ],
          }
        },
        '测试渐变叠加',
      )
      const after = stats()
      return {
        beforeDark: before.dark,
        beforeLight: before.light,
        afterDark: after.dark,
        afterLight: after.light,
        // 渐变生效的话，图层应该多出一大片接近纯黑的区域
        newDark: after.dark - before.dark,
        debug: JSON.stringify(
          (app as unknown as { compositor: { lastEffectDebug: unknown } }).compositor
            .lastEffectDebug,
        ),
      }
    },

    /** PSD 往返探针：导出再读回，文档尺寸 / 图层数 / 尺寸 / 位置 / 像素都要一致。 */
    async psdRoundTripProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(120, 90))
      const size = 40
      const image = new ImageData(size, size)
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 0
        image.data[i + 1] = 200
        image.data[i + 2] = 80
        image.data[i + 3] = 255
      }
      const layer = app.editor.addImageLayer('方块', image)
      app.editor.edit('定位', () => {
        layer.transform.origin = [17, 23]
        layer.transform.size = [size, size]
      })

      const bytes = exportPsd(app.editor.manifest, (id) => app.editor.pixelStore.get(id))
      const back = importPsd(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      )
      const first = back.layers[0]
      let centerPixel = '(无)'
      if (first) {
        const cx = Math.floor(first.image.width / 2)
        const cy = Math.floor(first.image.height / 2)
        const i = (cy * first.image.width + cx) * 4
        centerPixel = [
          first.image.data[i]!,
          first.image.data[i + 1]!,
          first.image.data[i + 2]!,
          first.image.data[i + 3]!,
        ].join(',')
      }
      return {
        exportedBytes: bytes.length,
        docWidth: back.width,
        docHeight: back.height,
        layerCount: back.layers.length,
        firstName: first?.name ?? '',
        firstWidth: first?.image.width ?? 0,
        firstHeight: first?.image.height ?? 0,
        firstX: first?.x ?? -1,
        firstY: first?.y ?? -1,
        centerPixel,
      }
    },

    /** 面板定位探针：选择器面板展开后必须完全落在窗口内（靠近边缘时要收边）。 */
    async panelBoundsProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      app.tool = 'text'
      const internals = app as unknown as { buildOptionsBar(): void }
      internals.buildOptionsBar()

      const result: Record<string, number | boolean> = {}
      const check = (label: string, trigger: Element | null, panelSel: string): void => {
        if (!(trigger instanceof HTMLElement)) {
          result[`${label}Ok`] = false
          return
        }
        trigger.click()
        const panel = document.querySelector(panelSel)
        if (!(panel instanceof HTMLElement)) {
          result[`${label}Ok`] = false
          return
        }
        const box = panel.getBoundingClientRect()
        result[`${label}Ok`] = true
        result[`${label}Left`] = Math.round(box.left)
        result[`${label}Right`] = Math.round(box.right)
        result[`${label}RightOverflow`] = box.right > window.innerWidth
        result[`${label}LeftOverflow`] = box.left < 0
        result[`${label}Viewport`] = window.innerWidth
        trigger.click()
      }

      check('font', document.querySelector('.font-picker-btn'), '.font-picker-panel')
      check('color', document.querySelector('.color-picker-swatch'), '.color-picker-panel')
      return result
    },

    /** 颜色选择器探针：应为自绘（有色相条与十六进制输入），且选项栏里不再有原生颜色控件。 */
    async colorPickerProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      app.tool = 'text'
      const internals = app as unknown as { buildOptionsBar(): void }
      internals.buildOptionsBar()

      const legacyCount = document.querySelectorAll('.options-bar input[type=color]').length
      const swatch = document.querySelector('.color-picker-swatch')
      if (!(swatch instanceof HTMLElement)) return { ok: false, legacyCount }
      swatch.click()

      const panel = document.querySelector('.color-picker-panel')
      const hex = document.querySelector('.color-picker-hex')
      return {
        ok: true,
        legacyCount,
        open: panel ? !panel.hasAttribute('hidden') : false,
        hasHue: Boolean(document.querySelector('.color-picker-hue')),
        hasSv: Boolean(document.querySelector('.color-picker-sv')),
        hexValue: hex instanceof HTMLInputElement ? hex.value : '',
      }
    },

    /** 选项栏稳定性探针：改样式不能重建选项栏（否则正在拖动的控件会被销毁）。 */
    async optionsBarStabilityProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      app.tool = 'text'
      const internals = app as unknown as {
        buildOptionsBar(): void
        updateTextStyle(patch: Record<string, unknown>): void
      }
      internals.buildOptionsBar()

      // 颜色控件已改为自绘，这里检查它的色块按钮
      const colorBefore = document.querySelector('.color-picker-swatch')
      const fontBtnBefore = document.querySelector('.font-picker-btn')
      const connected = (el: Element | null): boolean => Boolean(el && el.isConnected)

      // 模拟拖动取色器：改一次颜色
      internals.updateTextStyle({ color: '#ff0000' })

      const colorAfter = document.querySelector('.color-picker-swatch')
      const fontBtnAfter = document.querySelector('.font-picker-btn')
      return {
        // 同一个 DOM 对象仍在文档里 → 说明选项栏没有被重建，拖动不会被打断
        colorSame: colorBefore !== null && colorBefore === colorAfter && connected(colorAfter),
        fontBtnSame: fontBtnBefore !== null && fontBtnBefore === fontBtnAfter,
        colorStillConnected: connected(colorBefore),
      }
    },

    /** 控件外观探针：滑块与颜色框必须用统一令牌，不能是系统默认外观。 */
    async widgetStyleProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      const internals = app as unknown as { buildOptionsBar(): void }

      // 遍历各工具，找一个选项栏里确实带 range 的（不同工具的选项栏不一样）。
      // 注意：必须在切到下一个工具**之前**读完样式 —— buildOptionsBar 会重建选项栏，
      // 让旧元素脱离文档，而 getComputedStyle 对脱离文档的元素返回空值。
      let rangeOk = false
      let rangeAppearance = ''
      let rangeHeight = ''
      for (const t of ['brush', 'eraser', 'clone', 'heal', 'smudge', 'liquify', 'retouch']) {
        app.tool = t as never
        internals.buildOptionsBar()
        const range = document.querySelector('.options-bar input[type=range]')
        if (!range) continue
        const cs = getComputedStyle(range)
        rangeOk = true
        // Chromium 里标准名 appearance 有时读不到，退回带前缀的那个
        rangeAppearance =
          (cs.getPropertyValue('appearance') || '').trim() ||
          (cs.getPropertyValue('-webkit-appearance') || '').trim()
        rangeHeight = cs.height
        break
      }

      app.tool = 'text'
      internals.buildOptionsBar()
      const color = document.querySelector('.options-bar input[type=color]')
      const colorCs = color ? getComputedStyle(color) : null
      return {
        rangeOk,
        rangeAppearance,
        rangeHeight,
        colorOk: Boolean(color),
        colorPadding: colorCs?.padding ?? '',
        colorBorderWidth: colorCs?.borderTopWidth ?? '',
        colorBorderColor: colorCs?.borderTopColor ?? '',
      }
    },

    /** 输入框样式探针：选项栏里的数字输入必须用统一令牌，且没有原生上下箭头。 */
    async inputStyleProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      app.tool = 'text'
      ;(app as unknown as { buildOptionsBar(): void }).buildOptionsBar()

      const input = document.querySelector('.options-bar input[type=number]')
      if (!(input instanceof HTMLInputElement)) return { ok: false }
      const cs = getComputedStyle(input)
      return {
        ok: true,
        height: cs.height,
        background: cs.backgroundColor,
        borderColor: cs.borderTopColor,
        appearance: cs.appearance,
        fontFamily: cs.fontFamily,
      }
    },

    /** 面板探针：文字选项栏不再有描边；图层面板底部有「图层效果」按钮。 */
    async panelEffectsProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(200, 150))
      const internals = app as unknown as {
        buildOptionsBar(): void
        layersPanel: { render(): void }
      }

      app.tool = 'text'
      internals.buildOptionsBar()
      const hasTextStroke = (document.getElementById('optionsBar')?.textContent ?? '').includes(
        '描边',
      )

      app.tool = 'move'
      internals.buildOptionsBar()
      internals.layersPanel.render()
      const footTitles = [...document.querySelectorAll('#layerActions button')].map(
        (b) => b.getAttribute('title') ?? '',
      )
      return {
        hasTextStroke,
        hasEffectsBtn: footTitles.some((t) => t.includes('图层效果')),
        footCount: footTitles.length,
      }
    },

    /** 图层描边探针：外侧描边必须是**实色外扩**，不是发散的模糊。 */
    async layerStrokeProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(160, 160))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()

      // 60×60 纯白方块
      const size = 60
      const image = new ImageData(size, size)
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = 255
        image.data[i + 1] = 255
        image.data[i + 2] = 255
        image.data[i + 3] = 255
      }
      const layer = app.editor.addImageLayer('方块', image)

      const measure = (): { stroke: number; opaque: number } => {
        app.renderFrame()
        const img = app.readScreen()
        let stroke = 0
        let opaque = 0
        for (let i = 0; i < img.data.length; i += 4) {
          const a = img.data[i + 3]!
          // 描边是纯红：红通道高、绿蓝低
          if (a > 0 && img.data[i]! > 150 && img.data[i + 1]! < 90 && img.data[i + 2]! < 90) {
            stroke++
            if (a >= 250) opaque++
          }
        }
        return { stroke, opaque }
      }

      const before = measure()

      app.editor.edit('加描边', () => {
        layer.effects = {
          stroke: { enabled: true, size: 6, inside: false, color: [1, 0, 0], opacity: 1 },
        }
      })

      const after = measure()
      return {
        beforeStroke: before.stroke,
        strokePixels: after.stroke,
        // 实色外扩时绝大多数描边像素应完全不透明；发散模糊会把这个占比拉低
        opaqueRatio: after.stroke > 0 ? Number((after.opaque / after.stroke).toFixed(3)) : 0,
      }
    },

    /** 选择同步探针：选一次字体，选择器应立刻显示新字体（不能要选两次）。 */
    async fontPickSyncProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      app.tool = 'text'
      const internals = app as unknown as {
        buildOptionsBar(): void
        currentTextMeta(): TextStyle
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])
      internals.buildOptionsBar()

      const btn = (): HTMLElement | null =>
        document.querySelector('.font-picker-btn') as HTMLElement | null
      const before = btn()?.textContent ?? ''
      btn()?.click()
      const rows = [...document.querySelectorAll('.font-picker-row')] as HTMLElement[]
      // 挑一个跟当前不同的
      const target = rows.find((r) => (r.textContent ?? '') !== before)
      if (!target) return { ok: false, reason: '没有可选的其它字体', before }
      const picked = target.textContent ?? ''
      target.click()

      // 选择会触发选项栏重建，所以这里重新取按钮
      const after = btn()?.textContent ?? ''
      return {
        ok: true,
        before,
        picked,
        after,
        layerFont: layer.text?.fontName ?? '',
        synced: after === picked,
      }
    },

    /** 字体选择器探针：按钮与每个列表项都必须用各自的字体渲染。 */
    async fontFieldProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      app.tool = 'text'
      const internals = app as unknown as { buildOptionsBar(): void }
      internals.buildOptionsBar()

      const btn = document.querySelector('.font-picker-btn')
      if (!(btn instanceof HTMLElement)) return { ok: false }
      const beforeText = btn.textContent ?? ''
      const beforeFamily = btn.style.fontFamily
      btn.click()

      const panel = document.querySelector('.font-picker-panel')
      const rows = [...document.querySelectorAll('.font-picker-row')] as HTMLElement[]
      const sample = rows
        .slice(0, 3)
        .map((r) => `${r.textContent ?? ''} → ${r.style.fontFamily}`)
      // 各行的 font-family 必须互不相同 —— 这才是「每项用各自字体渲染」的证据。
      // 只检查属性被设上是不够的（原生 select 就是这样骗过上一版探针的）。
      const distinct = new Set(rows.map((r) => r.style.fontFamily)).size
      return {
        ok: true,
        beforeText,
        beforeFamily,
        rowCount: rows.length,
        distinct,
        open: panel ? !panel.hasAttribute('hidden') : false,
        sample,
      }
    },

    /** 字体可用性探针：找出「能被选中、但选了其实不生效」的字体。 */
    async fontUsabilityProbe(): Promise<Record<string, unknown>> {
      // 用**过滤后**的列表（下拉框里实际显示的那些），而不是系统原始列表 ——
      // 要验证的是「用户能选到的每一项都真的生效」。
      const internals = app as unknown as { systemFonts?: string[] }
      const fonts =
        internals.systemFonts && internals.systemFonts.length > 0
          ? internals.systemFonts
          : ((await window.compositor.listFonts()) as string[])
      const probe = new OffscreenCanvas(1, 1).getContext('2d')!
      const missing = '__no_such_family__'
      const text = '漢字ABCxyz'
      // 统一回退链：基准与被测项必须用同一条链（"被测族, 不存在的族, sans-serif"）；
      // 否则两者落到不同回退字体上，宽度天然不同，会把有效字体误判成无效。
      const widthOf = (family: string): number => {
        probe.font = `48px "${family}", "${missing}", sans-serif`
        return Math.round(probe.measureText(text).width * 100) / 100
      }
      const baseline = widthOf(missing)

      const sample = fonts
      const rows = sample.map((f) => ({
        font: f,
        width: widthOf(f),
        // 宽度与「不存在的族」相同 → 说明这个字体名根本没被解析，浏览器回退了
        ineffective: widthOf(f) === baseline,
      }))
      return {
        baseline,
        total: fonts.length,
        ineffectiveCount: rows.filter((r) => r.ineffective).length,
        rows,
      }
    },

    /** 字体替换探针：存在局部字体 run 时改整层字体，必须全部换掉、不留下旧字体的字。 */
    async fontReplaceProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      const internals = app as unknown as {
        currentTextMeta(): TextStyle
        openTextEditor(id: string, all?: boolean): void
        updateTextStyle(patch: Record<string, unknown>): void
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])
      internals.openTextEditor(layer.id, true)

      const ta = document.querySelector('.text-editor')
      if (ta instanceof HTMLTextAreaElement) {
        ta.value = 'ABCD'
        ta.dispatchEvent(new Event('input'))
        // 光标收起（无选区）→ 改样式应作用于整层
        ta.setSelectionRange(2, 2)
      }

      // 先给中间两个字设一个局部字体 run
      app.editor.applyText(
        layer.id,
        (t) => {
          t.fontRuns = [{ location: 1, length: 2, fontName: 'SimSun' }]
        },
        '测试用局部字体',
      )
      const before = {
        fontName: layer.text?.fontName,
        runs: layer.text?.fontRuns?.length ?? 0,
      }

      internals.updateTextStyle({ fontName: 'KaiTi' })

      return {
        before,
        after: {
          fontName: layer.text?.fontName,
          runs: layer.text?.fontRuns?.length ?? 0,
        },
      }
    },

    /** 版本号压力探针：连续改 20 次，每次屏幕都必须变（抓「改了没反应」这类间歇问题）。 */
    async versionStressProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const internals = app as unknown as { currentTextMeta(): TextStyle }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [30, 30])

      const countWhite = (): number => {
        app.renderFrame()
        const img = app.readScreen()
        let n = 0
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i]! > 200 && img.data[i + 1]! > 200 && img.data[i + 2]! > 200) n++
        }
        return n
      }

      const samples: number[] = []
      let stuck = 0
      for (let i = 0; i < 20; i++) {
        // 用「同样文字、交替字号」制造确定性变化：内容不会超出文档边界被裁，
        // 所以每一轮屏幕像素数都必然不同 —— 任何一次相同就说明渲染没跟上。
        const size = i % 2 === 0 ? 40 : 20
        app.editor.previewText(layer.id, (t) => {
          t.content = 'AAAA'
          t.fontSize = size
          // 显式设成白色：前面的探针可能改过 textStyle 的颜色并留在状态里，
          // 不写死的话「数白色像素」就会恒为 0，误报成渲染没跟上。
          t.red = 1
          t.green = 1
          t.blue = 1
        })
        const n = countWhite()
        if (samples.length > 0 && n === samples[samples.length - 1]) stuck++
        samples.push(n)
      }
      return {
        distinct: new Set(samples).size,
        stuck,
        rounds: samples.length,
      }
    },

    /** 描边探针：必须沿字形外缘向外扩一层**实色**（不是发散的模糊）。 */
    async textStrokeProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      const internals = app as unknown as { currentTextMeta(): TextStyle }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [30, 30])

      app.editor.previewText(layer.id, (t) => {
        t.content = 'AA'
      })
      const plain = [...layer.transform.size]

      app.editor.previewText(layer.id, (t) => {
        t.textStroke = { width: 4, red: 1, green: 0, blue: 0 }
      })
      const stroked = [...layer.transform.size]

      const px = app.editor.pixelStore.get(layer.id)
      let redPixels = 0
      let redOpaque = 0
      let alphaSum = 0
      if (px) {
        const ctx = px.canvas.getContext('2d')!
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        for (let i = 0; i < img.data.length; i += 4) {
          const a = img.data[i + 3]!
          if (a > 0 && img.data[i]! > 200 && img.data[i + 1]! < 60 && img.data[i + 2]! < 60) {
            redPixels++
            if (a >= 250) redOpaque++
            alphaSum += a / 255
          }
        }
      }
      return {
        plain,
        stroked,
        redPixels,
        redOpaque,
        // 实色外扩：绝大多数描边像素应当是完全不透明的（只有字形边缘带抗锯齿）。
        // 发散模糊会让这个占比很低。
        opaqueRatio: redPixels > 0 ? Number((redOpaque / redPixels).toFixed(3)) : 0,
        redAvgAlpha: redPixels > 0 ? Number((alphaSum / redPixels).toFixed(3)) : 0,
      }
    },

    /** 选区样式探针：选中一部分文字后改字体，应当只写进 fontRuns 而不动整层。 */
    async rangeStyleProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const internals = app as unknown as {
        currentTextMeta(): TextStyle
        openTextEditor(id: string, all?: boolean): void
        updateTextStyle(patch: Record<string, unknown>): void
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])
      internals.openTextEditor(layer.id, true)

      const ta = document.querySelector('.text-editor')
      if (!(ta instanceof HTMLTextAreaElement)) return { ok: false }
      ta.value = '你好世界'
      ta.dispatchEvent(new Event('input'))

      // 只选中中间两个字
      ta.setSelectionRange(1, 3)
      const before = { fontName: layer.text?.fontName, runs: layer.text?.fontRuns?.length ?? 0 }
      internals.updateTextStyle({ fontName: 'SimSun' })
      const after = {
        fontName: layer.text?.fontName,
        runs: layer.text?.fontRuns?.length ?? 0,
        run: layer.text?.fontRuns?.[0] ?? null,
      }
      return { ok: true, before, after, editorOpen: Boolean(document.querySelector('.text-editor')) }
    },

    /** 富文本探针：局部换字体 / 换字号 / 换颜色是否真的生效。 */
    async richTextProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      const internals = app as unknown as { currentTextMeta(): TextStyle }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [20, 20])

      app.editor.previewText(layer.id, (t) => {
        t.content = 'AAAA'
      })
      const plain = [...layer.transform.size]

      // 前两个字换字体
      app.editor.previewText(layer.id, (t) => {
        t.fontRuns = [{ location: 0, length: 2, fontName: 'Courier New' }]
      })
      const mixedFont = [...layer.transform.size]

      // 前两个字字号加倍
      app.editor.previewText(layer.id, (t) => {
        t.sizeRuns = [{ location: 0, length: 2, fontSize: 96 }]
        })
      const bigSize = [...layer.transform.size]

      // 前两个字变红，然后数画布上的纯红像素
      app.editor.previewText(layer.id, (t) => {
        t.colorRuns = [{ location: 0, length: 2, red: 1, green: 0, blue: 0 }]
      })
      const px = app.editor.pixelStore.get(layer.id)
      let redPixels = -1
      if (px) {
        const ctx = px.canvas.getContext('2d')!
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        redPixels = 0
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i]! > 200 && img.data[i + 1]! < 60 && img.data[i + 2]! < 60) redPixels++
        }
      }

      const t = layer.text
      return {
        plain,
        mixedFont,
        bigSize,
        redPixels,
        fontRunCount: t?.fontRuns?.length ?? 0,
        colorRunCount: t?.colorRuns?.length ?? 0,
        sizeRunCount: t?.sizeRuns?.length ?? 0,
      }
    },

    /** 准备一个已填内容的编辑框，返回可供真实鼠标点击的坐标。 */
    async textCaretProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const internals = app as unknown as {
        currentTextMeta(): TextStyle
        openTextEditor(id: string, all?: boolean): void
      }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [40, 40])
      internals.openTextEditor(layer.id, true)

      const ta = document.querySelector('.text-editor')
      if (!(ta instanceof HTMLTextAreaElement)) return { ok: false }
      ta.value = '你好世界'
      ta.dispatchEvent(new Event('input'))
      const box = ta.getBoundingClientRect()
      return {
        ok: true,
        x: Math.round(box.left + 30),
        y: Math.round(box.top + box.height / 2),
        length: ta.value.length,
        before: ta.selectionStart,
      }
    },

    /** 编辑框当前的光标位置。 */
    async textCaretState(): Promise<Record<string, unknown>> {
      const ta = document.querySelector('.text-editor')
      if (!(ta instanceof HTMLTextAreaElement)) return { ok: false }
      return {
        ok: true,
        selectionStart: ta.selectionStart,
        selectionEnd: ta.selectionEnd,
        length: ta.value.length,
        focused: document.activeElement === ta,
      }
    },

    /** 文字显示探针：输入文字后屏幕上必须真的出现文字像素，第二次修改也必须生效。 */
    async textRenderProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      const internals = app as unknown as { currentTextMeta(): TextStyle }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [60, 60])

      const countWhite = (): number => {
        app.renderFrame()
        const img = app.readScreen()
        let n = 0
        for (let i = 0; i < img.data.length; i += 4) {
          if (img.data[i]! > 200 && img.data[i + 1]! > 200 && img.data[i + 2]! > 200) n++
        }
        return n
      }

      const empty = countWhite()
      app.editor.previewText(layer.id, (t) => {
        t.content = '大家'
      })
      const once = countWhite()
      // 再改一次：这一步专门抓「改了没反应」（纹理被版本号碰撞跳过更新）
      app.editor.previewText(layer.id, (t) => {
        t.content = '大家好呀'
      })
      const twice = countWhite()
      return { empty, once, twice }
    },

    /** 准备文字工具并返回画布上某点的客户端坐标（供真实鼠标事件使用）。 */
    async prepareTextTool(): Promise<{ x: number; y: number }> {
      // 先收掉可能还开着的编辑框：它盖在画布上会吃掉真实点击
      ;(app as unknown as { closeTextEditor(commit: boolean): void }).closeTextEditor(false)
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      app.tool = 'text'
      const rect = need('canvasHost').getBoundingClientRect()
      return {
        x: Math.round(rect.left + app.view.panX + 100 * app.view.zoom),
        y: Math.round(rect.top + app.view.panY + 100 * app.view.zoom),
      }
    },

    /** 当前内联编辑器的状态（供真实鼠标事件后检查）。 */
    async textEditorState(): Promise<Record<string, unknown>> {
      const ta = document.querySelector('.text-editor')
      if (!(ta instanceof HTMLTextAreaElement)) {
        return { exists: false, layers: app.editor.manifest.layers.length }
      }
      const cs = getComputedStyle(ta)
      return {
        exists: true,
        width: Math.round(ta.getBoundingClientRect().width),
        textColor: cs.color,
        focused: document.activeElement === ta,
        layers: app.editor.manifest.layers.length,
      }
    },

    /** 文字编辑器探针：走完整流程（文字工具 → 点画布），检查编辑框真的可用。 */
    async textEditorProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()
      app.tool = 'text'

      const host = need('canvasHost')
      const rect = host.getBoundingClientRect()
      const cx = rect.left + app.view.panX + 100 * app.view.zoom
      const cy = rect.top + app.view.panY + 100 * app.view.zoom

      const internals = app as unknown as {
        onPointerDown(ev: PointerEvent): void
        onPointerUp(ev: PointerEvent): void
      }
      const down = new PointerEvent('pointerdown', {
        clientX: cx,
        clientY: cy,
        bubbles: true,
        cancelable: true,
        pointerId: 1,
      })
      internals.onPointerDown(down)
      internals.onPointerUp(
        new PointerEvent('pointerup', { clientX: cx, clientY: cy, bubbles: true, pointerId: 1 }),
      )
      // 等两帧：编辑框的聚焦被刻意延后到下一帧，真实点击才不会被抢走焦点
      await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
      })

      const ta = document.querySelector('.text-editor')
      if (!(ta instanceof HTMLTextAreaElement)) {
        return {
          exists: false,
          width: 0,
          textColor: '',
          caretColor: '',
          focused: false,
          prevented: down.defaultPrevented,
        }
      }
      const cs = getComputedStyle(ta)
      const box = ta.getBoundingClientRect()
      return {
        exists: true,
        width: Math.round(box.width),
        height: Math.round(box.height),
        textColor: cs.color,
        caretColor: cs.caretColor,
        focused: document.activeElement === ta,
        prevented: down.defaultPrevented,
        layerCount: app.editor.manifest.layers.length,
      }
    },

    /** 新建文字探针：点空白新建时不该显示任何字，输入后才出现内容。 */
    async textNewProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))
      const internals = app as unknown as { currentTextMeta(): TextStyle }
      const layer = app.editor.addTextLayer('', internals.currentTextMeta(), [50, 50])

      const stat = (): { canvas: string; opaque: number } => {
        const px = app.editor.pixelStore.get(layer.id)
        if (!px) return { canvas: '无', opaque: -1 }
        const ctx = px.canvas.getContext('2d')!
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        let n = 0
        for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) n++
        return { canvas: `${px.canvas.width}×${px.canvas.height}`, opaque: n }
      }

      const empty = stat()
      app.editor.previewText(layer.id, (t) => {
        t.content = '大家好'
      })
      const typed = stat()
      return {
        emptyCanvas: empty.canvas,
        emptyOpaque: empty.opaque,
        typedContent: layer.text?.content ?? '',
        typedCanvas: typed.canvas,
        typedOpaque: typed.opaque,
      }
    },

    /**
     * 文字包围盒探针：检查文字实际画出来的范围与图层画布 / transform.size 是否吻合。
     * 三者不一致就会出现「文字与框位置不对」或文字被裁掉。
     */
    async textBoundsProbe(): Promise<{
      size: number[]
      canvas: number[]
      bbox: number[]
      clipped: boolean
    }> {
      app.editor.replaceDocument(createDocument(400, 300))
      const layer = app.editor.addTextLayer(
        '测试文字 Abc',
        (app as unknown as { currentTextMeta(): TextStyle }).currentTextMeta(),
        [50, 50],
      )
      const px = app.editor.pixelStore.get(layer.id)
      if (!px) throw new Error('文字图层没有像素')
      const ctx = px.canvas.getContext('2d')!
      const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)

      let minX = px.canvas.width
      let minY = px.canvas.height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < px.canvas.height; y++) {
        for (let x = 0; x < px.canvas.width; x++) {
          if (img.data[(y * px.canvas.width + x) * 4 + 3]! > 0) {
            if (x < minX) minX = x
            if (y < minY) minY = y
            if (x > maxX) maxX = x
            if (y > maxY) maxY = y
          }
        }
      }
      const bbox = maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1]
      // 贴到画布边缘就说明被裁了
      const clipped = maxX >= px.canvas.width - 1 || maxY >= px.canvas.height - 1
      return {
        size: [...layer.transform.size],
        canvas: [px.canvas.width, px.canvas.height],
        bbox,
        clipped,
      }
    },

    /**
     * 框与图片对位探针：导入一张纯红图片，渲染后读**屏幕像素**，
     * 比较红色区域的实际包围盒与变换框应有的屏幕矩形。
     * 两者不重合就说明渲染位置与 transform 脱节了。
     */
    async frameVsImageProbe(): Promise<{
      imageBBox: number[]
      frameRect: number[]
      dx: number
      dy: number
      matches: boolean
    }> {
      app.editor.replaceDocument(createDocument(400, 300))
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()

      const c = new OffscreenCanvas(80, 60)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('缺少 2D 上下文')
      cx.fillStyle = '#ff0000'
      cx.fillRect(0, 0, 80, 60)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('红图.png', bytes)

      const layer = app.editor.activeLayer!
      app.tool = 'move'
      app.renderFrame()
      const screen = app.readScreen()

      let minX = screen.width
      let minY = screen.height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < screen.height; y++) {
        for (let x = 0; x < screen.width; x++) {
          const i = (y * screen.width + x) * 4
          if (screen.data[i]! > 180 && screen.data[i + 1]! < 80 && screen.data[i + 2]! < 80) {
            if (x < minX) minX = x
            if (y < minY) minY = y
            if (x > maxX) maxX = x
            if (y > maxY) maxY = y
          }
        }
      }
      const imageBBox = maxX < 0 ? [0, 0, 0, 0] : [minX, minY, maxX - minX + 1, maxY - minY + 1]

      const dpr = window.devicePixelRatio || 1
      const z = app.view.zoom * dpr
      const t = layer.transform
      const frameRect = [
        app.view.panX * dpr + t.origin[0] * z,
        app.view.panY * dpr + t.origin[1] * z,
        t.size[0] * z,
        t.size[1] * z,
      ]

      const dx = Math.abs((imageBBox[0] ?? 0) - (frameRect[0] ?? 0))
      const dy = Math.abs((imageBBox[1] ?? 0) - (frameRect[1] ?? 0))
      // 框线本身会盖住最外一圈像素，容差 3px
      return { imageBBox, frameRect, dx, dy, matches: dx <= 3 && dy <= 3 }
    },

    /**
     * 自动选择探针：复现「上层是文档尺寸的空白图层、下层才是图片」的情形，
     * 点图片应当选中图片图层，点空白处不应选中任何图层。
     */
    async autoSelectProbe(): Promise<{
      picked: string | null
      blankOnTop: boolean
      missIsNull: boolean
      ok: boolean
    }> {
      app.editor.replaceDocument(createDocument(200, 150))

      const c = new OffscreenCanvas(60, 40)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('缺少 2D 上下文')
      cx.fillStyle = '#ff0000'
      cx.fillRect(0, 0, 60, 40)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('红图.png', bytes)
      const img = app.editor.activeLayer!
      app.editor.setTransform(img.id, { origin: [20, 20], size: [60, 40] })

      // 上层再放一个文档尺寸的空白图层，并把选择切到它上面
      const blank = app.editor.addLayer('空白层')
      app.editor.select(blank.id)

      const internals = app as unknown as {
        layerAtDoc(x: number, y: number): { id: string; name: string } | null
      }
      // (40,40) 落在图片上；(180,140) 是空白处
      const hit = internals.layerAtDoc(40, 40)
      const miss = internals.layerAtDoc(180, 140)

      return {
        picked: hit?.name ?? null,
        blankOnTop: app.editor.manifest.layers.indexOf(blank) > app.editor.manifest.layers.indexOf(img),
        missIsNull: miss === null,
        ok: hit?.id === img.id && miss === null,
      }
    },

    /**
     * 用户流程探针：完整走一遍「拖入图片 → 建选区 → Ctrl+J」，
     * 然后从画布上到下采样颜色序列，检查副本是否被上下颠倒。
     * 图片做成「上红 / 中绿 / 下蓝」，一眼就能看出方向。
     */
    async userFlowProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(400, 300))

      const c = new OffscreenCanvas(120, 80)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('缺少 2D 上下文')
      cx.fillStyle = '#ff0000'
      cx.fillRect(0, 0, 120, 26)
      cx.fillStyle = '#00ff00'
      cx.fillRect(0, 26, 120, 27)
      cx.fillStyle = '#0000ff'
      cx.fillRect(0, 53, 120, 27)
      const blob = await c.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())

      // 1) 拖入
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], '流程.png', { type: 'image/png' }))
      window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      await new Promise((resolve) => setTimeout(resolve, 400))

      const src = app.editor.activeLayer!
      const doc = app.editor.manifest

      // 2) 画一个覆盖左半边的选区
      const mask = new Uint8ClampedArray(doc.width * doc.height)
      for (let y = 0; y < doc.height; y++) {
        for (let x = 0; x < doc.width / 2; x++) mask[y * doc.width + x] = 255
      }
      app.selectionMask = mask

      // 3) Ctrl+J
      ;(app as unknown as { copyToNewLayer(): void }).copyToNewLayer()

      const copy = app.editor.manifest.layers.find((l) => l.id !== src.id)

      /** 从上到下采样三个点，返回颜色标签。 */
      const column = (id: string): string[] => {
        const px = app.editor.pixelStore.get(id)
        if (!px) return ['无像素']
        const ctx = px.canvas.getContext('2d')!
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        const labels: string[] = []
        for (const frac of [0.15, 0.5, 0.85]) {
          const y = Math.floor(px.canvas.height * frac)
          const i = (y * px.canvas.width + 30) * 4
          const r = img.data[i]!
          const g = img.data[i + 1]!
          const b = img.data[i + 2]!
          const a = img.data[i + 3]!
          labels.push(a === 0 ? '透明' : r > 180 ? '红' : b > 180 ? '蓝' : g > 180 ? '绿' : `${r},${g},${b}`)
        }
        return labels
      }

      return {
        srcTransform: `${JSON.stringify(src.transform.origin)} / ${JSON.stringify(src.transform.size)} flipY=${src.transform.flipY}`,
        copyTransform: copy
          ? `${JSON.stringify(copy.transform.origin)} / ${JSON.stringify(copy.transform.size)} flipY=${copy.transform.flipY}`
          : '（没有副本）',
        srcColumn: column(src.id),
        copyColumn: copy ? column(copy.id) : [],
        srcCanvas: (() => {
          const px = app.editor.pixelStore.get(src.id)
          return px ? `${px.canvas.width}×${px.canvas.height}` : '无'
        })(),
        copyCanvas: (() => {
          const px = copy ? app.editor.pixelStore.get(copy.id) : null
          return px ? `${px.canvas.width}×${px.canvas.height}` : '无'
        })(),
      }
    },

    /**
     * 无选区 JPEG 复制探针：完整对应「拖入 jpg → 直接 Ctrl+J」这条路径。
     * 除了比对副本画布像素，还读**屏幕**像素比对，因为用户看到的是屏幕。
     */
    async jpegCopyProbe(): Promise<Record<string, unknown>> {
      app.editor.replaceDocument(createDocument(1280, 800))
      // 必须重新适配视图：否则会沿用上一个文档的缩放/平移，
      // 采样坐标全错（这正是之前方向探针漏报的原因）
      ;(app as unknown as { fitToWindow(): void }).fitToWindow()

      // 造一张 959×702 的 JPEG（上红/中绿/下蓝），尺寸与用户的一致
      const c = new OffscreenCanvas(959, 702)
      const cx = c.getContext('2d')
      if (!cx) throw new Error('缺少 2D 上下文')
      cx.fillStyle = '#ff0000'
      cx.fillRect(0, 0, 959, 234)
      cx.fillStyle = '#00ff00'
      cx.fillRect(0, 234, 959, 234)
      cx.fillStyle = '#0000ff'
      cx.fillRect(0, 468, 959, 234)
      const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
      const bytes = new Uint8Array(await blob.arrayBuffer())

      await (
        app as unknown as { importImageBytes(n: string, b: Uint8Array): Promise<void> }
      ).importImageBytes('测试.jpg', bytes)
      const src = app.editor.activeLayer!

      app.selectionMask = null
      ;(app as unknown as { copyToNewLayer(): void }).copyToNewLayer()
      const copy = app.editor.manifest.layers.find((l) => l.id !== src.id)!

      const column = (id: string): string[] => {
        const px = app.editor.pixelStore.get(id)
        if (!px) return ['无像素']
        const ctx = px.canvas.getContext('2d')!
        const img = ctx.getImageData(0, 0, px.canvas.width, px.canvas.height)
        const out: string[] = []
        for (const fy of [0.1, 0.5, 0.9]) {
          const x = Math.floor(px.canvas.width * 0.5)
          const y = Math.floor(px.canvas.height * fy)
          const i = (y * px.canvas.width + x) * 4
          const r = img.data[i]!
          const g = img.data[i + 1]!
          const b = img.data[i + 2]!
          out.push(r > 180 ? '红' : b > 180 ? '蓝' : g > 180 ? '绿' : `${r},${g},${b}`)
        }
        return out
      }

      // 屏幕：沿文档中心竖线自顶向下采 10 点，看清整列的分布
      app.renderFrame()
      const screen = app.readScreen()
      const dpr = window.devicePixelRatio || 1
      const z = app.view.zoom * dpr
      const screenCol = Array.from({ length: 10 }, (_, i) => {
        const fy = (i + 0.5) / 10
        const x = Math.round(app.view.panX * dpr + 1280 * 0.5 * z)
        const y = Math.round(app.view.panY * dpr + 800 * fy * z)
        if (x < 0 || y < 0 || x >= screen.width || y >= screen.height) return '越界'
        const j = (y * screen.width + x) * 4
        const r = screen.data[j]!
        const g = screen.data[j + 1]!
        const b = screen.data[j + 2]!
        return r > 180 ? '红' : b > 180 ? '蓝' : g > 180 ? '绿' : `${r},${g},${b}`
      })

      return {
        srcTransform: `o=${JSON.stringify(src.transform.origin)} s=${JSON.stringify(src.transform.size)}`,
        copyTransform: `o=${JSON.stringify(copy.transform.origin)} s=${JSON.stringify(copy.transform.size)}`,
        srcCanvasCol: column(src.id),
        copyCanvasCol: column(copy.id),
        screenCol,
        samePosition: JSON.stringify(src.transform.origin) === JSON.stringify(copy.transform.origin),
      }
    },
  }
} catch (err) {
  const w = window as unknown as SmokeGlobal
  w.__initError = (err as Error)?.stack ?? String(err)
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="error-box" style="margin:24px">初始化失败：${String(err)}</div>`,
  )
}
