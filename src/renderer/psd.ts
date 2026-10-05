/**
 * PSD 读写：**分层 RGB 子集**。
 *
 * 格式细节交给 `ag-psd`，这里只负责它与本项目的图层模型之间的映射。
 * 支持范围刻意保守，避免给出「完整 PSD 支持」的错误预期：
 *   - 读：RGB/8bit、逐图层的像素、位置、名称、不透明度、可见性、常见混合模式
 *   - 写：把当前文档的光栅图层逐层写出（保留上面这些属性）
 *   - 不支持：图层蒙版、图层效果、文字/形状的可再编辑性（写出时一律是光栅）、
 *     额外通道、CMYK/16bit
 */
import { readPsd, writePsd, type BlendMode as PsdBlendMode, type Layer } from 'ag-psd'
import type { BlendMode, LayerRecord, Manifest } from '../shared/types.ts'

/** 本项目混合模式 → PSD 名称（PSD 用 'normal'、'multiply' 这类小写字符串）。 */
const TO_PSD: Record<BlendMode, string> = {
  Normal: 'normal',
  Darken: 'darken',
  Multiply: 'multiply',
  'Color Burn': 'color burn',
  'Linear Burn': 'linear burn',
  Lighten: 'lighten',
  Screen: 'screen',
  'Color Dodge': 'color dodge',
  'Linear Dodge (Add)': 'linear dodge',
  Overlay: 'overlay',
  'Soft Light': 'soft light',
  'Hard Light': 'hard light',
  'Vivid Light': 'vivid light',
  'Linear Light': 'linear light',
  'Pin Light': 'pin light',
  'Hard Mix': 'hard mix',
  Difference: 'difference',
  Exclusion: 'exclusion',
  Subtract: 'subtract',
  Divide: 'divide',
  Hue: 'hue',
  Saturation: 'saturation',
  Color: 'color',
  Luminosity: 'luminosity',
}

/** PSD 名称 → 本项目混合模式。只认识交集部分，其余一律当 Normal。 */
const FROM_PSD: Record<string, BlendMode> = Object.fromEntries(
  Object.entries(TO_PSD).map(([ours, psd]) => [psd, ours as BlendMode]),
)

function toPsdBlend(mode: BlendMode): PsdBlendMode {
  return (TO_PSD[mode] ?? 'normal') as PsdBlendMode
}

function fromPsdBlend(mode: string | undefined): BlendMode {
  return FROM_PSD[(mode ?? 'normal').toLowerCase()] ?? 'Normal'
}

/** 一个待写出的图层（已栅格化到文档坐标系的一个矩形）。 */
interface PsdLayerOut {
  name: string
  canvas: HTMLCanvasElement
  left: number
  top: number
  opacity: number
  hidden: boolean
  blendMode: PsdBlendMode
}

/**
 * 把文档导出为分层 PSD。
 *
 * 组与调整图层无法用 PSD 的简单层表达，因此**只写像素图层**，并按图层顺序平铺；
 * 每个图层只写它自己的矩形（PSD 支持逐层偏移），不做整幅画布拷贝。
 */
export function exportPsd(
  manifest: Manifest,
  getPixels: (id: string) => { canvas: OffscreenCanvas; version: number } | undefined,
): Uint8Array {
  const children: PsdLayerOut[] = []
  for (const layer of manifest.layers) {
    if (layer.isGroup || layer.adjustment) continue
    const px = getPixels(layer.id)
    if (!px) continue
    const w = Math.max(1, Math.round(layer.transform.size[0]))
    const h = Math.max(1, Math.round(layer.transform.size[1]))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) continue
    ctx.drawImage(px.canvas as unknown as CanvasImageSource, 0, 0, w, h)
    children.push({
      name: layer.name,
      canvas,
      left: Math.round(layer.transform.origin[0]),
      top: Math.round(layer.transform.origin[1]),
      // PSD 的 opacity 是 0–1
      opacity: layer.opacity,
      hidden: !layer.isVisible,
      blendMode: toPsdBlend(layer.blendMode),
    })
  }

  const psd = {
    width: manifest.width,
    height: manifest.height,
    children: children as unknown as Layer[],
  }
  return new Uint8Array(writePsd(psd as never, { generateThumbnail: false }))
}

/** 从 PSD 读出的一个图层。 */
export interface PsdLayerIn {
  name: string
  image: ImageData
  x: number
  y: number
  opacity: number
  visible: boolean
  blendMode: BlendMode
}

export interface PsdImport {
  width: number
  height: number
  layers: PsdLayerIn[]
}

function toImageData(source: HTMLCanvasElement | OffscreenCanvas | ImageData): ImageData | null {
  if (source instanceof ImageData) return source
  const w = source.width
  const h = source.height
  if (!w || !h) return null
  if (typeof OffscreenCanvas !== 'undefined' && source instanceof OffscreenCanvas) {
    return source.getContext('2d')?.getImageData(0, 0, w, h) ?? null
  }
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  const ctx = cv.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source as CanvasImageSource, 0, 0)
  return ctx.getImageData(0, 0, w, h)
}

/** 读入 PSD（只取可用的像素图层；没有像素的组/调整层跳过）。 */
export function importPsd(bytes: ArrayBuffer): PsdImport {
  const psd = readPsd(bytes, {
    skipCompositeImageData: true,
    skipThumbnail: true,
  })
  const width = psd.width
  const height = psd.height
  const layers: PsdLayerIn[] = []

  const walk = (list: Layer[] | undefined): void => {
    for (const item of list ?? []) {
      if (item.children && item.children.length > 0) {
        // 组：递归进入（PSD 的组没有自己的像素，或只有合成结果）
        walk(item.children)
        continue
      }
      const src = item.canvas ?? item.imageData
      if (!src) continue
      const image = toImageData(src as HTMLCanvasElement | OffscreenCanvas | ImageData)
      if (!image) continue
      layers.push({
        name: item.name?.trim() || '图层',
        image,
        x: Math.round(item.left ?? 0),
        y: Math.round(item.top ?? 0),
        opacity: typeof item.opacity === 'number' ? item.opacity : 1,
        visible: item.hidden !== true,
        blendMode: fromPsdBlend(item.blendMode as string | undefined),
      })
    }
  }
  walk(psd.children)

  return { width, height, layers }
}

/** 供 UI 判断某个图层能否写进 PSD。 */
export function isPsdExportable(layer: LayerRecord): boolean {
  return !layer.isGroup && !layer.adjustment
}
