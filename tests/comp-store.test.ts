/**
 * .comp 磁盘读写测试：写盘 → 读回 的一致性，以及官方要求的写入纪律。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readComp, writeComp } from '../src/main/comp-store.ts'
import { parseManifest } from '../src/shared/manifest.ts'
import { createAdjustmentLayer, createDocument, createPixelLayer } from '../src/shared/factory.ts'
import type { Manifest } from '../src/shared/types.ts'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'comp-test-'))
}

/** 造一张最小的合法 PNG（1×1 不透明红），用于写盘测试。 */
const TINY_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
  0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
])

function buildProject(): { manifest: Manifest; assets: Map<string, Uint8Array> } {
  const doc = createDocument(64, 48)
  const bottom = createPixelLayer('底层', 0, 0, 64, 48)
  bottom.imageFile = `${bottom.id}.png`
  const mask = createPixelLayer('带蒙版', 0, 0, 64, 48)
  mask.imageFile = `${mask.id}.png`
  mask.maskFile = `${mask.id}.mask.png`
  mask.maskEnabled = true
  const adj = createAdjustmentLayer('色阶', 'Levels', 64, 48)
  doc.layers.push(bottom, mask, adj)
  doc.activeLayerID = mask.id

  const assets = new Map<string, Uint8Array>()
  assets.set(bottom.imageFile, TINY_PNG)
  assets.set(mask.imageFile, TINY_PNG)
  assets.set(mask.maskFile, TINY_PNG)
  return { manifest: doc, assets }
}

test('写盘后读回：manifest 与资源完全一致', async () => {
  const dir = await tempDir()
  try {
    const { manifest, assets } = buildProject()
    const target = join(dir, 'demo.comp')
    await writeComp(target, manifest, assets)

    const loaded = await readComp(target)
    assert.equal(loaded.manifest.width, 64)
    assert.equal(loaded.manifest.layers.length, 3)
    assert.deepEqual(loaded.manifest.layers.map((l) => l.name), ['底层', '带蒙版', '色阶'])
    assert.equal(loaded.assets.size, 3)
    assert.deepEqual([...loaded.assets.keys()].sort(), [...assets.keys()].sort())
    // 字节级一致
    for (const [name, bytes] of assets) {
      assert.deepEqual(loaded.assets.get(name), bytes, `${name} 内容应一致`)
    }
    // 不应残留临时文件
    assert.equal(existsSync(join(target, '.manifest.json.tmp')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('另存后未引用的旧图片被清理', async () => {
  const dir = await tempDir()
  try {
    const target = join(dir, 'trim.comp')
    const { manifest, assets } = buildProject()
    await writeComp(target, manifest, assets)

    const removed = manifest.layers.find((l) => l.maskFile)!
    manifest.layers = manifest.layers.filter((l) => l.id !== removed.id)
    manifest.activeLayerID = manifest.layers[0]!.id
    const kept = new Map<string, Uint8Array>()
    for (const l of manifest.layers) if (l.imageFile) kept.set(l.imageFile, TINY_PNG)
    await writeComp(target, manifest, kept)

    const names = await readdir(join(target, 'images'))
    assert.equal(names.includes(`${removed.id}.png`), false, '被删除图层的主图应被清理')
    assert.equal(names.includes(`${removed.id}.mask.png`), false, '被删除图层的蒙版应被清理')
    // 只剩「底层」的主图；「色阶」是调整图层，没有图片资源。
    assert.equal(names.length, 1)

    const loaded = await readComp(target)
    assert.equal(loaded.manifest.layers.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('资源缺失时整份拒绝（官方行为）', async () => {
  const dir = await tempDir()
  try {
    const target = join(dir, 'broken.comp')
    const { manifest, assets } = buildProject()
    await writeComp(target, manifest, assets)
    // 删掉一个图片
    const victim = manifest.layers[0]!.imageFile!
    await rm(join(target, 'images', victim))

    await assert.rejects(() => readComp(target), /缺少图片资源/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('缺少 manifest.json 报中文错误', async () => {
  const dir = await tempDir()
  try {
    await mkdir(join(dir, 'empty.comp'), { recursive: true })
    await assert.rejects(() => readComp(join(dir, 'empty.comp')), /缺少 manifest\.json/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('manifest 是数组时被拒绝（不是对象）', async () => {
  const dir = await tempDir()
  try {
    const target = join(dir, 'arr.comp')
    await mkdir(join(target, 'images'), { recursive: true })
    await writeFile(join(target, 'manifest.json'), '[1,2,3]', 'utf8')
    await assert.rejects(() => readComp(target), /根节点必须是对象/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('写出的 manifest 能被本程序的解析器重新读入（互操作闭环）', async () => {
  const dir = await tempDir()
  try {
    const target = join(dir, 'roundtrip.comp')
    const { manifest, assets } = buildProject()
    await writeComp(target, manifest, assets)
    const { readFile } = await import('node:fs/promises')
    const text = await readFile(join(target, 'manifest.json'), 'utf8')
    const reread = parseManifest(text)
    assert.equal(reread.version, 11)
    assert.equal(reread.layers.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
