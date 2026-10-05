/**
 * 修图类工具的像素运算（都在图层画布的像素空间里做）。
 *
 * 这几项在 Mac 版由 Metal 实现；这里用 Canvas 2D + 邻域采样给出等价效果，
 * 对中等尺寸图层足够流畅，超大图会偏慢（已在 README 说明）。
 */

/** 仿制图章：把源点附近的像素盖到目标点上。 */
export function cloneAt(
  canvas: OffscreenCanvas,
  x: number,
  y: number,
  radius: number,
  offsetX: number,
  offsetY: number,
  alpha: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const size = Math.max(1, Math.round(radius * 2))
  const sx = x + offsetX - radius
  const sy = y + offsetY - radius

  ctx.save()
  ctx.globalAlpha = alpha
  ctx.beginPath()
  ctx.arc(x, y, radius, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(canvas, sx, sy, size, size, x - radius, y - radius, size, size)
  ctx.restore()
}

/**
 * 修复画笔（污点修复）：用选区四周一圈像素的平均色，按中心权重盖住中心。
 * 这是内容感知填充的简化版，对纯色和渐变背景效果不错。
 */
export function healAt(canvas: OffscreenCanvas, x: number, y: number, radius: number): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const r = Math.max(1, radius)
  const box = Math.ceil(r * 3)
  const x0 = Math.max(0, Math.floor(x - box))
  const y0 = Math.max(0, Math.floor(y - box))
  const x1 = Math.min(canvas.width, Math.ceil(x + box))
  const y1 = Math.min(canvas.height, Math.ceil(y + box))
  const w = x1 - x0
  const h = y1 - y0
  if (w <= 0 || h <= 0) return

  const img = ctx.getImageData(x0, y0, w, h)
  const data = img.data

  // 统计「环带」上的平均色（距离在 r..1.6r 之间）
  let sr = 0
  let sg = 0
  let sb = 0
  let sa = 0
  let n = 0
  const cx = x - x0
  const cy = y - y0
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const d = Math.hypot(px - cx, py - cy)
      if (d < r || d > r * 1.6) continue
      const i = (py * w + px) * 4
      sr += data[i]!
      sg += data[i + 1]!
      sb += data[i + 2]!
      sa += data[i + 3]!
      n++
    }
  }
  if (n === 0) return
  const ar = sr / n
  const ag = sg / n
  const ab = sb / n
  const aa = sa / n

  // 按到中心的距离做羽化填充
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const d = Math.hypot(px - cx, py - cy)
      if (d > r) continue
      const t = 1 - d / r // 中心为 1，边缘为 0
      const i = (py * w + px) * 4
      data[i] = data[i]! + (ar - data[i]!) * t
      data[i + 1] = data[i + 1]! + (ag - data[i + 1]!) * t
      data[i + 2] = data[i + 2]! + (ab - data[i + 2]!) * t
      data[i + 3] = Math.max(data[i + 3]!, aa * t)
    }
  }
  ctx.putImageData(img, x0, y0)
}

/** 涂抹：把上一步位置的小块以较低透明度拖到当前位置，形成推挤痕迹。 */
export function smudgeAt(
  canvas: OffscreenCanvas,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  radius: number,
  strength: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const size = Math.max(1, Math.round(radius * 2))
  const tmp = new OffscreenCanvas(size, size)
  const tctx = tmp.getContext('2d')
  if (!tctx) return
  // 取起点附近的一小块作为「颜料」
  tctx.drawImage(canvas, fromX - radius, fromY - radius, size, size, 0, 0, size, size)

  ctx.save()
  ctx.globalAlpha = Math.max(0.05, Math.min(1, strength))
  ctx.beginPath()
  ctx.arc(toX, toY, radius, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(tmp, toX - radius, toY - radius)
  ctx.restore()
}

/** 液化：把圆心附近的像素整体往拖动方向推。 */
export function liquifyAt(
  canvas: OffscreenCanvas,
  x: number,
  y: number,
  dx: number,
  dy: number,
  radius: number,
  strength: number,
): void {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const size = Math.max(1, Math.round(radius * 2))
  const tmp = new OffscreenCanvas(size, size)
  const tctx = tmp.getContext('2d')
  if (!tctx) return
  tctx.drawImage(canvas, x - radius, y - radius, size, size, 0, 0, size, size)

  ctx.save()
  ctx.globalAlpha = Math.max(0.1, Math.min(1, strength))
  ctx.beginPath()
  ctx.arc(x + dx, y + dy, radius * 0.95, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(tmp, x + dx - radius, y + dy - radius)
  ctx.restore()
}
