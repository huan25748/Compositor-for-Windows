/**
 * .comp 项目数据模型 —— 严格对齐官方 project-format.md（版本 1–11）。
 *
 * 一个 .comp 是「文件夹」：
 *   Example.comp/
 *   ├── manifest.json
 *   └── images/
 *       ├── <UUID>.png
 *       └── <UUID>.mask.png
 *
 * layers 数组自下而上排列（最后一个绘制在最上层）。
 */

/** 官方格式标识。 */
export const FORMAT_ID = 'com.compositor.project'

/** 新保存时写出的版本号。 */
export const CURRENT_VERSION = 11

/** 可读的版本区间。 */
export const MIN_READABLE_VERSION = 1

/** 混合模式 —— 拼写必须与 Compositor 完全一致（大小写、空格、括号）。 */
export const BLEND_MODES = [
  'Normal',
  'Darken',
  'Multiply',
  'Color Burn',
  'Linear Burn',
  'Lighten',
  'Screen',
  'Color Dodge',
  'Linear Dodge (Add)',
  'Overlay',
  'Soft Light',
  'Hard Light',
  'Vivid Light',
  'Linear Light',
  'Pin Light',
  'Hard Mix',
  'Difference',
  'Exclusion',
  'Subtract',
  'Divide',
  'Hue',
  'Saturation',
  'Color',
  'Luminosity',
] as const
export type BlendMode = (typeof BLEND_MODES)[number]

/** 调整图层种类。 */
export const ADJUSTMENT_KINDS = [
  'Hue/Saturation',
  'Levels',
  'Curves',
  'Exposure',
  'Gradient Map',
  'Grain',
  'Invert',
  'Black & White',
  'Color Balance',
  'Gaussian Blur',
  'Motion Blur',
  'Add Noise',
] as const
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number]

/** 采样方式。 */
export const SAMPLING_MODES = ['High quality', 'Smooth', 'Nearest'] as const
export type SamplingMode = (typeof SAMPLING_MODES)[number]

export interface Transform {
  /** 左上角在文档像素中的位置。 */
  origin: [number, number]
  /** 宽高（像素）。 */
  size: [number, number]
  /** 顺时针旋转角度。 */
  rotation: number
  flipX: boolean
  flipY: boolean
  sampling: SamplingMode
}

/** 单个通道的色阶范围。 */
export interface LevelsRange {
  black: number
  gamma: number
  white: number
  outputBlack: number
  outputWhite: number
}

export interface LevelsSettings {
  channel: 'RGB' | 'Red' | 'Green' | 'Blue'
  /** RGB、红、绿、蓝 四组。 */
  ranges: [LevelsRange, LevelsRange, LevelsRange, LevelsRange]
}

export interface CurvePoint {
  x: number
  y: number
}

export interface CurvesSettings {
  channel: 'RGB' | 'Red' | 'Green' | 'Blue'
  /** RGB、红、绿、蓝 四条曲线。 */
  channels: [CurvePoint[], CurvePoint[], CurvePoint[], CurvePoint[]]
}

export interface ColorBalanceSettings {
  shadowCyanRed: number
  shadowMagentaGreen: number
  shadowYellowBlue: number
  midCyanRed: number
  midMagentaGreen: number
  midYellowBlue: number
  highlightCyanRed: number
  highlightMagentaGreen: number
  highlightYellowBlue: number
  preserveLuminosity: boolean
}

export interface GradientMapSettings {
  /** 暗部颜色，0–1 的 RGB 三元组。 */
  shadows: [number, number, number]
  /** 亮部颜色。 */
  highlights: [number, number, number]
  reversed: boolean
}

export interface GrainSettings {
  amount: number
  size: number
  roughness: number
  monochromatic: boolean
  seed: number
}

export interface BlackWhiteSettings {
  red: number
  yellow: number
  green: number
  cyan: number
  blue: number
  magenta: number
}

export interface ExposureSettings {
  exposure: number
  offset: number
  gamma: number
}

export interface HsvSettings {
  hue: number
  saturation: number
  lightness: number
}

export interface NoiseSettings {
  amount: number
  gaussian: boolean
  monochromatic: boolean
  seed: number
}

/**
 * 调整图层。每条记录都带齐所有种类的设置，
 * 未使用的种类保持「恒等」默认值 —— 与官方写法一致。
 */
export interface Adjustment {
  kind: AdjustmentKind
  hue: number
  saturation: number
  lightness: number
  colorize: boolean
  hsvSettings?: HsvSettings
  levels: LevelsSettings
  curves: CurvesSettings
  exposureSettings: ExposureSettings
  gradientMapSettings: GradientMapSettings
  grainSettings: GrainSettings
  blackWhiteSettings: BlackWhiteSettings
  colorBalanceSettings: ColorBalanceSettings
  blurRadius?: number
  motionAngle?: number
  motionDistance?: number
  noiseAmount?: number
  noiseGaussian?: boolean
  noiseMonochromatic?: boolean
  noiseSeed?: number
}

export interface EffectCommon {
  enabled?: boolean
  color?: [number, number, number]
  opacity?: number
}

export interface StrokeEffect extends EffectCommon {
  size: number
  inside: boolean
}

export interface ShadowEffect extends EffectCommon {
  angle: number
  distance: number
  blur: number
}

export interface SimpleEffect extends EffectCommon {
  size?: number
}

/** 图层效果：只写出该图层真正拥有的效果。 */
export interface LayerEffects {
  stroke?: StrokeEffect
  shadow?: ShadowEffect
  colorOverlay?: EffectCommon
  innerShadow?: ShadowEffect
  outerGlow?: SimpleEffect
  innerGlow?: SimpleEffect
}

/** 文字图层元数据。 */
export interface ColorRun {
  location: number
  length: number
  red: number
  green: number
  blue: number
}

export interface FontRun {
  location: number
  length: number
  fontName: string
}

export interface TextMetadata {
  content: string
  fontName: string
  fontSize: number
  red: number
  green: number
  blue: number
  alignment: 'left' | 'center' | 'right'
  tracking: number
  lineSpacing: number
  boxSize?: [number, number]
  colorRuns?: ColorRun[]
  fontRuns?: FontRun[]
}

/** 形状图层元数据。 */
export interface ShapeMetadata {
  kind: 'rectangle' | 'roundedRectangle' | 'ellipse' | 'line'
  red: number
  green: number
  blue: number
  cornerRadius: number
  lineWidth?: number
  start?: [number, number]
  end?: [number, number]
}

export interface LayerRecord {
  id: string
  name: string
  isVisible: boolean
  isGroup: boolean
  opacity: number
  blendMode: BlendMode
  transform: Transform
  parentID?: string
  imageFile?: string
  maskFile?: string
  maskEnabled?: boolean
  /** 剪贴蒙版：提供实时 alpha 的图层 UUID。 */
  maskSourceID?: string
  /** 解除链接的蒙版自带变换。 */
  maskPlacement?: Transform
  maskLinked?: boolean
  adjustment?: Adjustment
  effects?: LayerEffects
  text?: TextMetadata
  shape?: ShapeMetadata
  /** 未识别的字段（官方后续版本新增），原样保留，另存时不丢数据。 */
  extra?: Record<string, unknown>
}

export interface Guide {
  id: string
  axis: 'horizontal' | 'vertical'
  position: number
}

export interface Manifest {
  format: typeof FORMAT_ID
  version: number
  colorSpace: string
  documentID: string
  width: number
  height: number
  resolution: number
  activeLayerID?: string
  layers: LayerRecord[]
  guides?: Guide[]
}

/** 官方文档给出的硬性上限。 */
export const LIMITS = {
  /** 画布/图像单边像素上限。 */
  maxPixelsPerSide: 30_000,
  /** 图源总像素上限。 */
  maxTotalPixels: 100_000_000,
  /** 图层数量上限。 */
  maxLayers: 10_000,
  /** manifest 体积上限 4 MiB。 */
  maxManifestBytes: 4 * 1024 * 1024,
  /** 单个编码素材上限 512 MiB。 */
  maxAssetBytes: 512 * 1024 * 1024,
  /** 组嵌套深度上限。 */
  maxGroupDepth: 64,
  /** 剪贴蒙版链长度上限。 */
  maxClipChain: 256,
  /** 参考线数量上限。 */
  maxGuides: 1_000,
  /** 分辨率范围。 */
  minResolution: 1,
  maxResolution: 9600,
} as const
