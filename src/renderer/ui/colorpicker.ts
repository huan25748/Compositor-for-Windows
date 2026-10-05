/**
 * 自绘颜色选择器。
 *
 * 为什么不用 `<input type="color">`：点开后的取色面板由**系统**绘制，样式完全不受
 * CSS 控制 —— 在深色界面里会突然弹出一个浅色窗口，风格割裂。这里自己画：
 * 饱和度/明度方块 + 色相条 + 十六进制输入。
 */
import { el } from './dom.ts'

type RGB = [number, number, number]

function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s
  const hp = (h % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const m = v - c
  const table: RGB[] = [
    [c, x, 0],
    [x, c, 0],
    [0, c, x],
    [0, x, c],
    [x, 0, c],
    [c, 0, x],
  ]
  const [r, g, b] = table[Math.floor(hp) % 6]!
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ]
}

function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rr = r / 255
  const gg = g / 255
  const bb = b / 255
  const max = Math.max(rr, gg, bb)
  const min = Math.min(rr, gg, bb)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rr) h = 60 * (((gg - bb) / d) % 6)
    else if (max === gg) h = 60 * ((bb - rr) / d + 2)
    else h = 60 * ((rr - gg) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max === 0 ? 0 : d / max, v: max }
}

function hexOf([r, g, b]: RGB): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

function parseHex(hex: string): RGB {
  const h = hex.replace('#', '').trim()
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  if (!/^[0-9a-f]{6}$/i.test(full)) return [255, 255, 255]
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

export interface ColorPickerOptions {
  value: string
  onChange: (hex: string) => void
}

export interface ColorPickerHandle {
  root: HTMLElement
  setValue: (hex: string) => void
  isOpen: () => boolean
}

export function colorPicker(opts: ColorPickerOptions): ColorPickerHandle {
  let current = opts.value
  const parsed = parseHex(current)
  let { h, s, v } = rgbToHsv(parsed[0], parsed[1], parsed[2])

  const root = el('div', { class: 'color-picker' })
  const swatch = el('button', { class: 'color-picker-swatch', type: 'button' })
  const panel = el('div', { class: 'color-picker-panel', hidden: true })
  const svCanvas = el('canvas', { class: 'color-picker-sv', width: 168, height: 120 })
  const hue = el('div', { class: 'color-picker-hue' })
  const hueKnob = el('div', { class: 'color-picker-hue-knob' })
  hue.append(hueKnob)
  const hexInput = el('input', { class: 'color-picker-hex', type: 'text', maxLength: 7 })
  const preview = el('div', { class: 'color-picker-preview' })
  const row = el('div', { class: 'color-picker-row' }, [preview, hexInput])
  panel.append(svCanvas, hue, row)
  root.append(swatch, panel)
  document.body.append(panel)

  const svCtx = svCanvas.getContext('2d')!

  const paintSv = (): void => {
    const w = svCanvas.width
    const hh = svCanvas.height
    // 底色 = 当前色相的纯色
    svCtx.fillStyle = hexOf(hsvToRgb(h, 1, 1))
    svCtx.fillRect(0, 0, w, hh)
    // 横向叠白（饱和度），纵向叠黑（明度）
    const white = svCtx.createLinearGradient(0, 0, w, 0)
    white.addColorStop(0, 'rgba(255,255,255,1)')
    white.addColorStop(1, 'rgba(255,255,255,0)')
    svCtx.fillStyle = white
    svCtx.fillRect(0, 0, w, hh)
    const black = svCtx.createLinearGradient(0, 0, 0, hh)
    black.addColorStop(0, 'rgba(0,0,0,0)')
    black.addColorStop(1, 'rgba(0,0,0,1)')
    svCtx.fillStyle = black
    svCtx.fillRect(0, 0, w, hh)
  }

  const paint = (): void => {
    swatch.style.background = current
    preview.style.background = current
    hexInput.value = current
    hueKnob.style.left = `${(h / 360) * 100}%`
    paintSv()
    // 光标位置
    svCanvas.style.setProperty('--sv-x', `${s * 100}%`)
    svCanvas.style.setProperty('--sv-y', `${(1 - v) * 100}%`)
  }

  const commit = (): void => {
    current = hexOf(hsvToRgb(h, s, v))
    paint()
    opts.onChange(current)
  }

  const dragSv = (ev: PointerEvent): void => {
    const box = svCanvas.getBoundingClientRect()
    s = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width))
    v = Math.min(1, Math.max(0, 1 - (ev.clientY - box.top) / box.height))
    commit()
  }
  svCanvas.addEventListener('pointerdown', (ev) => {
    svCanvas.setPointerCapture(ev.pointerId)
    dragSv(ev)
  })
  svCanvas.addEventListener('pointermove', (ev) => {
    if (svCanvas.hasPointerCapture(ev.pointerId)) dragSv(ev)
  })

  const dragHue = (ev: PointerEvent): void => {
    const box = hue.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width))
    h = t * 360
    commit()
  }
  hue.addEventListener('pointerdown', (ev) => {
    hue.setPointerCapture(ev.pointerId)
    dragHue(ev)
  })
  hue.addEventListener('pointermove', (ev) => {
    if (hue.hasPointerCapture(ev.pointerId)) dragHue(ev)
  })

  hexInput.addEventListener('input', () => {
    const hex = hexInput.value.trim()
    if (!/^#?[0-9a-f]{6}$/i.test(hex)) return
    const norm = hex.startsWith('#') ? hex : `#${hex}`
    const rgb = parseHex(norm)
    const next = rgbToHsv(rgb[0], rgb[1], rgb[2])
    h = next.h
    s = next.s
    v = next.v
    current = norm.toLowerCase()
    paint()
    opts.onChange(current)
  })
  hexInput.addEventListener('keydown', (ev) => ev.stopPropagation())

  const position = (): void => {
    const box = swatch.getBoundingClientRect()
    // 必须在面板显示之后调用，否则量不到尺寸
    const w = panel.offsetWidth || 200
    const h = panel.offsetHeight || 280
    // 水平也要收边：否则靠近窗口右侧时面板会超出、被裁掉
    const left = Math.max(8, Math.min(box.left, window.innerWidth - w - 8))
    panel.style.left = `${Math.round(left)}px`
    const below = window.innerHeight - box.bottom
    panel.style.top =
      below < h + 8 && box.top > h + 8
        ? `${Math.round(box.top - h - 4)}px`
        : `${Math.round(box.bottom + 4)}px`
  }
  const close = (): void => {
    panel.hidden = true
  }
  swatch.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (panel.hidden) {
      // 先显示再定位：隐藏时 offsetWidth/offsetHeight 都是 0，量不出真实尺寸
      panel.hidden = false
      hexInput.value = current
      position()
    } else {
      close()
    }
  })
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (panel.hidden) return
      const target = ev.target
      if (target instanceof Node && (root.contains(target) || panel.contains(target))) return
      close()
    },
    true,
  )

  paint()

  return {
    root,
    setValue: (hex: string): void => {
      const rgb = parseHex(hex)
      const next = rgbToHsv(rgb[0], rgb[1], rgb[2])
      h = next.h
      s = next.s
      v = next.v
      current = hex
      paint()
    },
    isOpen: () => !panel.hidden,
  }
}
