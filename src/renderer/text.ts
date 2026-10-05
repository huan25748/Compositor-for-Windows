/**
 * 文字图层的测量与渲染。
 *
 * 官方格式里文字图层仍是普通像素图层（PNG 是显示与导出的回退），
 * 另有 `text` 元数据记录内容与样式。这里负责把元数据画到图层画布上。
 *
 * 支持富文本：`fontRuns` / `colorRuns` 是官方 .comp 的字段（部分文字换字体、换颜色），
 * `sizeRuns` 是本机扩展（部分文字换字号，官方读到会忽略）。
 * 三者都按**字符**下标定位，换行符也算一个字符。
 */
import type { TextMetadata } from '../shared/types.ts'

/** 单个字符的有效样式（已把各 run 合并到整层默认值上）。 */
export interface CharStyle {
  fontName: string
  fontSize: number
  red: number
  green: number
  blue: number
}

/** 可写 letterSpacing 的 2D 上下文（Chromium 支持，用于字距）。 */
type SpacedContext = OffscreenCanvasRenderingContext2D & { letterSpacing?: string }

/** 构造某个样式的 canvas font 字符串。 */
function fontFor(style: CharStyle): string {
  return `${style.fontSize}px "${style.fontName}", "Microsoft YaHei UI", "PingFang SC", sans-serif`
}

/** 把上下文设成某个字符的字体与字距。 */
function applyFont(
  ctx: OffscreenCanvasRenderingContext2D,
  style: CharStyle,
  tracking: number,
): void {
  ctx.font = fontFor(style)
  const spaced = ctx as SpacedContext
  if (typeof spaced.letterSpacing === 'string') spaced.letterSpacing = `${tracking}px`
}

/** 两个样式是否等价（用于把连续同样式的字符合并成一段绘制）。 */
function sameStyle(a: CharStyle, b: CharStyle): boolean {
  return (
    a.fontName === b.fontName &&
    a.fontSize === b.fontSize &&
    a.red === b.red &&
    a.green === b.green &&
    a.blue === b.blue
  )
}

/** 解析每个字符的有效样式：先取整层默认值，再按 fontRuns / colorRuns / sizeRuns 覆盖。 */
export function charStyles(text: TextMetadata): CharStyle[] {
  const n = text.content.length
  const out: CharStyle[] = []
  for (let i = 0; i < n; i++) {
    out.push({
      fontName: text.fontName,
      fontSize: text.fontSize,
      red: text.red,
      green: text.green,
      blue: text.blue,
    })
  }
  const each = (
    runs: readonly { location: number; length: number }[] | undefined,
    fn: (style: CharStyle, run: { location: number; length: number }) => void,
  ): void => {
    if (!runs) return
    for (const run of runs) {
      const start = Math.max(0, Math.min(n, Math.floor(run.location)))
      const end = Math.max(start, Math.min(n, Math.floor(run.location + run.length)))
      for (let i = start; i < end; i++) fn(out[i]!, run)
    }
  }
  each(text.fontRuns, (s, r) => {
    const name = (r as { fontName?: string }).fontName
    if (name) s.fontName = name
  })
  each(text.colorRuns, (s, r) => {
    const c = r as { red?: number; green?: number; blue?: number }
    if (typeof c.red === 'number') s.red = c.red
    if (typeof c.green === 'number') s.green = c.green
    if (typeof c.blue === 'number') s.blue = c.blue
  })
  each(text.sizeRuns, (s, r) => {
    const size = (r as { fontSize?: number }).fontSize
    if (typeof size === 'number' && size > 0) s.fontSize = size
  })
  return out
}

/** 一行里连续的同样式字符。 */
export interface Span {
  text: string
  style: CharStyle
}

/** 折行：逐字符用它自己的字体测量。中文按字符断行，够用且不会拉断词。 */
export function wrapSpans(
  ctx: OffscreenCanvasRenderingContext2D,
  text: TextMetadata,
  styles: CharStyle[],
): Span[][] {
  const maxWidth = text.boxSize ? text.boxSize[0] : null
  const lines: Span[][] = []
  let line: Span[] = []
  let lineWidth = 0
  let index = 0

  const pushLine = (): void => {
    lines.push(line)
    line = []
    lineWidth = 0
  }
  const push = (ch: string, style: CharStyle, width: number): void => {
    const last = line[line.length - 1]
    if (last && sameStyle(last.style, style)) last.text += ch
    else line.push({ text: ch, style })
    lineWidth += width
  }

  for (const ch of text.content) {
    const style = styles[index]
    if (ch === '\n') {
      pushLine()
      index++
      continue
    }
    if (!style) break
    applyFont(ctx, style, text.tracking)
    const w = ctx.measureText(ch).width
    if (maxWidth && maxWidth > 0 && line.length > 0 && lineWidth + w > maxWidth) pushLine()
    push(ch, style, w)
    index++
  }
  pushLine()
  return lines
}

/** 描边需要在画布四周留出的余量。 */
function strokePad(text: TextMetadata): number {
  const s = text.textStroke
  return s && s.width > 0 ? Math.ceil(s.width) : 0
}

/** 一行的宽度（各段按各自字体测量）。 */
function spanWidth(
  ctx: OffscreenCanvasRenderingContext2D,
  spans: readonly Span[],
  tracking: number,
): number {
  let w = 0
  for (const span of spans) {
    applyFont(ctx, span.style, tracking)
    w += ctx.measureText(span.text).width
  }
  return w
}

/** 一行的行高：取该行最大的字号（富文本里字号可能不一致）。 */
function spanHeight(spans: readonly Span[], fallback: number): number {
  let size = fallback
  for (const span of spans) size = Math.max(size, span.style.fontSize)
  return size
}

/** 估算文字图层需要的画布尺寸。 */
export function measureText(text: TextMetadata): { width: number; height: number; lines: string[] } {
  const probe = new OffscreenCanvas(1, 1)
  const ctx = probe.getContext('2d')
  if (!ctx) return { width: 1, height: 1, lines: [] }

  const lines = wrapSpans(ctx, text, charStyles(text))
  const lineTexts = lines.map((spans) => spans.map((s) => s.text).join(''))

  if (text.boxSize) {
    return {
      width: Math.max(1, Math.round(text.boxSize[0])),
      height: Math.max(1, Math.round(text.boxSize[1])),
      lines: lineTexts,
    }
  }

  let width = 0
  let height = 0
  for (const spans of lines) {
    width = Math.max(width, spanWidth(ctx, spans, text.tracking))
    height += spanHeight(spans, text.fontSize) + text.lineSpacing
  }
  // 描边是沿字形外缘向外画的，画布四周要各留出 strokeWidth，否则会被切掉
  const pad = strokePad(text)
  return {
    width: Math.max(1, Math.ceil(width) + 2 + pad * 2),
    height: Math.max(1, Math.ceil(height) + pad * 2),
    lines: lineTexts,
  }
}

/** 把文字元数据渲染到给定画布（先清空）。逐段绘制，因此可以混字体、混颜色、混字号。 */
export function renderText(canvas: OffscreenCanvas, text: TextMetadata): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!text.content) return

  ctx.textBaseline = 'top'
  // 逐段画时自己算起点，就不用依赖 ctx.textAlign
  ctx.textAlign = 'left'

  const lines = wrapSpans(ctx, text, charStyles(text))
  const pad = strokePad(text)
  const stroke = text.textStroke
  let y = pad
  for (const spans of lines) {
    const w = spanWidth(ctx, spans, text.tracking)
    let x =
      text.alignment === 'left'
        ? pad
        : text.alignment === 'center'
          ? (canvas.width - w) / 2
          : canvas.width - w - pad

    // 先用 strokeText 沿字形外缘描一圈实色，再用 fillText 把字盖上去。
    // lineWidth 是以字形轮廓为中心向两侧各画一半，取 2×width 才等于「向外扩展 width」。
    if (stroke && stroke.width > 0) {
      ctx.lineJoin = 'round'
      ctx.miterLimit = 2
      ctx.strokeStyle = `rgb(${Math.round(stroke.red * 255)}, ${Math.round(
        stroke.green * 255,
      )}, ${Math.round(stroke.blue * 255)})`
      ctx.lineWidth = stroke.width * 2
      let sx = x
      for (const span of spans) {
        applyFont(ctx, span.style, text.tracking)
        ctx.strokeText(span.text, sx, y)
        sx += ctx.measureText(span.text).width
      }
    }

    for (const span of spans) {
      applyFont(ctx, span.style, text.tracking)
      ctx.fillStyle = `rgb(${Math.round(span.style.red * 255)}, ${Math.round(
        span.style.green * 255,
      )}, ${Math.round(span.style.blue * 255)})`
      ctx.fillText(span.text, x, y)
      x += ctx.measureText(span.text).width
    }
    y += spanHeight(spans, text.fontSize) + text.lineSpacing
  }
}

/** 常见字体的中文名。下拉框显示中文，value 仍是真实字体名以保证渲染正确。 */
export const FONT_CN_NAMES: Record<string, string> = {
  SimSun: '宋体',
  NSimSun: '新宋体',
  SimHei: '黑体',
  'Microsoft YaHei': '微软雅黑',
  'Microsoft YaHei UI': '微软雅黑 UI',
  KaiTi: '楷体',
  FangSong: '仿宋',
  DengXian: '等线',
  LiSu: '隶书',
  YouYuan: '幼圆',
  'Microsoft JhengHei': '微软正黑体',
  MingLiU: '细明体',
  PMingLiU: '新细明体',
  'DFKai-SB': '标楷体',
  STXihei: '华文细黑',
  STKaiti: '华文楷体',
  STSong: '华文宋体',
  STZhongsong: '华文中宋',
  STFangsong: '华文仿宋',
  STXingkai: '华文行楷',
  STXinwei: '华文新魏',
  STLiti: '华文隶书',
  STHupo: '华文琥珀',
  STCaiyun: '华文彩云',
}

/** 下拉框里显示的名字：中文名字体带上中文说明。 */
export function fontLabel(name: string): string {
  const cn = FONT_CN_NAMES[name]
  return cn ? `${cn}（${name}）` : name
}

/** 中文字体排前面，其余按字母序。 */
export function sortFonts(fonts: string[]): string[] {
  const rank = (n: string): number => (FONT_CN_NAMES[n] ? 0 : 1)
  return [...fonts].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

/** 系统可用字体（供样式下拉框使用）。 */
export const FONT_CHOICES = [
  { label: '系统默认', value: 'Microsoft YaHei UI' },
  { label: '微软雅黑', value: 'Microsoft YaHei' },
  { label: '宋体', value: 'SimSun' },
  { label: '黑体', value: 'SimHei' },
  { label: '楷体', value: 'KaiTi' },
  { label: '等线', value: 'DengXian' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Helvetica', value: 'Helvetica' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Courier New', value: 'Courier New' },
] as const
