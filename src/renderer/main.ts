/**
 * 应用主体：把编辑器状态、GPU 合成器与界面接起来。
 * 画布上的全部工具交互、菜单命令、文件读写都在这里收口。
 */
import { Compositor, type ViewTransform } from './gl/renderer.ts'
import { Editor, type TextStyle } from './state/editor.ts'
import { FONT_CHOICES } from './text.ts'
import { SHAPE_KINDS, type ShapeKind } from './shape.ts'
import { cloneAt, healAt, liquifyAt, smudgeAt } from './retouch.ts'
import { clear, el, field, hexToRgb01, modal, need, numberInput, rgb01ToHex, toast } from './ui/dom.ts'
import { ICONS } from './ui/icons.ts'
import { LayersPanel, PropsPanel, openAdjustmentDialog } from './ui/panels.ts'
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
  saveImage(o: { suggested: string; format: 'png' | 'jpeg'; bytes: Uint8Array }): Promise<string | null>
  reveal(path: string): Promise<void>
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
  | { kind: 'gradient'; startX: number; startY: number; x: number; y: number }
  | { kind: 'crop'; startX: number; startY: number; x: number; y: number }
  | { kind: 'shape'; startX: number; startY: number; x: number; y: number }
  | { kind: 'retouch'; id: string; lastX: number; lastY: number }

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
  }
  wandTolerance = 32
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
    need('statusDoc').textContent = `${doc.width} × ${doc.height} · ${doc.layers.length} 图层`
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
        const color = el('input', { type: 'color', value: this.brush.color })
        color.addEventListener('input', () => {
          this.brush.color = color.value
        })
        bar.append(color)
      }
    } else if (tool.id === 'wand') {
      bar.append(el('span', { class: 'opt-label', text: '容差' }))
      const tol = numberInput(this.wandTolerance, { min: 0, max: 255, step: 1 })
      tol.addEventListener('change', () => {
        this.wandTolerance = Math.max(0, Math.min(255, Number(tol.value)))
      })
      bar.append(tol)
      bar.append(el('span', { class: 'opt-label', text: '（对当前图层取样）' }))
    } else if (tool.id === 'gradient') {
      bar.append(el('span', { class: 'opt-label', text: '前景色 → 透明' }))
      const color = el('input', { type: 'color', value: this.brush.color })
      color.addEventListener('input', () => {
        this.brush.color = color.value
      })
      bar.append(color)
    } else if (tool.id === 'marquee' || tool.id === 'lasso') {
      bar.append(el('span', { class: 'opt-label', text: '按住 Shift 追加选区' }))
      const clearBtn = el('button', { class: 'btn', text: '取消选择', onClick: () => this.clearSelection() })
      bar.append(clearBtn)
    } else if (tool.id === 'crop') {
      bar.append(el('button', { class: 'btn', text: '裁剪画布', onClick: () => this.applyCropFromSelection() }))
    } else if (tool.id === 'text') {
      const style = this.activeTextStyle()

      const font = el('select', { class: 'select' })
      for (const f of FONT_CHOICES) font.append(el('option', { value: f.value, text: f.label }))
      font.value = style.fontName
      font.addEventListener('change', () => this.updateTextStyle({ fontName: font.value }))
      bar.append(el('span', { class: 'opt-label', text: '字体' }), font)

      const size = numberInput(style.fontSize, { min: 4, max: 800, step: 1 })
      size.addEventListener('change', () =>
        this.updateTextStyle({ fontSize: Math.max(4, Number(size.value)) }),
      )
      bar.append(el('span', { class: 'opt-label', text: '字号' }), size)

      const color = el('input', { type: 'color', value: style.color })
      color.addEventListener('input', () => this.updateTextStyle({ color: color.value }))
      bar.append(el('span', { class: 'opt-label', text: '颜色' }), color)

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
    } else if (tool.id === 'shape') {
      const kind = el('select', { class: 'select' })
      for (const k of SHAPE_KINDS) kind.append(el('option', { value: k.value, text: k.label }))
      kind.value = this.shapeStyle.kind
      kind.addEventListener('change', () => {
        this.shapeStyle.kind = kind.value as ShapeKind
        this.buildOptionsBar()
      })
      bar.append(el('span', { class: 'opt-label', text: '形状' }), kind)

      const color = el('input', { type: 'color', value: this.shapeStyle.color })
      color.addEventListener('input', () => {
        this.shapeStyle.color = color.value
        this.applyShapeStyle()
      })
      bar.append(el('span', { class: 'opt-label', text: '颜色' }), color)

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
    const host = need('canvasHost')
    host.setPointerCapture(ev.pointerId)
    const [dx, dy] = this.screenToDoc(ev.clientX, ev.clientY)

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
        const layer = this.editor.activeLayer
        if (!layer) return
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
      case 'gradient':
        this.drag = { kind: 'gradient', startX: dx, startY: dy, x: dx, y: dy }
        return
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
        // 点在已有文字上就继续编辑它，否则新建一个文字图层
        const hit = this.textLayerAt(dx, dy)
        if (hit) {
          this.openTextEditor(hit.id)
          return
        }
        const layer = this.editor.addTextLayer('文字', this.currentTextMeta(), [dx, dy])
        this.openTextEditor(layer.id)
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
      case 'gradient':
        this.drag.x = dx
        this.drag.y = dy
        return
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
      case 'gradient':
        this.commitGradient(dx, dy)
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
      case 'brush':
        this.editor.pixelStore.touch(this.drag.id)
        this.invalidate()
        break
      default:
        break
    }
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
    const threshold = 6 / Math.max(this.view.zoom, 0.01)
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

  // —— 文字工具 ——

  /** 把选项栏上的样式转成官方 text 元数据（RGB 为 0–1）。 */
  private currentTextMeta(): TextStyle {
    const [r, g, b] = hexToRgb01(this.textStyle.color)
    return {
      fontName: this.textStyle.fontName,
      fontSize: this.textStyle.fontSize,
      red: r,
      green: g,
      blue: b,
      alignment: this.textStyle.alignment,
      tracking: this.textStyle.tracking,
      lineSpacing: this.textStyle.lineSpacing,
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
  private openTextEditor(layerID: string): void {
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
    ta.addEventListener('blur', () => this.closeTextEditor(true))

    ta.focus()
    ta.select()
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
    ta.style.width = `${Math.max(60, t.size[0] * z)}px`
    ta.style.height = `${Math.max(28, t.size[1] * z)}px`
    ta.style.fontFamily = `"${layer.text.fontName}", "Microsoft YaHei UI", sans-serif`
    ta.style.fontSize = `${layer.text.fontSize * z}px`
    ta.style.lineHeight = `${(layer.text.fontSize + layer.text.lineSpacing) * z}px`
    ta.style.textAlign = layer.text.alignment
    ta.style.letterSpacing = `${layer.text.tracking * z}px`
    ta.style.color = `rgb(${Math.round(layer.text.red * 255)}, ${Math.round(
      layer.text.green * 255,
    )}, ${Math.round(layer.text.blue * 255)})`
  }

  /** 选项栏显示用的样式：选中文字图层就显示它的，否则显示新建默认值。 */
  private activeTextStyle(): typeof this.textStyle {
    const layer = this.editor.activeLayer
    if (layer?.text) {
      const t = layer.text
      return {
        fontName: t.fontName,
        fontSize: t.fontSize,
        color: rgb01ToHex(t.red, t.green, t.blue),
        alignment: t.alignment,
        tracking: t.tracking,
        lineSpacing: t.lineSpacing,
      }
    }
    return this.textStyle
  }

  /** 改文字样式：有选中的文字图层就应用上去，同时记为下次新建的默认样式。 */
  private updateTextStyle(patch: Partial<typeof this.textStyle>): void {
    this.textStyle = { ...this.textStyle, ...patch }
    this.buildOptionsBar()

    const layer = this.editor.activeLayer
    if (!layer?.text) return
    const rgb = patch.color ? hexToRgb01(patch.color) : null
    this.editor.applyText(layer.id, (t) => {
      if (patch.fontName !== undefined) t.fontName = patch.fontName
      if (patch.fontSize !== undefined) t.fontSize = patch.fontSize
      if (patch.alignment !== undefined) t.alignment = patch.alignment
      if (patch.tracking !== undefined) t.tracking = patch.tracking
      if (patch.lineSpacing !== undefined) t.lineSpacing = patch.lineSpacing
      if (rgb) {
        t.red = rgb[0]
        t.green = rgb[1]
        t.blue = rgb[2]
      }
    })
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
    px.version++
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
    px.version++
    this.invalidate()
  }

  private commitGradient(ex: number, ey: number): void {
    if (this.drag.kind !== 'gradient') return
    const layer = this.editor.activeLayer
    if (!layer || layer.isGroup || layer.adjustment) {
      toast('渐变需要先选中一个像素图层')
      return
    }
    const px = this.editor.pixelStore.get(layer.id)
    if (!px) return
    const { startX, startY } = this.drag
    this.editor.edit(
      '渐变填充',
      () => {
        const ctx = px.canvas.getContext('2d')!
        const t = layer.transform
        const toLocal = (x: number, y: number): [number, number] => [
          ((x - t.origin[0]) / t.size[0]) * px.canvas.width,
          ((y - t.origin[1]) / t.size[1]) * px.canvas.height,
        ]
        const [ax, ay] = toLocal(startX, startY)
        const [bx, by] = toLocal(ex, ey)
        const grad = ctx.createLinearGradient(ax, ay, bx, by)
        grad.addColorStop(0, hexToRgba(this.brush.color, this.brush.opacity))
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.save()
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = grad
        ctx.fillRect(0, 0, px.canvas.width, px.canvas.height)
        ctx.restore()
        px.version++
      },
      [layer.id],
    )
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

  private panelAction(action: Parameters<LayersPanel['render']> extends never ? never : 'new' | 'newGroup' | 'newAdjust' | 'duplicate' | 'delete' | 'mask' | 'clip' | 'up' | 'down'): void {
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
          this.editor.duplicateLayers([...this.editor.selection])
          return
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

  private askNewDocument(): void {
    const w = numberInput(1280, { min: 1, max: LIMITS.maxPixelsPerSide })
    const h = numberInput(800, { min: 1, max: LIMITS.maxPixelsPerSide })
    const fill = el('select')
    fill.append(el('option', { value: 'transparent', text: '透明' }))
    fill.append(el('option', { value: 'white', text: '白色' }))
    fill.append(el('option', { value: 'black', text: '黑色' }))
    modal({
      title: '新建项目',
      body: [field('宽度（像素）', w), field('高度（像素）', h), field('背景', fill)],
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
          this.editor.pixelStore.create(layer.id, width, height, fill.value === 'white' ? '#ffffff' : '#000000')
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
    toast(`已导入 ${name}`)
  }

  /** PSD/PSB：按合成预览导入为一个图层（分层解析不在 MVP 范围内）。 */
  private async importPSD(name: string, bytes: Uint8Array): Promise<void> {
    const image = await decodeImage(bytes)
    if (!image) {
      modal({
        title: '无法导入该 Photoshop 文件',
        body: [
          el('div', {
            class: 'error-box',
            text: `当前版本只能导入浏览器能解码的 PSD 预览。\n${name} 里的图像数据无法直接读取。\n\n提示：在 Photoshop 中导出为 PNG 后再导入，可完整保留画面。`,
          }),
        ],
        infoOnly: true,
      })
      return
    }
    const layer = this.editor.addImageLayer(name.replace(/\.[^.]+$/, ''), image)
    void layer
    toast(`已导入 ${name}（合成预览）`)
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

  private showWelcome(): Promise<void> {
    const info = window.compositor.info()
    return info.then((v) => {
      modal({
        title: `Compositor for Windows v${v.version}`,
        body: [
          el('div', {
            class: 'prop-hint',
            text:
              '这是 Mac 版 Compositor（github.com/robbietilton/Compositor，MIT）的 Windows 复刻版。\n' +
              '项目格式 .comp 与 Mac 版完全互通：一个文件夹，含 manifest.json 与 images/ 里的 PNG 图层。',
          }),
          el('div', {
            class: 'prop-hint',
            text: `快捷键：V 移动 · M 矩形选框 · L 套索 · W 魔棒 · B 画笔 · E 橡皮 · G 渐变 · I 吸管 · C 裁剪 · H 抓手 · Z 缩放\n空格拖动平移 · Ctrl+滚轮缩放 · Ctrl+S 保存 · Ctrl+Z 撤销`,
          }),
          el('div', {
            class: 'prop-hint',
            text: `运行环境：Electron ${v.electron} / Chromium ${v.chrome}`,
          }),
        ],
        confirmLabel: '开始',
        infoOnly: true,
      })
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
      px.version++
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
      // 先走真实流程：点掉启动时的欢迎框。
      // 修复前即使用户点了关闭（hidden=true），遮罩因 display:grid 仍在，
      // 会持续拦掉全窗口的鼠标操作。
      await new Promise((resolve) => setTimeout(resolve, 250))
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
      px.version++
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
        px.version++
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
  }
} catch (err) {
  const w = window as unknown as SmokeGlobal
  w.__initError = (err as Error)?.stack ?? String(err)
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div class="error-box" style="margin:24px">初始化失败：${String(err)}</div>`,
  )
}
