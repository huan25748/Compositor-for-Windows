/**
 * 编辑器状态：文档、图层操作、像素管理、撤销重做。
 *
 * 所有会改变文档的操作都走 `edit()`，它会在改动前拍一张快照，
 * 于是撤销/重做对「结构变化」和「像素变化」是统一的。
 */
import { newID } from '../../shared/id.ts'
import {
  createAdjustment,
  createAdjustmentLayer,
  createGroup,
  createPixelLayer,
  createTextLayer,
} from '../../shared/factory.ts'
import type {
  AdjustmentKind,
  BlendMode,
  LayerEffects,
  LayerRecord,
  Manifest,
  ShapeMetadata,
  TextMetadata,
  Transform,
} from '../../shared/types.ts'
import { measureText, renderText } from '../text.ts'
import { renderShape, type ShapeKind } from '../shape.ts'
import type { LayerPixels } from '../gl/renderer.ts'

/** 形状类型的中文名（用作新图层的名字）。 */
const SHAPE_LABEL: Record<ShapeKind, string> = {
  rectangle: '矩形',
  roundedRectangle: '圆角矩形',
  ellipse: '椭圆',
  line: '直线',
}

/** 新建文字时用到的样式子集（其余字段由文字内容与测量决定）。 */
export type TextStyle = Pick<
  TextMetadata,
  'fontName' | 'fontSize' | 'red' | 'green' | 'blue' | 'alignment' | 'tracking' | 'lineSpacing'
>

/** 像素的历史快照。 */
export interface PixelSnapshot {
  width: number
  height: number
  data: Uint8ClampedArray
}

export class PixelStore {
  private readonly map = new Map<string, LayerPixels>()

  get(id: string): LayerPixels | undefined {
    return this.map.get(id)
  }

  create(id: string, width: number, height: number, fill?: string): LayerPixels {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('无法创建 2D 上下文')
    if (fill) {
      ctx.fillStyle = fill
      ctx.fillRect(0, 0, w, h)
    }
    const entry: LayerPixels = { canvas, version: 0 }
    this.map.set(id, entry)
    return entry
  }

  createFromImageData(id: string, image: ImageData): LayerPixels {
    const entry = this.create(id, image.width, image.height)
    entry.canvas.getContext('2d')!.putImageData(image, 0, 0)
    entry.version++
    return entry
  }

  /** 标记像素已改变，触发纹理重新上传。 */
  touch(id: string): void {
    const e = this.map.get(id)
    if (e) e.version++
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  /** 只保留 manifest 仍在引用的像素。 */
  prune(manifest: Manifest): void {
    const alive = new Set<string>()
    for (const l of manifest.layers) {
      if (l.imageFile) alive.add(l.id)
      if (l.maskFile) alive.add(`${l.id}:mask`)
    }
    for (const key of [...this.map.keys()]) {
      if (!alive.has(key)) this.map.delete(key)
    }
  }

  /** 为缺少像素的常规图层补一张透明画布（例如刚打开的项目）。 */
  ensureFor(manifest: Manifest): void {
    for (const l of manifest.layers) {
      if (l.isGroup || l.adjustment || !l.imageFile) continue
      if (!this.map.has(l.id)) this.create(l.id, l.transform.size[0], l.transform.size[1])
    }
  }

  /**
   * 只快照指定图层的像素。
   *
   * 历史里绝不能无差别拷贝所有图层：导入一张手机照片就是几十 MB，
   * 几十步历史足以把内存吃光、把应用卡死。只有真正被改写的图层才需要快照。
   */
  snapshotOf(ids: readonly string[]): Map<string, PixelSnapshot> {
    const out = new Map<string, PixelSnapshot>()
    for (const id of ids) {
      const entry = this.map.get(id)
      if (!entry) continue
      const ctx = entry.canvas.getContext('2d')
      if (!ctx) continue
      const image = ctx.getImageData(0, 0, entry.canvas.width, entry.canvas.height)
      out.set(id, { width: entry.canvas.width, height: entry.canvas.height, data: image.data })
    }
    return out
  }

  /** 恢复快照中的像素；不在快照里的图层保持原样。 */
  restore(snap: Map<string, PixelSnapshot>): void {
    for (const [id, s] of snap) {
      const entry = this.create(id, s.width, s.height)
      entry.canvas
        .getContext('2d')!
        .putImageData(new ImageData(new Uint8ClampedArray(s.data), s.width, s.height), 0, 0)
      entry.version++
    }
  }

  /** 丢弃全部像素（切换文档时使用）。 */
  clear(): void {
    this.map.clear()
  }
}

interface Snapshot {
  label: string
  manifest: Manifest
  /** 只包含本次操作真正改动过的图层像素。 */
  pixels: Map<string, PixelSnapshot>
  /** 需要随历史一起还原的像素目标；undo/redo 往返时复用。 */
  pixelTargets: readonly string[]
  activeLayerID: string | null
  selection: string[]
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** 编辑器核心：持有当前文档，提供图层操作与历史。 */
export class Editor {
  manifest: Manifest
  readonly pixelStore = new PixelStore()
  activeLayerID: string | null = null
  selection: string[] = []
  projectDir: string | null = null
  dirty = false

  private undoStack: Snapshot[] = []
  private redoStack: Snapshot[] = []
  private readonly maxHistory = 40
  private listeners = new Set<() => void>()

  constructor(manifest: Manifest) {
    this.manifest = manifest
    this.activeLayerID = manifest.activeLayerID ?? manifest.layers[manifest.layers.length - 1]?.id ?? null
    this.pixelStore.ensureFor(manifest)
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  // —— 历史 ——

  private capture(label: string, pixelTargets: readonly string[] = []): Snapshot {
    return {
      label,
      manifest: clone(this.manifest),
      pixels: pixelTargets.length ? this.pixelStore.snapshotOf(pixelTargets) : new Map(),
      pixelTargets,
      activeLayerID: this.activeLayerID,
      selection: [...this.selection],
    }
  }

  /**
   * 执行一次可撤销的修改。
   *
   * 只有本次操作会改写「已存在图层的像素」时才需要传 `pixelTargets`
   * （画笔、擦除、渐变、删除图层/蒙版）。结构性改动不要传，
   * 否则每次操作都会把整幅画面拷贝一遍。
   */
  edit(label: string, fn: () => void, pixelTargets?: readonly string[]): void {
    const before = this.capture(label, pixelTargets)
    fn()
    this.undoStack.push(before)
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift()
    this.redoStack = []
    this.dirty = true
    this.pixelStore.prune(this.manifest)
    this.emit()
  }

  /** 仅刷新界面（视图/选择变化），不进历史。 */
  refresh(): void {
    this.emit()
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): void {
    const snap = this.undoStack.pop()
    if (!snap) return
    this.redoStack.push(this.capture(snap.label, snap.pixelTargets))
    this.apply(snap)
  }

  redo(): void {
    const snap = this.redoStack.pop()
    if (!snap) return
    this.undoStack.push(this.capture(snap.label, snap.pixelTargets))
    this.apply(snap)
  }

  private apply(snap: Snapshot): void {
    this.manifest = clone(snap.manifest)
    this.pixelStore.restore(snap.pixels)
    this.pixelStore.prune(this.manifest)
    this.activeLayerID = snap.activeLayerID
    this.selection = [...snap.selection]
    this.dirty = true
    this.emit()
  }

  // —— 查询 ——

  get activeLayer(): LayerRecord | null {
    return this.manifest.layers.find((l) => l.id === this.activeLayerID) ?? null
  }

  find(id: string): LayerRecord | undefined {
    return this.manifest.layers.find((l) => l.id === id)
  }

  childrenOf(parentID: string | null): LayerRecord[] {
    return this.manifest.layers.filter((l) => (l.parentID ?? null) === parentID)
  }

  /** 自上而下列出图层（面板顺序），带缩进层级。 */
  flattenForPanel(): { layer: LayerRecord; depth: number }[] {
    const out: { layer: LayerRecord; depth: number }[] = []
    const walk = (parentID: string | null, depth: number): void => {
      const kids = this.childrenOf(parentID)
      for (let i = kids.length - 1; i >= 0; i--) {
        const layer = kids[i]!
        out.push({ layer, depth })
        if (layer.isGroup) walk(layer.id, depth + 1)
      }
    }
    walk(null, 0)
    return out
  }

  private indexOf(id: string): number {
    return this.manifest.layers.findIndex((l) => l.id === id)
  }

  /** 某图层及其全部后代。 */
  descendants(id: string): LayerRecord[] {
    const out: LayerRecord[] = []
    const walk = (parent: string): void => {
      for (const l of this.manifest.layers) {
        if (l.parentID === parent) {
          out.push(l)
          if (l.isGroup) walk(l.id)
        }
      }
    }
    walk(id)
    return out
  }

  select(id: string, additive = false): void {
    if (additive) {
      this.selection = this.selection.includes(id)
        ? this.selection.filter((s) => s !== id)
        : [...this.selection, id]
    } else {
      this.selection = [id]
    }
    this.activeLayerID = id
    this.manifest.activeLayerID = id
    this.emit()
  }

  // —— 图层结构 ——

  addLayer(name = '新图层'): LayerRecord {
    const layer = createPixelLayer(name, 0, 0, this.manifest.width, this.manifest.height)
    layer.imageFile = `${layer.id}.png`
    this.edit(`新建图层「${name}」`, () => {
      const active = this.activeLayer
      if (active?.parentID) layer.parentID = active.parentID
      this.insertAboveActive(layer)
      this.pixelStore.create(layer.id, this.manifest.width, this.manifest.height)
      this.activate(layer.id)
    })
    return layer
  }

  addImageLayer(name: string, image: ImageData): LayerRecord {
    const layer = createPixelLayer(name, 0, 0, image.width, image.height)
    layer.imageFile = `${layer.id}.png`
    this.edit(`导入「${name}」`, () => {
      this.insertAboveActive(layer)
      this.pixelStore.createFromImageData(layer.id, image)
      this.activate(layer.id)
    })
    return layer
  }

  addAdjustmentLayer(kind: AdjustmentKind, name: string = kind): LayerRecord {
    const layer = createAdjustmentLayer(name, kind, this.manifest.width, this.manifest.height)
    this.edit(`新建调整图层「${name}」`, () => {
      const active = this.activeLayer
      if (active?.parentID) layer.parentID = active.parentID
      this.insertAboveActive(layer)
      this.activate(layer.id)
    })
    return layer
  }

  /** 新建文字图层，并立刻把文字渲染成像素。 */
  addTextLayer(content: string, style: TextStyle, origin: [number, number]): LayerRecord {
    const meta: TextMetadata = {
      content,
      fontName: style.fontName,
      fontSize: style.fontSize,
      red: style.red,
      green: style.green,
      blue: style.blue,
      alignment: style.alignment,
      tracking: style.tracking,
      lineSpacing: style.lineSpacing,
    }
    const measured = measureText(meta)
    const layer = createTextLayer(
      content,
      style,
      Math.round(origin[0]),
      Math.round(origin[1]),
      measured.width,
      measured.height,
    )
    layer.imageFile = `${layer.id}.png`

    this.edit('添加文字', () => {
      this.insertAboveActive(layer)
      const px = this.pixelStore.create(layer.id, measured.width, measured.height)
      renderText(px.canvas, meta)
      px.version++
      this.activate(layer.id)
    })
    return layer
  }

  /** 修改文字内容或样式并重新渲染（进历史）。 */
  applyText(id: string, mut: (t: TextMetadata) => void, label = '文字样式'): void {
    const layer = this.find(id)
    if (!layer?.text) return
    this.edit(
      label,
      () => {
        mut(layer.text!)
        this.rerenderText(layer)
      },
      [id],
    )
  }

  /** 输入过程中的实时预览（不进历史）。 */
  previewText(id: string, mut: (t: TextMetadata) => void): void {
    const layer = this.find(id)
    if (!layer?.text) return
    mut(layer.text)
    this.rerenderText(layer)
    this.dirty = true
    this.emit()
  }

  /** 依据 text 元数据重画像素；尺寸变了就重建画布，避免文字被裁掉。 */
  private rerenderText(layer: LayerRecord): void {
    if (!layer.text) return
    const measured = measureText(layer.text)
    const px = this.pixelStore.get(layer.id)
    if (
      !px ||
      px.canvas.width !== measured.width ||
      px.canvas.height !== measured.height
    ) {
      const next = this.pixelStore.create(layer.id, measured.width, measured.height)
      renderText(next.canvas, layer.text)
      next.version++
      layer.transform.size = [measured.width, measured.height]
      return
    }
    renderText(px.canvas, layer.text)
    px.version++
  }

  /** 新建形状图层（像素 + 官方 shape 元数据），并立刻把形状画出来。 */
  addShapeLayer(
    kind: ShapeKind,
    style: { red: number; green: number; blue: number; cornerRadius: number; lineWidth: number },
    origin: [number, number],
    size: [number, number],
  ): LayerRecord {
    const w = Math.max(1, Math.round(size[0]))
    const h = Math.max(1, Math.round(size[1]))
    const layer = createPixelLayer(
      SHAPE_LABEL[kind],
      Math.round(origin[0]),
      Math.round(origin[1]),
      w,
      h,
    )
    layer.shape = {
      kind,
      red: style.red,
      green: style.green,
      blue: style.blue,
      cornerRadius: style.cornerRadius,
      ...(kind === 'line'
        ? {
            lineWidth: style.lineWidth,
            start: [0, 0.5] as [number, number],
            end: [1, 0.5] as [number, number],
          }
        : {}),
    }
    layer.imageFile = `${layer.id}.png`

    this.edit('添加形状', () => {
      this.insertAboveActive(layer)
      const px = this.pixelStore.create(layer.id, w, h)
      renderShape(px.canvas, layer.shape!)
      px.version++
      this.activate(layer.id)
    })
    return layer
  }

  /** 修改形状样式（颜色、圆角等），保持可再编辑。 */
  applyShape(id: string, mut: (s: ShapeMetadata) => void, label = '形状样式'): void {
    const layer = this.find(id)
    if (!layer?.shape) return
    this.edit(
      label,
      () => {
        mut(layer.shape!)
        this.rerenderShape(layer)
      },
      [id],
    )
  }

  /** 依据 shape 元数据重画（改尺寸或颜色时用，避免拉伸位图）。 */
  private rerenderShape(layer: LayerRecord): void {
    if (!layer.shape) return
    const w = Math.max(1, Math.round(layer.transform.size[0]))
    const h = Math.max(1, Math.round(layer.transform.size[1]))
    const px = this.pixelStore.get(layer.id)
    if (!px || px.canvas.width !== w || px.canvas.height !== h) {
      const next = this.pixelStore.create(layer.id, w, h)
      renderShape(next.canvas, layer.shape)
      next.version++
      return
    }
    renderShape(px.canvas, layer.shape)
    px.version++
  }

  addGroup(name = '组'): LayerRecord {
    const group = createGroup(name, 0, 0, this.manifest.width, this.manifest.height)
    this.edit(`新建组「${name}」`, () => {
      const active = this.activeLayer
      if (active?.parentID) group.parentID = active.parentID
      this.insertAboveActive(group)
      this.activate(group.id)
    })
    return group
  }

  private activate(id: string): void {
    this.activeLayerID = id
    this.selection = [id]
    this.manifest.activeLayerID = id
  }

  private insertAboveActive(layer: LayerRecord): void {
    const active = this.activeLayer
    if (!active) {
      this.manifest.layers.push(layer)
      return
    }
    this.manifest.layers.splice(this.indexOf(active.id) + 1, 0, layer)
  }

  deleteLayers(ids: string[]): void {
    if (ids.length === 0) return
    // 被删图层的像素会随 manifest 一起消失，必须存进历史才能撤销回来
    const victims = new Set<string>()
    for (const id of ids) {
      victims.add(id)
      for (const d of this.descendants(id)) victims.add(d.id)
    }
    const targets: string[] = []
    for (const v of victims) targets.push(v, `${v}:mask`)

    this.edit(
      '删除图层',
      () => {
        this.manifest.layers = this.manifest.layers.filter((l) => !victims.has(l.id))
        for (const l of this.manifest.layers) {
          if (l.maskSourceID && victims.has(l.maskSourceID)) delete l.maskSourceID
          if (l.parentID && victims.has(l.parentID)) delete l.parentID
        }
        this.selection = this.selection.filter((s) => !victims.has(s))
        if (this.activeLayerID && victims.has(this.activeLayerID)) {
          const next = this.manifest.layers[this.manifest.layers.length - 1]?.id ?? null
          this.activeLayerID = next
          if (next) this.manifest.activeLayerID = next
        }
      },
      targets,
    )
  }

  duplicateLayers(ids: string[]): void {
    if (ids.length === 0) return
    this.edit('复制图层', () => {
      const copies: string[] = []
      for (const id of ids) {
        const src = this.find(id)
        if (!src) continue
        const copy = this.deepCopyLayer(src)
        this.manifest.layers.splice(this.indexOf(src.id) + 1, 0, copy)
        copies.push(copy.id)
      }
      if (copies.length) this.activate(copies[copies.length - 1]!)
    })
  }

  /** 拷贝图层（含像素、蒙版与组内后代）。 */
  private deepCopyLayer(src: LayerRecord, parentOverride?: string): LayerRecord {
    const copy: LayerRecord = clone(src)
    copy.id = newID()
    if (parentOverride) copy.parentID = parentOverride
    if (copy.imageFile) {
      copy.imageFile = `${copy.id}.png`
      const px = this.pixelStore.get(src.id)
      if (px) {
        const ctx = px.canvas.getContext('2d')!
        this.pixelStore.createFromImageData(copy.id, ctx.getImageData(0, 0, px.canvas.width, px.canvas.height))
      }
    }
    if (copy.maskFile) {
      copy.maskFile = `${copy.id}.mask.png`
      const mp = this.pixelStore.get(`${src.id}:mask`)
      if (mp) {
        const ctx = mp.canvas.getContext('2d')!
        this.pixelStore.createFromImageData(
          `${copy.id}:mask`,
          ctx.getImageData(0, 0, mp.canvas.width, mp.canvas.height),
        )
      }
    }
    if (src.isGroup) {
      for (const child of this.childrenOf(src.id)) this.deepCopyLayer(child, copy.id)
    }
    return copy
  }

  groupSelected(): void {
    const ids = this.selection.filter((id) => this.find(id))
    if (ids.length === 0) return
    this.edit('从选中图层建组', () => {
      const group = createGroup('组', 0, 0, this.manifest.width, this.manifest.height)
      const top = this.find(ids[ids.length - 1]!)
      if (top?.parentID) group.parentID = top.parentID
      this.manifest.layers.splice(this.indexOf(ids[ids.length - 1]!) + 1, 0, group)
      for (const id of ids) {
        const l = this.find(id)
        if (l) l.parentID = group.id
      }
      this.activate(group.id)
    })
  }

  ungroup(ids: string[]): void {
    this.edit('取消编组', () => {
      for (const id of ids) {
        const group = this.find(id)
        if (!group?.isGroup) continue
        const parent = group.parentID
        for (const child of this.childrenOf(group.id)) {
          if (parent) child.parentID = parent
          else delete child.parentID
        }
        this.manifest.layers = this.manifest.layers.filter((l) => l.id !== group.id)
      }
    })
  }

  /** 移动图层（重排 / 进出组）。 */
  moveLayer(id: string, targetID: string | null, position: 'above' | 'below' | 'inside'): void {
    const layer = this.find(id)
    if (!layer) return
    const banned = new Set([id, ...this.descendants(id).map((d) => d.id)])
    if (targetID && banned.has(targetID)) return

    this.edit('调整图层顺序', () => {
      this.manifest.layers.splice(this.indexOf(id), 1)

      if (!targetID) {
        delete layer.parentID
        this.manifest.layers.push(layer)
        return
      }
      const target = this.find(targetID)
      if (!target) {
        this.manifest.layers.push(layer)
        return
      }
      if (position === 'inside') {
        if (!target.isGroup) {
          this.manifest.layers.push(layer)
          return
        }
        layer.parentID = target.id
        let at = this.indexOf(target.id)
        for (const child of this.childrenOf(target.id)) at = Math.max(at, this.indexOf(child.id))
        this.manifest.layers.splice(at + 1, 0, layer)
        return
      }
      if (target.parentID) layer.parentID = target.parentID
      else delete layer.parentID
      const at = this.indexOf(target.id)
      this.manifest.layers.splice(position === 'above' ? at + 1 : at, 0, layer)
    })
  }

  /** 在同类中上移（层级更高的方向）。 */
  raiseLayer(id: string, toTop: boolean): void {
    const layer = this.find(id)
    if (!layer) return
    const siblings = this.childrenOf(layer.parentID ?? null)
    const i = siblings.findIndex((l) => l.id === id)
    if (i < 0) return
    if (toTop) {
      if (i === siblings.length - 1) return
      this.moveLayer(id, siblings[siblings.length - 1]!.id, 'above')
    } else {
      if (i >= siblings.length - 1) return
      this.moveLayer(id, siblings[i + 1]!.id, 'above')
    }
  }

  /** 在同类中下移。 */
  lowerLayer(id: string, toBottom: boolean): void {
    const layer = this.find(id)
    if (!layer) return
    const siblings = this.childrenOf(layer.parentID ?? null)
    const i = siblings.findIndex((l) => l.id === id)
    if (i < 0) return
    if (toBottom) {
      if (i === 0) return
      this.moveLayer(id, siblings[0]!.id, 'below')
    } else {
      if (i <= 0) return
      this.moveLayer(id, siblings[i - 1]!.id, 'below')
    }
  }

  // —— 图层属性 ——

  setBlendMode(id: string, mode: BlendMode): void {
    const layer = this.find(id)
    if (!layer || layer.blendMode === mode) return
    this.edit('更改混合模式', () => {
      layer.blendMode = mode
    })
  }

  setOpacity(id: string, opacity: number): void {
    const layer = this.find(id)
    if (!layer) return
    const v = Math.min(1, Math.max(0, opacity))
    if (Math.abs(layer.opacity - v) < 1e-6) return
    this.edit('更改不透明度', () => {
      layer.opacity = v
    })
  }

  rename(id: string, name: string): void {
    const layer = this.find(id)
    if (!layer || layer.name === name || !name.trim()) return
    this.edit('重命名图层', () => {
      layer.name = name.trim()
    })
  }

  toggleVisible(id: string): void {
    const layer = this.find(id)
    if (!layer) return
    this.edit('切换可见性', () => {
      layer.isVisible = !layer.isVisible
    })
  }

  setTransform(id: string, t: Partial<Transform>): void {
    const layer = this.find(id)
    if (!layer) return
    this.edit('变换图层', () => {
      layer.transform = { ...layer.transform, ...t }
      // 形状图层按新尺寸重画，而不是把位图拉伸变形
      if (layer.shape && (t.size || t.origin)) this.rerenderShape(layer)
    })
  }

  flipLayer(id: string, axis: 'x' | 'y'): void {
    const layer = this.find(id)
    if (!layer) return
    this.edit('翻转图层', () => {
      if (axis === 'x') layer.transform.flipX = !layer.transform.flipX
      else layer.transform.flipY = !layer.transform.flipY
    })
  }

  addMask(id: string, reveal: boolean): void {
    const layer = this.find(id)
    if (!layer || layer.maskFile) return
    this.edit(reveal ? '添加蒙版（显示全部）' : '添加蒙版（隐藏全部）', () => {
      layer.maskFile = `${layer.id}.mask.png`
      layer.maskEnabled = true
      const entry = this.pixelStore.create(`${layer.id}:mask`, 1, 1)
      const ctx = entry.canvas.getContext('2d')!
      ctx.fillStyle = reveal ? '#ffffff' : '#000000'
      ctx.fillRect(0, 0, 1, 1)
      entry.version++
    })
  }

  deleteMask(id: string): void {
    const layer = this.find(id)
    if (!layer?.maskFile) return
    this.edit(
      '删除蒙版',
      () => {
        delete layer.maskFile
        delete layer.maskEnabled
        this.pixelStore.delete(`${layer.id}:mask`)
      },
      [`${layer.id}:mask`],
    )
  }

  toggleMaskEnabled(id: string): void {
    const layer = this.find(id)
    if (!layer?.maskFile) return
    this.edit('切换蒙版启用', () => {
      layer.maskEnabled = layer.maskEnabled === false
    })
  }

  /** 创建/取消剪贴蒙版（贴在下方同级图层上）。 */
  toggleClipping(id: string): void {
    const layer = this.find(id)
    if (!layer) return
    if (layer.maskSourceID) {
      this.edit('取消剪贴蒙版', () => {
        delete layer.maskSourceID
      })
      return
    }
    const siblings = this.childrenOf(layer.parentID ?? null)
    const i = siblings.findIndex((l) => l.id === id)
    const below = i > 0 ? siblings[i - 1]! : null
    if (!below || below.isGroup) return
    this.edit('创建剪贴蒙版', () => {
      layer.maskSourceID = below.id
    })
  }

  /** 图层效果的默认参数（开启某项时使用）。 */
  static readonly effectDefaults = {
    stroke: () => ({ size: 3, color: [0, 0, 0] as [number, number, number], opacity: 1, inside: false }),
    shadow: () => ({
      angle: 120,
      distance: 4,
      blur: 6,
      color: [0, 0, 0] as [number, number, number],
      opacity: 0.75,
    }),
    colorOverlay: () => ({ color: [1, 0, 0] as [number, number, number], opacity: 1 }),
    innerShadow: () => ({
      angle: 120,
      distance: 3,
      blur: 5,
      color: [0, 0, 0] as [number, number, number],
      opacity: 0.75,
    }),
    outerGlow: () => ({ size: 6, color: [1, 1, 0.6] as [number, number, number], opacity: 0.75 }),
    innerGlow: () => ({ size: 6, color: [1, 1, 1] as [number, number, number], opacity: 0.75 }),
  }

  /** 修改图层效果（进历史）。 */
  setEffects(id: string, mut: (fx: LayerEffects) => void, label = '图层效果'): void {
    const layer = this.find(id)
    if (!layer) return
    this.edit(
      label,
      () => {
        layer.effects = layer.effects ?? {}
        mut(layer.effects)
        if (Object.keys(layer.effects).length === 0) delete layer.effects
      },
      [id],
    )
  }

  /** 修改调整参数（进历史）。 */
  setAdjustment(id: string, mut: (adj: NonNullable<LayerRecord['adjustment']>) => void): void {
    const layer = this.find(id)
    if (!layer?.adjustment) return
    this.edit('调整参数', () => mut(layer.adjustment!))
  }

  /** 拖滑块时的实时预览（不进历史）。 */
  previewAdjustment(id: string, mut: (adj: NonNullable<LayerRecord['adjustment']>) => void): void {
    const layer = this.find(id)
    if (!layer?.adjustment) return
    mut(layer.adjustment)
    this.dirty = true
    this.emit()
  }

  /** 新建空文档。 */
  replaceDocument(manifest: Manifest): void {
    this.manifest = manifest
    this.pixelStore.clear()
    this.pixelStore.ensureFor(manifest)
    this.undoStack = []
    this.redoStack = []
    this.selection = []
    this.activeLayerID = manifest.layers[manifest.layers.length - 1]?.id ?? null
    this.projectDir = null
    this.dirty = false
    this.emit()
  }

  /** 载入已有项目。 */
  loadDocument(manifest: Manifest, dir: string | null): void {
    this.manifest = manifest
    this.pixelStore.clear()
    this.pixelStore.ensureFor(manifest)
    this.undoStack = []
    this.redoStack = []
    this.selection = []
    this.activeLayerID = manifest.activeLayerID ?? manifest.layers[manifest.layers.length - 1]?.id ?? null
    this.projectDir = dir
    this.dirty = false
    this.emit()
  }
}

export { createAdjustment }
export type { LayerRecord, Manifest, Transform, LayerPixels }
