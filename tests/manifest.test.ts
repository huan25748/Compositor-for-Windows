/**
 * .comp 格式的解析 / 校验 / 序列化测试。
 * 最关键的一条：round-trip 后仍与官方约定完全一致（双向互通的基础）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CompFormatError,
  parseManifest,
  serializeManifest,
  validateManifest,
} from '../src/shared/manifest.ts'
import { BLEND_MODES, type Manifest } from '../src/shared/types.ts'
import { createAdjustmentLayer, createDocument } from '../src/shared/factory.ts'

/** 官方文档里给出的最小示例。 */
const OFFICIAL_SAMPLE = {
  format: 'com.compositor.project',
  version: 11,
  colorSpace: 'sRGB',
  documentID: '0C5E7A91-3B2D-4F6A-8E1C-9D0B7A6F5E4D',
  width: 1920,
  height: 1080,
  resolution: 72,
  activeLayerID: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F',
  layers: [
    {
      id: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F',
      name: 'Background',
      imageFile: '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F.png',
      isVisible: true,
      isGroup: false,
      opacity: 1,
      blendMode: 'Normal',
      transform: {
        origin: [0, 0],
        size: [1920, 1080],
        rotation: 0,
        flipX: false,
        flipY: false,
        sampling: 'High quality',
      },
    },
  ],
}

test('官方示例 manifest 能被解析', () => {
  const m = parseManifest(JSON.stringify(OFFICIAL_SAMPLE))
  assert.equal(m.width, 1920)
  assert.equal(m.layers.length, 1)
  assert.equal(m.layers[0]!.name, 'Background')
  assert.equal(m.activeLayerID, '6F1D3C2A-0B7E-4E8A-9C4D-2A1B3C4D5E6F')
})

test('round-trip 后语义完全一致', () => {
  const first = parseManifest(JSON.stringify(OFFICIAL_SAMPLE))
  const text = serializeManifest(first)
  const second = parseManifest(text)
  assert.deepEqual(second, first)
  // 再走一轮，确认稳定（不会每存一次就漂移）
  assert.equal(serializeManifest(second), text)
})

test('新文档序列化出的版本是 11、format 正确', () => {
  const doc = createDocument(800, 600)
  const parsed = parseManifest(serializeManifest(doc))
  assert.equal(parsed.version, 11)
  assert.equal(parsed.format, 'com.compositor.project')
  assert.equal(parsed.colorSpace, 'sRGB')
  assert.equal(parsed.resolution, 72)
})

test('24 种官方混合模式拼写全部被接受', () => {
  assert.equal(BLEND_MODES.length, 24)
  for (const mode of BLEND_MODES) {
    const m = structuredClone(OFFICIAL_SAMPLE) as typeof OFFICIAL_SAMPLE
    ;(m.layers[0] as { blendMode: string }).blendMode = mode
    assert.doesNotThrow(() => validateManifest(m), `模式 ${mode} 应当被接受`)
  }
})

test('拼错的混合模式被拒绝（互通的关键）', () => {
  const bad = structuredClone(OFFICIAL_SAMPLE) as typeof OFFICIAL_SAMPLE
  ;(bad.layers[0] as { blendMode: string }).blendMode = 'Linear Dodge (Add) ' // 尾部空格
  assert.throws(() => validateManifest(bad), CompFormatError)
  ;(bad.layers[0] as { blendMode: string }).blendMode = 'linear dodge'
  assert.throws(() => validateManifest(bad), CompFormatError)
})

test('imageFile 必须严格等于 "<图层ID>.png"', () => {
  const bad = structuredClone(OFFICIAL_SAMPLE) as typeof OFFICIAL_SAMPLE
  ;(bad.layers[0] as { imageFile: string }).imageFile = 'background.png'
  assert.throws(() => validateManifest(bad), /imageFile/)
})

test('将来的版本被拒绝而不是误读', () => {
  const future = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  future['version'] = 12
  assert.throws(() => validateManifest(future), /高于本程序支持/)
})

test('版本门控：v3 之前的文件不允许有非默认不透明度', () => {
  const old = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  old['version'] = 2
  ;(old['layers'] as { opacity: number }[])[0]!.opacity = 0.5
  assert.throws(() => validateManifest(old), /不允许包含不透明度/)
  // 保持默认值则合法
  ;(old['layers'] as { opacity: number }[])[0]!.opacity = 1
  assert.doesNotThrow(() => validateManifest(old))
})

test('组关系：父级必须存在且确为组，循环被拒绝', () => {
  const g = '11111111-2222-4333-8444-555555555555'
  const l = '22222222-3333-4444-8555-666666666666'
  const base = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  base['layers'] = [
    { id: g, name: '组', isVisible: true, isGroup: true, opacity: 1, blendMode: 'Normal', transform: { origin: [0, 0], size: [10, 10], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' } },
    { id: l, name: '子层', isVisible: true, isGroup: false, opacity: 1, blendMode: 'Normal', parentID: g, transform: { origin: [0, 0], size: [10, 10], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' } },
  ]
  delete base['activeLayerID']
  assert.doesNotThrow(() => validateManifest(base))

  // 指向非组
  const bad = structuredClone(base) as { layers: { parentID?: string }[] }
  bad.layers[0]!.parentID = l
  assert.throws(() => validateManifest(bad), /不是组/)
})

test('组不能携带 imageFile；调整图层不能是组', () => {
  const g = '11111111-2222-4333-8444-555555555555'
  const bad = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  bad['layers'] = [
    { id: g, name: '组', imageFile: `${g}.png`, isVisible: true, isGroup: true, opacity: 1, blendMode: 'Normal', transform: { origin: [0, 0], size: [10, 10], rotation: 0, flipX: false, flipY: false, sampling: 'Nearest' } },
  ]
  delete bad['activeLayerID']
  assert.throws(() => validateManifest(bad), /组不能携带 imageFile/)
})

test('未识别的字段被保留（前向兼容，另存不丢数据）', () => {
  const withExtra = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  ;(withExtra['layers'] as Record<string, unknown>[])[0]!['futureField'] = { hello: 'world' }
  const m = validateManifest(withExtra)
  assert.deepEqual(m.layers[0]!.extra, { futureField: { hello: 'world' } })
  const round = parseManifest(serializeManifest(m))
  assert.deepEqual(round.layers[0]!.extra, { futureField: { hello: 'world' } })
})

test('尺寸与图层数上限被强制执行', () => {
  const big = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  big['width'] = 30_001
  assert.throws(() => validateManifest(big), /width/)

  const huge = structuredClone(OFFICIAL_SAMPLE) as Record<string, unknown>
  huge['width'] = 30_000
  huge['height'] = 30_000 // 9 亿像素 > 1 亿
  assert.throws(() => validateManifest(huge), /像素总数/)
})

test('调整图层：12 种类型可被写出并读回', () => {
  const doc: Manifest = createDocument(100, 100)
  const kinds = ['Hue/Saturation', 'Levels', 'Curves', 'Exposure', 'Gradient Map', 'Grain',
    'Invert', 'Black & White', 'Color Balance'] as const
  for (const k of kinds) doc.layers.push(createAdjustmentLayer(k, k, 100, 100))
  const round = parseManifest(serializeManifest(doc))
  assert.equal(round.layers.length, kinds.length)
  assert.deepEqual(round.layers.map((l) => l.adjustment?.kind), [...kinds])
  assert.equal(round.layers[0]!.adjustment?.levels.ranges.length, 4)
  assert.equal(round.layers[0]!.adjustment?.curves.channels.length, 4)
})

test('非法 JSON 报中文错误', () => {
  assert.throws(() => parseManifest('{ nope'), CompFormatError)
})
