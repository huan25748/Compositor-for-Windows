/**
 * 默认值工厂：构造恒等的调整参数、默认变换，以及新文档。
 * 与官方「每条调整记录都带齐所有种类设置，未使用的保持恒等」的写法一致。
 */
import { newID } from './id.ts'
import {
  CURRENT_VERSION,
  FORMAT_ID,
  type Adjustment,
  type AdjustmentKind,
  type CurvesSettings,
  type LayerRecord,
  type LevelsSettings,
  type Manifest,
  type Transform,
} from './types.ts'

/** 恒等色阶：黑 0、gamma 1、白 255、输出 0–255。 */
export function identityLevels(): LevelsSettings {
  const one = { black: 0, gamma: 1, white: 255, outputBlack: 0, outputWhite: 255 }
  return {
    channel: 'RGB',
    ranges: [{ ...one }, { ...one }, { ...one }, { ...one }],
  }
}

/** 恒等曲线：0→0、255→255。 */
export function identityCurves(): CurvesSettings {
  const line = () => [
    { x: 0, y: 0 },
    { x: 255, y: 255 },
  ]
  return { channel: 'RGB', channels: [line(), line(), line(), line()] }
}

/** 新建一个调整记录；只有 `kind` 指定的种类带了非恒等设置。 */
export function createAdjustment(kind: AdjustmentKind): Adjustment {
  return {
    kind,
    hue: 0,
    saturation: 0,
    lightness: 0,
    colorize: false,
    levels: identityLevels(),
    curves: identityCurves(),
    exposureSettings: { exposure: 0, offset: 0, gamma: 1 },
    gradientMapSettings: { shadows: [0, 0, 0], highlights: [1, 1, 1], reversed: false },
    grainSettings: { amount: 0, size: 1, roughness: 0.5, monochromatic: true, seed: 0 },
    blackWhiteSettings: { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 },
    colorBalanceSettings: {
      shadowCyanRed: 0,
      shadowMagentaGreen: 0,
      shadowYellowBlue: 0,
      midCyanRed: 0,
      midMagentaGreen: 0,
      midYellowBlue: 0,
      highlightCyanRed: 0,
      highlightMagentaGreen: 0,
      highlightYellowBlue: 0,
      preserveLuminosity: true,
    },
  }
}

/** 默认变换：铺满给定矩形，未旋转、未翻转、高质量采样。 */
export function defaultTransform(x: number, y: number, w: number, h: number): Transform {
  return {
    origin: [x, y],
    size: [w, h],
    rotation: 0,
    flipX: false,
    flipY: false,
    sampling: 'High quality',
  }
}

/** 新建普通像素图层。 */
export function createPixelLayer(name: string, x: number, y: number, w: number, h: number): LayerRecord {
  return {
    id: newID(),
    name,
    isVisible: true,
    isGroup: false,
    opacity: 1,
    blendMode: 'Normal',
    transform: defaultTransform(x, y, w, h),
  }
}

/** 新建组（文件夹）。 */
export function createGroup(name: string, x: number, y: number, w: number, h: number): LayerRecord {
  return {
    id: newID(),
    name,
    isVisible: true,
    isGroup: true,
    opacity: 1,
    // 组是穿透的，混合模式恒为 Normal。
    blendMode: 'Normal',
    transform: defaultTransform(x, y, w, h),
  }
}

/** 新建调整图层。 */
export function createAdjustmentLayer(name: string, kind: AdjustmentKind, w: number, h: number): LayerRecord {
  return {
    id: newID(),
    name,
    isVisible: true,
    isGroup: false,
    opacity: 1,
    blendMode: 'Normal',
    transform: defaultTransform(0, 0, w, h),
    adjustment: createAdjustment(kind),
  }
}

/** 新建文字图层（普通像素图层 + 官方 text 元数据）。 */
export function createTextLayer(
  content: string,
  style: {
    fontName: string
    fontSize: number
    red: number
    green: number
    blue: number
    alignment: 'left' | 'center' | 'right'
    tracking: number
    lineSpacing: number
  },
  x: number,
  y: number,
  width: number,
  height: number,
): LayerRecord {
  const layer = createPixelLayer(content.split('\n')[0]?.slice(0, 24) || '文字', x, y, width, height)
  layer.text = {
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
  return layer
}

/** 新建空文档。 */
export function createDocument(width: number, height: number, resolution = 72): Manifest {
  return {
    format: FORMAT_ID,
    version: CURRENT_VERSION,
    colorSpace: 'sRGB',
    documentID: newID(),
    width,
    height,
    resolution,
    layers: [],
  }
}
