/**
 * 文字图层的测量与渲染。
 *
 * 官方格式里文字图层仍是普通像素图层（PNG 是显示与导出的回退），
 * 另有 `text` 元数据记录内容与样式。这里负责把元数据画到图层画布上。
 */
import type { TextMetadata } from '../shared/types.ts'

/** 构造与元数据一致的 canvas font 字符串。 */
function fontOf(text: TextMetadata): string {
  return `${text.fontSize}px "${text.fontName}", "Microsoft YaHei UI", "PingFang SC", sans-serif`
}

/** 可写 letterSpacing 的 2D 上下文（Chromium 支持，用于字距）。 */
type SpacedContext = OffscreenCanvasRenderingContext2D & { letterSpacing?: string }

/** 按段落与可选宽度折行。中文按字符断行，够用且不会拉断词。 */
export function wrapText(
  ctx: OffscreenCanvasRenderingContext2D,
  content: string,
  maxWidth: number | null,
): string[] {
  const out: string[] = []
  for (const paragraph of content.split('\n')) {
    if (!maxWidth || maxWidth <= 0) {
      out.push(paragraph)
      continue
    }
    let line = ''
    for (const ch of paragraph) {
      const candidate = line + ch
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line)
        line = ch
      } else {
        line = candidate
      }
    }
    out.push(line)
  }
  return out
}

/** 估算文字图层需要的画布尺寸。 */
export function measureText(text: TextMetadata): { width: number; height: number; lines: string[] } {
  const probe = new OffscreenCanvas(1, 1)
  const ctx = probe.getContext('2d')
  if (!ctx) return { width: 1, height: 1, lines: [] }
  ctx.font = fontOf(text)
  const spaced = ctx as SpacedContext
  if (typeof spaced.letterSpacing === 'string') spaced.letterSpacing = `${text.tracking}px`

  const lines = wrapText(ctx, text.content, text.boxSize ? text.boxSize[0] : null)
  let width = 0
  for (const line of lines) width = Math.max(width, ctx.measureText(line).width)
  const lineHeight = text.fontSize + text.lineSpacing
  const height = Math.max(lineHeight, lines.length * lineHeight)
  if (text.boxSize) {
    return {
      width: Math.max(1, Math.round(text.boxSize[0])),
      height: Math.max(1, Math.round(text.boxSize[1])),
      lines,
    }
  }
  return {
    width: Math.max(1, Math.ceil(width) + 2),
    height: Math.max(1, Math.ceil(height)),
    lines,
  }
}

/** 把文字元数据渲染到给定画布（先清空）。 */
export function renderText(canvas: OffscreenCanvas, text: TextMetadata): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  if (!text.content) return

  ctx.font = fontOf(text)
  const spaced = ctx as SpacedContext
  if (typeof spaced.letterSpacing === 'string') spaced.letterSpacing = `${text.tracking}px`
  ctx.textBaseline = 'top'
  ctx.fillStyle = `rgb(${Math.round(text.red * 255)}, ${Math.round(text.green * 255)}, ${Math.round(
    text.blue * 255,
  )})`

  const maxWidth = text.boxSize ? text.boxSize[0] : null
  const lines = wrapText(ctx, text.content, maxWidth)
  const lineHeight = text.fontSize + text.lineSpacing

  ctx.textAlign = text.alignment === 'left' ? 'left' : text.alignment === 'center' ? 'center' : 'right'
  const x = text.alignment === 'left' ? 0 : text.alignment === 'center' ? canvas.width / 2 : canvas.width

  let y = 0
  for (const line of lines) {
    ctx.fillText(line, x, y)
    y += lineHeight
  }
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
