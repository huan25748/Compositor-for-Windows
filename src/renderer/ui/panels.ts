/** 右侧面板：图层列表、属性、调整参数，以及相关对话框。 */
import { clear, el, field, hexToRgb01, modal, numberInput, rgb01ToHex, slider, toast } from './dom.ts'
import { ICONS } from './icons.ts'
import { colorPicker } from './colorpicker.ts'
import { Editor, type PixelStore } from '../state/editor.ts'
import {
  BLEND_MODES,
  type AdjustmentKind,
  type Adjustment,
  type BlendMode,
  type LayerEffects,
  type LayerRecord,
} from '../../shared/types.ts'

export interface LayerPanelCallbacks {
  onSelect(id: string, additive: boolean): void
  onToggleVisible(id: string): void
  onRename(id: string, name: string): void
  onToggleMask(id: string): void
  onDrop(id: string, targetId: string | null, position: 'above' | 'below' | 'inside'): void
  onAction(action: 'new' | 'newGroup' | 'newAdjust' | 'effects' | 'duplicate' | 'delete' | 'mask' | 'clip' | 'up' | 'down'): void
}

const ZERO = '0px'

export class LayersPanel {
  private renaming: string | null = null
  private dragId: string | null = null

  constructor(
    private readonly listEl: HTMLElement,
    private readonly footerEl: HTMLElement,
    private readonly countEl: HTMLElement,
    private readonly blendEl: HTMLSelectElement,
    private readonly opacityEl: HTMLInputElement,
    private readonly editor: Editor,
    private readonly pixels: PixelStore,
    private readonly cb: LayerPanelCallbacks,
  ) {
    this.fillBlendModes()
    this.bindChrome()
  }

  private fillBlendModes(): void {
    clear(this.blendEl)
    for (const mode of BLEND_MODES) {
      this.blendEl.append(el('option', { value: mode, text: mode }))
    }
    this.blendEl.addEventListener('change', () => {
      const active = this.editor.activeLayer
      if (active) this.editor.setBlendMode(active.id, this.blendEl.value as BlendMode)
    })
    const commitOpacity = (): void => {
      const active = this.editor.activeLayer
      if (!active) return
      const pct = Math.max(0, Math.min(100, Number(this.opacityEl.value)))
      this.opacityEl.value = String(Math.round(pct))
      this.editor.setOpacity(active.id, pct / 100)
    }
    this.opacityEl.addEventListener('change', commitOpacity)
    this.opacityEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') commitOpacity()
    })
  }

  private bindChrome(): void {
    const btn = (icon: keyof typeof ICONS, title: string, action: Parameters<LayerPanelCallbacks['onAction']>[0]): HTMLElement =>
      el('button', {
        class: 'icon-btn',
        title,
        html: ICONS[icon],
        onClick: () => this.cb.onAction(action),
      })
    clear(this.footerEl)
    this.footerEl.append(
      btn('plus', '新建图层', 'new'),
      btn('folder', '新建组', 'newGroup'),
      btn('adjust', '新建调整图层…', 'newAdjust'),
      // 图层效果入口放在这里（原在右侧属性面板）。多个效果可叠加，见 openEffectsDialog。
      btn('effects', '图层效果（描边、投影等）…', 'effects'),
      btn('copy', '复制图层', 'duplicate'),
      btn('masks', '添加蒙版（显示全部）', 'mask'),
      btn('clip', '创建/取消剪贴蒙版', 'clip'),
      btn('up', '上移一层', 'up'),
      btn('down', '下移一层', 'down'),
      btn('trash', '删除图层', 'delete'),
    )
  }

  /** 缩略图：把图层像素缩放画进一个小 canvas。 */
  private thumbnail(layer: LayerRecord): HTMLElement {
    const box = el('div', { class: 'layer-thumb' })
    if (layer.isGroup) {
      box.innerHTML = ICONS.folder
      box.style.color = 'var(--text-dim)'
      box.style.display = 'grid'
      box.style.placeItems = 'center'
      const svg = box.querySelector('svg')
      if (svg) {
        svg.style.width = '16px'
        svg.style.height = '16px'
        svg.style.fill = 'none'
        svg.style.stroke = 'currentColor'
      }
      return box
    }
    if (layer.adjustment) {
      box.append(el('span', { class: 'mask-mark', text: '调整' }))
      return box
    }
    const px = this.pixels.get(layer.id)
    if (!px) return box
    const c = document.createElement('canvas')
    c.width = 30
    c.height = 26
    const ctx = c.getContext('2d')
    if (ctx) {
      const scale = Math.min(30 / px.canvas.width, 26 / px.canvas.height)
      const w = Math.max(1, px.canvas.width * scale)
      const h = Math.max(1, px.canvas.height * scale)
      ctx.drawImage(px.canvas, (30 - w) / 2, (26 - h) / 2, w, h)
    }
    box.append(c)
    return box
  }

  render(): void {
    const editor = this.editor
    clear(this.listEl)
    const rows = editor.flattenForPanel()
    this.countEl.textContent = rows.length ? `${rows.length} 个` : ''

    if (rows.length === 0) {
      this.listEl.append(el('div', { class: 'empty-note', text: '还没有图层。用下方的 + 新建，或从「文件 → 导入图像」添加。' }))
    }

    for (const { layer, depth } of rows) {
      const selected = editor.selection.includes(layer.id)
      const row = el('div', {
        class: `layer-row${selected ? ' selected' : ''}${editor.activeLayerID === layer.id ? ' active' : ''}`,
        'data-id': layer.id,
        draggable: 'true',
        style: { paddingLeft: `${6 + depth * 12}px` },
      })

      const eye = el('button', {
        class: `layer-eye${layer.isVisible ? '' : ' off'}`,
        title: layer.isVisible ? '隐藏' : '显示',
        html: layer.isVisible ? ICONS.eye : ICONS.eyeOff,
        onClick: (ev: Event) => {
          ev.stopPropagation()
          this.cb.onToggleVisible(layer.id)
        },
      })

      const thumb = this.thumbnail(layer)
      if (layer.maskFile) {
        const badge = el('button', {
          class: 'icon-btn',
          style: { width: '14px', height: '14px', position: 'absolute', marginLeft: '20px', marginTop: '16px' },
          title: layer.maskEnabled === false ? '蒙版已停用（点击启用）' : '蒙版已启用（点击停用）',
          html: ICONS.mask,
          onClick: (ev: Event) => {
            ev.stopPropagation()
            this.cb.onToggleMask(layer.id)
          },
        })
        thumb.style.position = 'relative'
        thumb.append(badge)
      }

      const nameCell = el('div', { class: 'layer-name' })
      if (this.renaming === layer.id) {
        const input = el('input', { class: 'rename-input', value: layer.name })
        input.addEventListener('click', (ev) => ev.stopPropagation())
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            this.renaming = null
            this.cb.onRename(layer.id, input.value)
          } else if (ev.key === 'Escape') {
            this.renaming = null
            input.value = layer.name
            this.render()
          }
        })
        input.addEventListener('blur', () => {
          if (this.renaming !== layer.id) return
          this.renaming = null
          this.cb.onRename(layer.id, input.value)
        })
        nameCell.append(input)
        queueMicrotask(() => {
          input.focus()
          input.select()
        })
      } else {
        nameCell.textContent = layer.name || '（未命名）'
      }

      const badges = el('div', { class: 'layer-badges' })
      if (layer.blendMode !== 'Normal') badges.append(el('span', { class: 'badge', text: layer.blendMode.replace('Linear Dodge (Add)', 'Add') }))
      if (layer.opacity < 1) badges.append(el('span', { class: 'badge', text: `${Math.round(layer.opacity * 100)}%` }))
      if (layer.maskSourceID) badges.append(el('span', { class: 'badge', text: '剪贴' }))
      if (!layer.isVisible) badges.append(el('span', { class: 'badge', text: '隐藏' }))

      row.append(eye, thumb, nameCell, badges)

      row.addEventListener('click', (ev) => this.cb.onSelect(layer.id, ev.shiftKey || ev.ctrlKey))
      row.addEventListener('dblclick', () => {
        this.renaming = layer.id
        this.render()
      })

      // —— 拖拽排序 ——
      row.addEventListener('dragstart', (ev) => {
        this.dragId = layer.id
        row.classList.add('dragging')
        ev.dataTransfer?.setData('text/plain', layer.id)
      })
      row.addEventListener('dragend', () => {
        this.dragId = null
        row.classList.remove('dragging')
        this.listEl.querySelectorAll('.drop-above,.drop-below,.drop-inside').forEach((n) =>
          n.classList.remove('drop-above', 'drop-below', 'drop-inside'),
        )
      })
      row.addEventListener('dragover', (ev) => {
        if (!this.dragId || this.dragId === layer.id) return
        ev.preventDefault()
        const r = row.getBoundingClientRect()
        const t = (ev.clientY - r.top) / r.height
        row.classList.remove('drop-above', 'drop-below', 'drop-inside')
        if (layer.isGroup && t > 0.3 && t < 0.7) row.classList.add('drop-inside')
        else if (t < 0.5) row.classList.add('drop-above')
        else row.classList.add('drop-below')
      })
      row.addEventListener('drop', (ev) => {
        ev.preventDefault()
        if (!this.dragId || this.dragId === layer.id) return
        const pos = row.classList.contains('drop-inside')
          ? 'inside'
          : row.classList.contains('drop-above')
            ? 'above'
            : 'below'
        const id = this.dragId
        this.dragId = null
        this.cb.onDrop(id, layer.id, pos)
      })

      this.listEl.append(row)
    }

    // 顶层拖放区（拖到空白处 = 移出组，放到最底）
    this.listEl.ondragover = (ev) => {
      if (this.dragId) ev.preventDefault()
    }
    this.listEl.ondrop = (ev) => {
      if (!this.dragId) return
      if ((ev.target as HTMLElement).closest('.layer-row')) return
      ev.preventDefault()
      const id = this.dragId
      this.dragId = null
      this.cb.onDrop(id, null, 'above')
    }

    // 顶部工具栏反映当前图层
    const active = editor.activeLayer
    const multi = editor.selection.length > 1
    this.blendEl.disabled = !active || active.isGroup || multi
    this.blendEl.value = active && !multi ? active.blendMode : 'Normal'
    this.opacityEl.disabled = !active || multi
    this.opacityEl.value = String(active && !multi ? Math.round(active.opacity * 100) : 100)
  }
}

/** 属性面板：当前图层的变换、蒙版、剪贴等。 */
export class PropsPanel {
  constructor(
    private readonly titleEl: HTMLElement,
    private readonly bodyEl: HTMLElement,
    private readonly editor: Editor,
    private readonly onChanged: () => void,
  ) {}

  render(): void {
    const layer = this.editor.activeLayer
    clear(this.bodyEl)
    if (!layer) {
      this.titleEl.textContent = '属性'
      this.bodyEl.append(el('div', { class: 'empty-note', text: '未选择图层。' }))
      return
    }
    this.titleEl.textContent = layer.isGroup ? '组属性' : layer.adjustment ? '调整图层' : '图层属性'

    const t = layer.transform
    const row = (label: string, control: HTMLElement): HTMLElement => el('div', { class: 'prop-row' }, [el('label', { text: label }), control])

    const commit = (patch: Partial<typeof t>): void => {
      this.editor.setTransform(layer.id, patch)
      this.onChanged()
    }

    // 位置与尺寸
    const x = numberInput(t.origin[0], { step: 1 })
    const y = numberInput(t.origin[1], { step: 1 })
    x.addEventListener('change', () => commit({ origin: [Number(x.value), t.origin[1]] }))
    y.addEventListener('change', () => commit({ origin: [t.origin[0], Number(y.value)] }))
    const w = numberInput(t.size[0], { min: 1, step: 1 })
    const h = numberInput(t.size[1], { min: 1, step: 1 })
    w.addEventListener('change', () => commit({ size: [Math.max(1, Number(w.value)), t.size[1]] }))
    h.addEventListener('change', () => commit({ size: [t.size[0], Math.max(1, Number(h.value))] }))

    const rot = numberInput(t.rotation, { step: 1 })
    rot.addEventListener('change', () => commit({ rotation: Number(rot.value) }))

    this.bodyEl.append(
      row('位置 X / Y', el('div', { class: 'prop-pair' }, [x, y])),
      row('大小 宽 / 高', el('div', { class: 'prop-pair' }, [w, h])),
      row('旋转（度）', rot),
      el('div', { class: 'prop-hint', text: layer.isGroup ? '组的变换用于其蒙版范围。' : '变换是非破坏性的：缩放图层不会损失原始像素。' }),
    )

    if (!layer.isGroup && !layer.adjustment) {
      const sampling = el('select')
      for (const s of ['High quality', 'Smooth', 'Nearest'] as const) {
        sampling.append(el('option', { value: s, text: s === 'High quality' ? '高质量' : s === 'Smooth' ? '平滑' : '最近邻' }))
      }
      sampling.value = t.sampling
      sampling.addEventListener('change', () => commit({ sampling: sampling.value as typeof t.sampling }))
      this.bodyEl.append(row('采样', sampling))
    }

    // 蒙版与剪贴
    const maskRow = el('div', { class: 'prop-row' }, [
      el('label', { text: '蒙版' }),
      el('div', { class: 'prop-pair' }, [
        el('button', {
          class: 'btn',
          text: layer.maskFile ? '删除蒙版' : '添加蒙版',
          onClick: () => {
            if (layer.maskFile) this.editor.deleteMask(layer.id)
            else this.editor.addMask(layer.id, true)
            this.onChanged()
          },
        }),
        el('button', {
          class: 'btn',
          text: layer.maskFile ? (layer.maskEnabled === false ? '启用蒙版' : '停用蒙版') : '添加隐藏蒙版',
          onClick: () => {
            if (layer.maskFile) this.editor.toggleMaskEnabled(layer.id)
            else this.editor.addMask(layer.id, false)
            this.onChanged()
          },
        }),
      ]),
    ])
    this.bodyEl.append(maskRow)

    this.bodyEl.append(
      el('div', { class: 'prop-row' }, [
        el('label', { text: '剪贴蒙版' }),
        el('button', {
          class: 'btn',
          text: layer.maskSourceID ? '取消剪贴蒙版' : '创建剪贴蒙版',
          onClick: () => {
            this.editor.toggleClipping(layer.id)
            this.onChanged()
          },
        }),
      ]),
    )

    if (!layer.isGroup && !layer.adjustment) {
      const count = layer.effects ? Object.keys(layer.effects).length : 0
      this.bodyEl.append(
        el('div', { class: 'prop-row' }, [
          el('label', { text: '图层效果' }),
          el('button', {
            class: 'btn',
            text: count ? `编辑效果（${count}）…` : '添加效果…',
            onClick: () => openEffectsDialog(this.editor, layer, () => this.onChanged()),
          }),
        ]),
      )
    }

    if (layer.adjustment) {
      this.bodyEl.append(el('div', { class: 'prop-hint', text: `类型：${layer.adjustment.kind}。在「调整图层」菜单或下方按钮中修改参数。` }))
    }
  }
}

/** 调整图层的参数对话框。 */
export function openAdjustmentDialog(
  editor: Editor,
  layer: LayerRecord,
  onChanged: () => void,
): void {
  const adj = layer.adjustment
  if (!adj) return
  const body: HTMLElement[] = []

  const addSlider = (
    label: string,
    value: number,
    min: number,
    max: number,
    step: number,
    apply: (v: number) => void,
  ): void => {
    body.push(
      el('div', { class: 'prop-row' }, [
        el('label', { text: label }),
        slider(
          value,
          min,
          max,
          step,
          (v) => {
            editor.previewAdjustment(layer.id, () => apply(v))
            onChanged()
          },
          (v) => {
            editor.setAdjustment(layer.id, () => apply(v))
            onChanged()
          },
        ),
      ]),
    )
  }

  switch (adj.kind) {
    case 'Hue/Saturation':
      addSlider('色相', adj.hue, -180, 180, 1, (v) => (adj.hue = v))
      addSlider('饱和度', adj.saturation, -100, 100, 1, (v) => (adj.saturation = v))
      addSlider('明度', adj.lightness, -100, 100, 1, (v) => (adj.lightness = v))
      body.push(
        el('div', { class: 'prop-row' }, [
          el('label', { text: '着色' }),
          el('input', {
            type: 'checkbox',
            checked: adj.colorize,
            onChange: (ev: Event) => {
              const v = (ev.target as HTMLInputElement).checked
              editor.setAdjustment(layer.id, () => (adj.colorize = v))
              onChanged()
            },
          }),
        ]),
      )
      break
    case 'Levels': {
      const r = adj.levels.ranges[0]!
      addSlider('黑场', r.black, 0, 254, 1, (v) => (r.black = v))
      addSlider('中间调', r.gamma, 0.1, 9.99, 0.01, (v) => (r.gamma = v))
      addSlider('白场', r.white, 1, 255, 1, (v) => (r.white = v))
      addSlider('输出黑', r.outputBlack, 0, 255, 1, (v) => (r.outputBlack = v))
      addSlider('输出白', r.outputWhite, 0, 255, 1, (v) => (r.outputWhite = v))
      break
    }
    case 'Exposure':
      addSlider('曝光', adj.exposureSettings.exposure, -5, 5, 0.01, (v) => (adj.exposureSettings.exposure = v))
      addSlider('偏移', adj.exposureSettings.offset, -0.5, 0.5, 0.005, (v) => (adj.exposureSettings.offset = v))
      addSlider('伽马', adj.exposureSettings.gamma, 0.1, 3, 0.01, (v) => (adj.exposureSettings.gamma = v))
      break
    case 'Black & White':
      addSlider('红', adj.blackWhiteSettings.red, -200, 300, 1, (v) => (adj.blackWhiteSettings.red = v))
      addSlider('黄', adj.blackWhiteSettings.yellow, -200, 300, 1, (v) => (adj.blackWhiteSettings.yellow = v))
      addSlider('绿', adj.blackWhiteSettings.green, -200, 300, 1, (v) => (adj.blackWhiteSettings.green = v))
      addSlider('青', adj.blackWhiteSettings.cyan, -200, 300, 1, (v) => (adj.blackWhiteSettings.cyan = v))
      addSlider('蓝', adj.blackWhiteSettings.blue, -200, 300, 1, (v) => (adj.blackWhiteSettings.blue = v))
      addSlider('洋红', adj.blackWhiteSettings.magenta, -200, 300, 1, (v) => (adj.blackWhiteSettings.magenta = v))
      break
    case 'Color Balance': {
      const cb = adj.colorBalanceSettings
      addSlider('阴影：青↔红', cb.shadowCyanRed, -100, 100, 1, (v) => (cb.shadowCyanRed = v))
      addSlider('阴影：洋红↔绿', cb.shadowMagentaGreen, -100, 100, 1, (v) => (cb.shadowMagentaGreen = v))
      addSlider('阴影：黄↔蓝', cb.shadowYellowBlue, -100, 100, 1, (v) => (cb.shadowYellowBlue = v))
      addSlider('中间调：青↔红', cb.midCyanRed, -100, 100, 1, (v) => (cb.midCyanRed = v))
      addSlider('中间调：洋红↔绿', cb.midMagentaGreen, -100, 100, 1, (v) => (cb.midMagentaGreen = v))
      addSlider('中间调：黄↔蓝', cb.midYellowBlue, -100, 100, 1, (v) => (cb.midYellowBlue = v))
      addSlider('高光：青↔红', cb.highlightCyanRed, -100, 100, 1, (v) => (cb.highlightCyanRed = v))
      addSlider('高光：洋红↔绿', cb.highlightMagentaGreen, -100, 100, 1, (v) => (cb.highlightMagentaGreen = v))
      addSlider('高光：黄↔蓝', cb.highlightYellowBlue, -100, 100, 1, (v) => (cb.highlightYellowBlue = v))
      break
    }
    case 'Gaussian Blur':
      addSlider('半径', adj.blurRadius ?? 4, 0.1, 250, 0.1, (v) => (adj.blurRadius = v))
      break
    case 'Motion Blur':
      addSlider('角度', adj.motionAngle ?? 0, -90, 90, 1, (v) => (adj.motionAngle = v))
      addSlider('距离', adj.motionDistance ?? 10, 1, 2000, 1, (v) => (adj.motionDistance = v))
      break
    case 'Add Noise':
      addSlider('数量', adj.noiseAmount ?? 10, 0.1, 400, 0.1, (v) => (adj.noiseAmount = v))
      break
    case 'Grain':
      addSlider('数量', adj.grainSettings.amount, 0, 100, 0.5, (v) => (adj.grainSettings.amount = v))
      addSlider('大小', adj.grainSettings.size, 1, 40, 1, (v) => (adj.grainSettings.size = v))
      break
    case 'Invert':
      body.push(el('div', { class: 'prop-hint', text: '反相没有可调参数。用不透明度控制强度。' }))
      break
    case 'Gradient Map':
      body.push(el('div', { class: 'prop-hint', text: '渐变映射使用黑→白的默认映射，可通过 .comp 中的 gradientMapSettings 精确指定两端颜色。' }))
      break
    case 'Curves':
      body.push(el('div', { class: 'prop-hint', text: '曲线控制点可在 .comp 的 curves 字段中精确编辑；此处暂不支持拖拽编辑，使用默认折线。' }))
      break
    default:
      body.push(el('div', { class: 'prop-hint', text: '该类型暂无可调参数。' }))
  }

  modal({
    title: `调整：${adj.kind}`,
    body,
    confirmLabel: '完成',
    infoOnly: true,
  })
}

export type { AdjustmentKind, Adjustment }
export { toast, field }

/** 各类图层效果的字段配置（决定对话框里出现哪些控件）。 */
const EFFECT_SPECS: {
  key: keyof LayerEffects
  label: string
  numeric: { key: string; label: string; min: number; max: number; step: number }[]
  inside?: boolean
}[] = [
  {
    key: 'shadow',
    label: '投影',
    numeric: [
      { key: 'angle', label: '角度', min: -180, max: 180, step: 1 },
      { key: 'distance', label: '距离', min: 0, max: 500, step: 1 },
      { key: 'blur', label: '模糊', min: 0, max: 500, step: 1 },
    ],
  },
  {
    key: 'innerShadow',
    label: '内阴影',
    numeric: [
      { key: 'angle', label: '角度', min: -180, max: 180, step: 1 },
      { key: 'distance', label: '距离', min: 0, max: 500, step: 1 },
      { key: 'blur', label: '模糊', min: 0, max: 500, step: 1 },
    ],
  },
  { key: 'outerGlow', label: '外发光', numeric: [{ key: 'size', label: '大小', min: 0, max: 500, step: 1 }] },
  { key: 'innerGlow', label: '内发光', numeric: [{ key: 'size', label: '大小', min: 0, max: 500, step: 1 }] },
  {
    key: 'stroke',
    label: '描边',
    numeric: [{ key: 'size', label: '大小', min: 0, max: 500, step: 1 }],
    inside: true,
  },
  { key: 'colorOverlay', label: '颜色叠加', numeric: [] },
]

/**
 * 图层效果编辑对话框。
 *
 * 参数原样写进官方 effects 记录，Mac 版打开后可以继续编辑。
 * 未启用的效果也会列出参数（置灰），这样切换开关不必重开对话框。
 */
export function openEffectsDialog(editor: Editor, layer: LayerRecord, onChanged: () => void): void {
  const body: HTMLElement[] = []
  const bag = (): Record<string, Record<string, unknown>> =>
    (layer.effects ?? {}) as unknown as Record<string, Record<string, unknown>>
  const defaultsFor = (key: string): Record<string, unknown> =>
    ((Editor.effectDefaults as unknown as Record<string, () => Record<string, unknown>>)[key]?.() ??
      {}) as Record<string, unknown>

  for (const spec of EFFECT_SPECS) {
    const key = spec.key as string
    const enabled = Boolean(bag()[key])
    // 未启用时用默认值展示，仅用于预览参数范围
    const values: Record<string, unknown> = enabled ? bag()[key]! : defaultsFor(key)

    const toggle = el('input', {
      type: 'checkbox',
      checked: enabled,
      onChange: (ev: Event) => {
        const on = (ev.target as HTMLInputElement).checked
        editor.setEffects(
          layer.id,
          (f) => {
            const record = f as unknown as Record<string, unknown>
            if (on) record[key] = defaultsFor(key)
            else delete record[key]
          },
          on ? `添加${spec.label}` : `移除${spec.label}`,
        )
        onChanged()
      },
    })
    body.push(el('div', { class: 'prop-row' }, [el('label', { text: spec.label }), toggle]))

    const setKey = (k: string, v: unknown): void => {
      editor.setEffects(layer.id, () => {
        values[k] = v
      })
      onChanged()
    }

    if ('color' in values) {
      const rgb = (values['color'] as [number, number, number]) ?? [0, 0, 0]
      // 自绘取色器：原生颜色控件的弹窗由系统绘制，风格无法统一
      const picker = colorPicker({
        value: rgb01ToHex(rgb[0], rgb[1], rgb[2]),
        onChange: (hex) => setKey('color', hexToRgb01(hex)),
      })
      if (!enabled) {
        // 效果未启用时不允许改颜色（原来用 input.disabled 实现）
        picker.root.style.pointerEvents = 'none'
        picker.root.style.opacity = '0.5'
      }
      body.push(
        el('div', { class: 'prop-row' }, [el('label', { text: `　${spec.label}颜色` }), picker.root]),
      )
    }

    for (const n of spec.numeric) {
      const control = slider(
        Number(values[n.key] ?? n.min),
        n.min,
        n.max,
        n.step,
        (v) => setKey(n.key, v),
        (v) => setKey(n.key, v),
      )
      if (!enabled) control.querySelectorAll('input').forEach((i) => (i.disabled = true))
      body.push(el('div', { class: 'prop-row' }, [el('label', { text: `　${n.label}` }), control]))
    }

    if ('opacity' in values) {
      const control = slider(
        Number(values['opacity'] ?? 1),
        0,
        1,
        0.01,
        (v) => setKey('opacity', v),
        (v) => setKey('opacity', v),
      )
      if (!enabled) control.querySelectorAll('input').forEach((i) => (i.disabled = true))
      body.push(el('div', { class: 'prop-row' }, [el('label', { text: '　不透明度' }), control]))
    }

    if (spec.inside) {
      const inside = el('input', { type: 'checkbox', checked: Boolean(values['inside']) })
      inside.disabled = !enabled
      inside.addEventListener('change', () => setKey('inside', inside.checked))
      body.push(el('div', { class: 'prop-row' }, [el('label', { text: '　内侧描边' }), inside]))
    }
  }

  body.push(
    el('div', {
      class: 'prop-hint',
      text: '效果按官方顺序叠加：投影 → 外发光 → 外侧描边 → 图层 → 颜色叠加 → 内发光 → 内阴影 → 内侧描边。',
    }),
  )

  modal({
    title: `图层效果：${layer.name}`,
    body,
    confirmLabel: '完成',
    infoOnly: true,
  })
}
