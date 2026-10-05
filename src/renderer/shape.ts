/**
 * 形状图层的渲染。
 *
 * 官方把形状保存为普通像素图层 + `shape` 元数据（PNG 仍是显示与导出的回退），
 * 因此改变大小或颜色时可以据此重画，而不是拉伸位图。
 */
import type { ShapeMetadata } from '../shared/types.ts'

export type ShapeKind = ShapeMetadata['kind']

export const SHAPE_KINDS: { value: ShapeKind; label: string }[] = [
  { value: 'rectangle', label: '矩形' },
  { value: 'roundedRectangle', label: '圆角矩形' },
  { value: 'ellipse', label: '椭圆' },
  { value: 'line', label: '直线' },
]

function roundRectPath(
  ctx: OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.lineTo(x + w - radius, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius)
  ctx.lineTo(x + w, y + h - radius)
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
  ctx.lineTo(x + radius, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius)
  ctx.lineTo(x, y + radius)
  ctx.quadraticCurveTo(x, y, x + radius, y)
  ctx.closePath()
}

/** 把形状画到给定画布（先清空）。画布尺寸即形状的外接矩形。 */
export function renderShape(canvas: OffscreenCanvas, shape: ShapeMetadata): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)

  const color = `rgb(${Math.round(shape.red * 255)}, ${Math.round(shape.green * 255)}, ${Math.round(
    shape.blue * 255,
  )})`
  ctx.fillStyle = color
  ctx.strokeStyle = color

  switch (shape.kind) {
    case 'rectangle':
      ctx.fillRect(0, 0, w, h)
      break
    case 'roundedRectangle':
      roundRectPath(ctx, 0, 0, w, h, shape.cornerRadius)
      ctx.fill()
      break
    case 'ellipse':
      ctx.beginPath()
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
      ctx.fill()
      break
    case 'line': {
      // start / end 是相对图层框的 0–1 比例
      const sx = (shape.start?.[0] ?? 0) * w
      const sy = (shape.start?.[1] ?? 0.5) * h
      const ex = (shape.end?.[0] ?? 1) * w
      const ey = (shape.end?.[1] ?? 0.5) * h
      ctx.lineWidth = Math.max(1, shape.lineWidth ?? 2)
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(ex, ey)
      ctx.stroke()
      break
    }
  }
}
