/**
 * manifest.json 的解析、严格校验与序列化。
 *
 * 目标是「双向互通」：既要能读懂 Mac 版写出的任何 v1–v11 文件，
 * 也要写出 Mac 版能原样打开的文件。因此：
 *  - 校验规则按官方 project-format.md 逐条实现；
 *  - 未识别的字段会被保留（前向兼容），另存时不丢数据。
 */
import { isID } from './id.ts'
import {
  ADJUSTMENT_KINDS,
  BLEND_MODES,
  CURRENT_VERSION,
  FORMAT_ID,
  LIMITS,
  MIN_READABLE_VERSION,
  SAMPLING_MODES,
  type Adjustment,
  type LayerRecord,
  type Manifest,
  type Transform,
} from './types.ts'

/** 校验失败时抛出，携带可直接展示给用户的中文原因。 */
export class CompFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CompFormatError'
  }
}

type Dict = Record<string, unknown>

/** 抛错并让调用点的类型收窄为 never。 */
function fail(msg: string): never {
  throw new CompFormatError(msg)
}

const isObj = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v)

function reqString(o: Dict, key: string, where: string): string {
  const v = o[key]
  if (typeof v !== 'string') fail(`${where}：字段 ${key} 必须是字符串`)
  return v as string
}

function optBool(o: Dict, key: string, def: boolean, where: string): boolean {
  const v = o[key]
  if (v === undefined) return def
  if (typeof v !== 'boolean') fail(`${where}：字段 ${key} 必须是布尔值`)
  return v
}

function reqNum(o: Dict, key: string, where: string): number {
  const v = o[key]
  if (!isNum(v)) fail(`${where}：字段 ${key} 必须是有限数值`)
  return v as number
}

function optNum(o: Dict, key: string, def: number, where: string): number {
  const v = o[key]
  if (v === undefined) return def
  if (!isNum(v)) fail(`${where}：字段 ${key} 必须是有限数值`)
  return v as number
}

function range(v: number, lo: number, hi: number, key: string, where: string): number {
  if (v < lo || v > hi) fail(`${where}：字段 ${key} 需在 ${lo}–${hi} 之间，实际为 ${v}`)
  return v
}

function parsePair(v: unknown, key: string, where: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2 || !isNum(v[0]) || !isNum(v[1])) {
    fail(`${where}：字段 ${key} 必须是两个有限数值组成的数组`)
  }
  return [v[0] as number, v[1] as number]
}

function parseRGB(v: unknown, key: string, where: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3 || !isNum(v[0]) || !isNum(v[1]) || !isNum(v[2])) {
    fail(`${where}：字段 ${key} 必须是三个有限数值组成的数组`)
  }
  return [v[0] as number, v[1] as number, v[2] as number]
}

function parseTransform(v: unknown, where: string): Transform {
  if (!isObj(v)) fail(`${where}：transform 必须是对象`)
  const sampling = reqString(v, 'sampling', `${where} transform`)
  if (!(SAMPLING_MODES as readonly string[]).includes(sampling)) {
    fail(`${where}：采样方式 ${sampling} 不是官方取值之一（${SAMPLING_MODES.join(' / ')}）`)
  }
  const [w, h] = parsePair(v['size'], 'size', `${where} transform`)
  if (w <= 0 || h <= 0) fail(`${where}：图层尺寸必须为正数`)
  return {
    origin: parsePair(v['origin'], 'origin', `${where} transform`),
    size: [w, h],
    rotation: reqNum(v, 'rotation', `${where} transform`),
    flipX: optBool(v, 'flipX', false, `${where} transform`),
    flipY: optBool(v, 'flipY', false, `${where} transform`),
    sampling: sampling as Transform['sampling'],
  }
}

function parseLevels(v: unknown, where: string): Adjustment['levels'] {
  if (!isObj(v)) fail(`${where}：adjustment.levels 必须是对象`)
  const rawRanges = v['ranges']
  if (!Array.isArray(rawRanges) || rawRanges.length !== 4) fail(`${where}：levels.ranges 需要 4 个通道`)
  const ch = reqString(v, 'channel', `${where} levels`)
  if (!['RGB', 'Red', 'Green', 'Blue'].includes(ch)) fail(`${where}：levels.channel 取值非法`)
  const ranges = rawRanges.map((r, i) => {
    if (!isObj(r)) fail(`${where}：levels.ranges[${i}] 必须是对象`)
    return {
      black: range(reqNum(r, 'black', where), 0, 255, 'black', where),
      gamma: reqNum(r, 'gamma', where),
      white: range(reqNum(r, 'white', where), 0, 255, 'white', where),
      outputBlack: range(reqNum(r, 'outputBlack', where), 0, 255, 'outputBlack', where),
      outputWhite: range(reqNum(r, 'outputWhite', where), 0, 255, 'outputWhite', where),
    }
  }) as Adjustment['levels']['ranges']
  return { channel: ch as Adjustment['levels']['channel'], ranges }
}

function parseCurves(v: unknown, where: string): Adjustment['curves'] {
  if (!isObj(v)) fail(`${where}：adjustment.curves 必须是对象`)
  const raw = v['channels']
  if (!Array.isArray(raw) || raw.length !== 4) fail(`${where}：curves.channels 需要 4 条曲线`)
  const ch = reqString(v, 'channel', `${where} curves`)
  if (!['RGB', 'Red', 'Green', 'Blue'].includes(ch)) fail(`${where}：curves.channel 取值非法`)
  const channels = raw.map((pts, i) => {
    if (!Array.isArray(pts)) fail(`${where}：curves.channels[${i}] 必须是点数组`)
    return pts.map((p, j) => {
      if (!isObj(p)) fail(`${where}：曲线点 ${i}/${j} 非法`)
      return {
        x: range(reqNum(p, 'x', where), 0, 255, 'x', where),
        y: range(reqNum(p, 'y', where), 0, 255, 'y', where),
      }
    })
  }) as Adjustment['curves']['channels']
  return { channel: ch as Adjustment['curves']['channel'], channels }
}

function parseAdjustment(v: unknown, where: string, version: number): Adjustment {
  if (!isObj(v)) fail(`${where}：adjustment 必须是对象`)
  if (version < 7) fail(`${where}：该文件声明版本 ${version}，不允许包含调整图层`)
  const kind = reqString(v, 'kind', `${where} adjustment`)
  if (!(ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
    fail(`${where}：调整类型 ${kind} 不是官方取值之一`)
  }
  if (version < 9 && ['Gaussian Blur', 'Motion Blur', 'Add Noise'].includes(kind)) {
    fail(`${where}：该文件声明版本 ${version}，不允许包含 ${kind} 调整图层`)
  }
  const adj: Adjustment = {
    kind: kind as Adjustment['kind'],
    hue: range(optNum(v, 'hue', 0, where), -360, 360, 'hue', where),
    saturation: range(optNum(v, 'saturation', 0, where), -100, 100, 'saturation', where),
    lightness: range(optNum(v, 'lightness', 0, where), -100, 100, 'lightness', where),
    colorize: optBool(v, 'colorize', false, where),
    levels: parseLevels(v['levels'], where),
    curves: parseCurves(v['curves'], where),
    exposureSettings: isObj(v['exposureSettings'])
      ? {
          exposure: optNum(v['exposureSettings'] as Dict, 'exposure', 0, where),
          offset: optNum(v['exposureSettings'] as Dict, 'offset', 0, where),
          gamma: optNum(v['exposureSettings'] as Dict, 'gamma', 1, where),
        }
      : { exposure: 0, offset: 0, gamma: 1 },
    gradientMapSettings: isObj(v['gradientMapSettings'])
      ? {
          shadows: parseRGB((v['gradientMapSettings'] as Dict)['shadows'], 'shadows', where),
          highlights: parseRGB((v['gradientMapSettings'] as Dict)['highlights'], 'highlights', where),
          reversed: optBool(v['gradientMapSettings'] as Dict, 'reversed', false, where),
        }
      : { shadows: [0, 0, 0], highlights: [1, 1, 1], reversed: false },
    grainSettings: isObj(v['grainSettings'])
      ? {
          amount: optNum(v['grainSettings'] as Dict, 'amount', 0, where),
          size: optNum(v['grainSettings'] as Dict, 'size', 1, where),
          roughness: optNum(v['grainSettings'] as Dict, 'roughness', 0.5, where),
          monochromatic: optBool(v['grainSettings'] as Dict, 'monochromatic', true, where),
          seed: optNum(v['grainSettings'] as Dict, 'seed', 0, where),
        }
      : { amount: 0, size: 1, roughness: 0.5, monochromatic: true, seed: 0 },
    blackWhiteSettings: isObj(v['blackWhiteSettings'])
      ? {
          red: optNum(v['blackWhiteSettings'] as Dict, 'red', 40, where),
          yellow: optNum(v['blackWhiteSettings'] as Dict, 'yellow', 60, where),
          green: optNum(v['blackWhiteSettings'] as Dict, 'green', 40, where),
          cyan: optNum(v['blackWhiteSettings'] as Dict, 'cyan', 60, where),
          blue: optNum(v['blackWhiteSettings'] as Dict, 'blue', 20, where),
          magenta: optNum(v['blackWhiteSettings'] as Dict, 'magenta', 80, where),
        }
      : { red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80 },
    colorBalanceSettings: isObj(v['colorBalanceSettings'])
      ? {
          shadowCyanRed: optNum(v['colorBalanceSettings'] as Dict, 'shadowCyanRed', 0, where),
          shadowMagentaGreen: optNum(v['colorBalanceSettings'] as Dict, 'shadowMagentaGreen', 0, where),
          shadowYellowBlue: optNum(v['colorBalanceSettings'] as Dict, 'shadowYellowBlue', 0, where),
          midCyanRed: optNum(v['colorBalanceSettings'] as Dict, 'midCyanRed', 0, where),
          midMagentaGreen: optNum(v['colorBalanceSettings'] as Dict, 'midMagentaGreen', 0, where),
          midYellowBlue: optNum(v['colorBalanceSettings'] as Dict, 'midYellowBlue', 0, where),
          highlightCyanRed: optNum(v['colorBalanceSettings'] as Dict, 'highlightCyanRed', 0, where),
          highlightMagentaGreen: optNum(v['colorBalanceSettings'] as Dict, 'highlightMagentaGreen', 0, where),
          highlightYellowBlue: optNum(v['colorBalanceSettings'] as Dict, 'highlightYellowBlue', 0, where),
          preserveLuminosity: optBool(v['colorBalanceSettings'] as Dict, 'preserveLuminosity', true, where),
        }
      : {
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
  if (v['blurRadius'] !== undefined) adj.blurRadius = range(reqNum(v, 'blurRadius', where), 0.1, 250, 'blurRadius', where)
  if (v['motionAngle'] !== undefined) adj.motionAngle = range(reqNum(v, 'motionAngle', where), -90, 90, 'motionAngle', where)
  if (v['motionDistance'] !== undefined) adj.motionDistance = range(reqNum(v, 'motionDistance', where), 1, 2000, 'motionDistance', where)
  if (v['noiseAmount'] !== undefined) adj.noiseAmount = range(reqNum(v, 'noiseAmount', where), 0.1, 400, 'noiseAmount', where)
  if (v['noiseGaussian'] !== undefined) adj.noiseGaussian = optBool(v, 'noiseGaussian', true, where)
  if (v['noiseMonochromatic'] !== undefined) adj.noiseMonochromatic = optBool(v, 'noiseMonochromatic', false, where)
  if (v['noiseSeed'] !== undefined) adj.noiseSeed = optNum(v, 'noiseSeed', 0, where)
  return adj
}

/** 解析单条图层记录。`version` 用于官方定义的版本门控。 */
function parseLayer(v: unknown, index: number, version: number, ids: Set<string>): LayerRecord {
  const where = `图层 #${index}`
  if (!isObj(v)) fail(`${where}：必须是对象`)
  const id = reqString(v, 'id', where)
  if (!isID(id)) fail(`${where}：id ${id} 不是合法的 UUID`)
  if (id !== id.toUpperCase()) fail(`${where}：id 必须以大写书写（官方要求）`)
  if (ids.has(id)) fail(`${where}：id ${id} 在项目中重复`)
  ids.add(id)

  const isGroup = optBool(v, 'isGroup', false, where)
  const imageFile = v['imageFile']
  const maskFile = v['maskFile']

  if (isGroup && imageFile !== undefined) fail(`${where}：组不能携带 imageFile`)
  if (imageFile !== undefined) {
    if (typeof imageFile !== 'string') fail(`${where}：imageFile 必须是字符串`)
    if (imageFile !== `${id}.png`) fail(`${where}：imageFile 必须是 "<图层ID>.png"，期望 ${id}.png`)
  }
  if (maskFile !== undefined) {
    if (typeof maskFile !== 'string') fail(`${where}：maskFile 必须是字符串`)
    if (maskFile !== `${id}.mask.png`) fail(`${where}：maskFile 必须是 "<图层ID>.mask.png"，期望 ${id}.mask.png`)
    if (version < 4) fail(`${where}：该文件声明版本 ${version}，不允许包含图层蒙版`)
  }

  const adjustment = v['adjustment'] !== undefined ? parseAdjustment(v['adjustment'], where, version) : undefined
  if (adjustment) {
    if (isGroup) fail(`${where}：调整图层不能是组`)
    if (imageFile !== undefined) fail(`${where}：调整图层不能携带 imageFile`)
    if (v['text'] !== undefined) fail(`${where}：调整图层不能携带 text 元数据`)
  }

  if (version < 3) {
    const op = v['opacity']
    const bm = v['blendMode']
    if ((op !== undefined && op !== 1) || (bm !== undefined && bm !== 'Normal')) {
      fail(`${where}：该文件声明版本 ${version}，不允许包含不透明度或混合模式`)
    }
  }
  const blendMode = v['blendMode'] === undefined ? 'Normal' : reqString(v, 'blendMode', where)
  if (!(BLEND_MODES as readonly string[]).includes(blendMode)) {
    fail(`${where}：混合模式 ${blendMode} 不是官方拼写之一`)
  }

  const layer: LayerRecord = {
    id,
    name: reqString(v, 'name', where),
    isVisible: optBool(v, 'isVisible', true, where),
    isGroup,
    opacity: range(optNum(v, 'opacity', 1, where), 0, 1, 'opacity', where),
    blendMode: blendMode as LayerRecord['blendMode'],
    transform: parseTransform(v['transform'], where),
  }
  if (imageFile !== undefined) layer.imageFile = imageFile as string
  if (maskFile !== undefined) layer.maskFile = maskFile as string
  if (maskFile !== undefined) layer.maskEnabled = optBool(v, 'maskEnabled', true, where)
  if (v['parentID'] !== undefined) {
    if (version < 2) fail(`${where}：该文件声明版本 ${version}，不允许包含 parentID`)
    layer.parentID = reqString(v, 'parentID', where)
  }
  if (v['maskSourceID'] !== undefined) {
    if (version < 5) fail(`${where}：该文件声明版本 ${version}，不允许包含剪贴蒙版`)
    layer.maskSourceID = reqString(v, 'maskSourceID', where)
  }
  if (adjustment) layer.adjustment = adjustment
  if (v['effects'] !== undefined && isObj(v['effects'])) layer.effects = v['effects'] as LayerRecord['effects']
  if (v['text'] !== undefined && isObj(v['text'])) layer.text = v['text'] as unknown as LayerRecord['text']
  if (v['shape'] !== undefined && isObj(v['shape'])) layer.shape = v['shape'] as unknown as LayerRecord['shape']
  if (v['maskPlacement'] !== undefined) layer.maskPlacement = parseTransform(v['maskPlacement'], `${where} maskPlacement`)
  if (v['maskLinked'] !== undefined) layer.maskLinked = optBool(v, 'maskLinked', true, where)

  // 保留未识别字段，另存时原样写回，避免丢数据。
  const known = new Set([
    'id', 'name', 'isVisible', 'isGroup', 'opacity', 'blendMode', 'transform',
    'parentID', 'imageFile', 'maskFile', 'maskEnabled', 'maskSourceID',
    'adjustment', 'effects', 'text', 'shape', 'maskPlacement', 'maskLinked',
  ])
  const extra: Dict = {}
  for (const [k, val] of Object.entries(v)) if (!known.has(k)) extra[k] = val
  if (Object.keys(extra).length) layer.extra = extra

  return layer
}

/** 结构校验：组关系、深度、剪贴链。 */
function validateGraph(layers: LayerRecord[]): void {
  const byID = new Map(layers.map((l) => [l.id, l]))
  for (const l of layers) {
    if (l.parentID !== undefined) {
      const p = byID.get(l.parentID)
      if (!p) fail(`图层「${l.name}」引用了不存在的父级 ${l.parentID}`)
      if (!p.isGroup) fail(`图层「${l.name}」的父级 ${l.parentID} 不是组`)
    }
    if (l.maskSourceID !== undefined) {
      if (l.maskSourceID === l.id) fail(`图层「${l.name}」的剪贴蒙版指向了自己`)
      const src = byID.get(l.maskSourceID)
      if (!src) fail(`图层「${l.name}」的剪贴蒙版引用了不存在的图层`)
      if (src.isGroup) fail(`图层「${l.name}」的剪贴蒙版指向了组`)
    }
  }
  // 组嵌套深度 + 环
  for (const l of layers) {
    let depth = 0
    let cur: LayerRecord | undefined = l
    const seen = new Set<string>()
    while (cur?.parentID) {
      if (seen.has(cur.id)) fail(`图层「${l.name}」所在的组存在循环引用`)
      seen.add(cur.id)
      cur = byID.get(cur.parentID)
      depth += 1
      if (depth > LIMITS.maxGroupDepth) fail(`组嵌套深度超过 ${LIMITS.maxGroupDepth} 层`)
    }
  }
  // 剪贴蒙版链长度 + 环
  for (const l of layers) {
    let steps = 0
    const seen = new Set<string>()
    let cur: LayerRecord | undefined = l
    while (cur?.maskSourceID) {
      if (seen.has(cur.id)) fail(`图层「${l.name}」的剪贴蒙版链存在循环`)
      seen.add(cur.id)
      cur = byID.get(cur.maskSourceID)
      steps += 1
      if (steps > LIMITS.maxClipChain) fail(`剪贴蒙版链超过 ${LIMITS.maxClipChain} 个节点`)
    }
  }
}

function parseGuides(v: unknown, version: number): Manifest['guides'] {
  if (v === undefined) return undefined
  if (version < 8) fail(`该文件声明版本 ${version}，不允许包含参考线`)
  if (!Array.isArray(v)) fail('guides 必须是数组')
  if (v.length > LIMITS.maxGuides) fail(`参考线数量超过 ${LIMITS.maxGuides}`)
  return v.map((g, i) => {
    if (!isObj(g)) fail(`参考线 #${i} 非法`)
    const axis = reqString(g, 'axis', `参考线 #${i}`)
    if (axis !== 'horizontal' && axis !== 'vertical') fail(`参考线 #${i}：axis 取值非法`)
    return {
      id: reqString(g, 'id', `参考线 #${i}`),
      axis: axis as 'horizontal' | 'vertical',
      position: range(reqNum(g, 'position', `参考线 #${i}`), -1e6, 1e6, 'position', `参考线 #${i}`),
    }
  })
}

/** 把任意 JSON 值严格校验成 Manifest。失败抛 CompFormatError。 */
export function validateManifest(input: unknown): Manifest {
  if (!isObj(input)) fail('manifest 根节点必须是对象')
  const v = input

  const format = reqString(v, 'format', 'manifest')
  if (format !== FORMAT_ID) fail(`不是 Compositor 项目：format 为 ${format}`)

  const version = reqNum(v, 'version', 'manifest')
  if (!isInt(version)) fail('version 必须是整数')
  if (version < MIN_READABLE_VERSION) fail(`版本 ${version} 过旧，无法读取`)
  if (version > CURRENT_VERSION) fail(`版本 ${version} 高于本程序支持的 ${CURRENT_VERSION}`)

  const documentID = reqString(v, 'documentID', 'manifest')
  if (!isID(documentID)) fail(`documentID ${documentID} 不是合法 UUID`)

  const width = range(reqNum(v, 'width', 'manifest'), 1, LIMITS.maxPixelsPerSide, 'width', 'manifest')
  const height = range(reqNum(v, 'height', 'manifest'), 1, LIMITS.maxPixelsPerSide, 'height', 'manifest')
  if (width * height > LIMITS.maxTotalPixels) fail(`画布像素总数超过 ${LIMITS.maxTotalPixels}`)

  const resolution = range(
    optNum(v, 'resolution', 72, 'manifest'),
    LIMITS.minResolution,
    LIMITS.maxResolution,
    'resolution',
    'manifest',
  )

  const rawLayers = v['layers']
  if (!Array.isArray(rawLayers)) fail('layers 必须是数组')
  if (rawLayers.length > LIMITS.maxLayers) fail(`图层数量超过 ${LIMITS.maxLayers}`)

  const ids = new Set<string>()
  const layers = rawLayers.map((l, i) => parseLayer(l, i, version, ids))
  validateGraph(layers)

  const manifest: Manifest = {
    format: FORMAT_ID,
    version,
    colorSpace: reqString(v, 'colorSpace', 'manifest'),
    documentID,
    width,
    height,
    resolution,
    layers,
  }
  const active = v['activeLayerID']
  if (active !== undefined) {
    if (typeof active !== 'string') fail('activeLayerID 必须是字符串')
    if (!ids.has(active)) fail(`activeLayerID ${active} 不指向任何图层`)
    manifest.activeLayerID = active
  }
  const guides = parseGuides(v['guides'], version)
  if (guides) manifest.guides = guides
  return manifest
}

/** 从 JSON 文本解析。 */
export function parseManifest(text: string): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    fail(`manifest.json 不是合法 JSON：${(err as Error).message}`)
  }
  return validateManifest(parsed)
}

// —— 序列化 ——

const pair = (p: readonly [number, number]): number[] => [round(p[0]), round(p[1])]
const rgb3 = (p: readonly [number, number, number]): number[] => [round(p[0]), round(p[1]), round(p[2])]
/** 保留 6 位小数，去掉浮点噪声，同时避免写出 1e-7 这类形式。 */
const round = (n: number): number => Math.round(n * 1e6) / 1e6

function serializeTransform(t: Transform): Dict {
  return {
    origin: pair(t.origin),
    size: pair(t.size),
    rotation: round(t.rotation),
    flipX: t.flipX,
    flipY: t.flipY,
    sampling: t.sampling,
  }
}

function serializeAdjustment(a: Adjustment): Dict {
  const out: Dict = {
    kind: a.kind,
    hue: a.hue,
    saturation: a.saturation,
    lightness: a.lightness,
    colorize: a.colorize,
    levels: {
      channel: a.levels.channel,
      ranges: a.levels.ranges.map((r) => ({
        black: round(r.black),
        gamma: round(r.gamma),
        white: round(r.white),
        outputBlack: round(r.outputBlack),
        outputWhite: round(r.outputWhite),
      })),
    },
    curves: {
      channel: a.curves.channel,
      channels: a.curves.channels.map((pts) => pts.map((p) => ({ x: round(p.x), y: round(p.y) }))),
    },
    exposureSettings: a.exposureSettings,
    gradientMapSettings: {
      shadows: rgb3(a.gradientMapSettings.shadows),
      highlights: rgb3(a.gradientMapSettings.highlights),
      reversed: a.gradientMapSettings.reversed,
    },
    grainSettings: a.grainSettings,
    blackWhiteSettings: a.blackWhiteSettings,
    colorBalanceSettings: a.colorBalanceSettings,
  }
  if (a.blurRadius !== undefined) out['blurRadius'] = round(a.blurRadius)
  if (a.motionAngle !== undefined) out['motionAngle'] = round(a.motionAngle)
  if (a.motionDistance !== undefined) out['motionDistance'] = round(a.motionDistance)
  if (a.noiseAmount !== undefined) out['noiseAmount'] = round(a.noiseAmount)
  if (a.noiseGaussian !== undefined) out['noiseGaussian'] = a.noiseGaussian
  if (a.noiseMonochromatic !== undefined) out['noiseMonochromatic'] = a.noiseMonochromatic
  if (a.noiseSeed !== undefined) out['noiseSeed'] = a.noiseSeed
  return out
}

function serializeLayer(l: LayerRecord): Dict {
  const out: Dict = { id: l.id, name: l.name }
  if (l.imageFile !== undefined) out['imageFile'] = l.imageFile
  if (l.maskFile !== undefined) {
    out['maskFile'] = l.maskFile
    out['maskEnabled'] = l.maskEnabled ?? true
  }
  out['isVisible'] = l.isVisible
  out['isGroup'] = l.isGroup
  out['opacity'] = round(l.opacity)
  out['blendMode'] = l.blendMode
  out['transform'] = serializeTransform(l.transform)
  if (l.parentID !== undefined) out['parentID'] = l.parentID
  if (l.maskSourceID !== undefined) out['maskSourceID'] = l.maskSourceID
  if (l.adjustment) out['adjustment'] = serializeAdjustment(l.adjustment)
  if (l.effects) out['effects'] = l.effects
  if (l.text) out['text'] = l.text
  if (l.shape) out['shape'] = l.shape
  if (l.maskPlacement) out['maskPlacement'] = serializeTransform(l.maskPlacement)
  if (l.maskLinked !== undefined) out['maskLinked'] = l.maskLinked
  if (l.extra) Object.assign(out, l.extra)
  return out
}

/** 序列化为官方风格的 JSON 文本（2 空格缩进，字段顺序与官方一致）。 */
export function serializeManifest(m: Manifest): string {
  const out: Dict = {
    format: FORMAT_ID,
    version: CURRENT_VERSION,
    colorSpace: m.colorSpace,
    documentID: m.documentID,
    width: m.width,
    height: m.height,
    resolution: m.resolution,
  }
  if (m.activeLayerID !== undefined) out['activeLayerID'] = m.activeLayerID
  out['layers'] = m.layers.map(serializeLayer)
  if (m.guides && m.guides.length) out['guides'] = m.guides
  const text = JSON.stringify(out, null, 2)
  // 用 TextEncoder 而不是 Buffer：本模块在渲染进程也会被复用。
  if (new TextEncoder().encode(text).byteLength > LIMITS.maxManifestBytes) {
    fail(`manifest 超过 ${LIMITS.maxManifestBytes / 1024 / 1024} MiB 上限`)
  }
  return text
}
