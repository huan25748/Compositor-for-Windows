/**
 * .comp 项目的磁盘读写（仅主进程使用）。
 *
 * 写盘策略完全遵循官方 writing-comp-files.md：
 *   1. 先把新的 / 变更的 PNG 写进 images/
 *   2. 再把 manifest 写到包内的临时文件，然后 rename 覆盖 —— 重命名是原子的，
 *      Mac 版看到的要么是旧 manifest，要么是新 manifest，绝不会是半个
 *   3. 删除 manifest 已不再引用的图片
 *   4. 删除 QuickLook 预览目录，避免 Finder 显示过期画面
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { CompFormatError, parseManifest, serializeManifest } from '../shared/manifest.ts'
import { LIMITS, type Manifest } from '../shared/types.ts'

/** 一个已加载的项目：manifest + 各图片字节。 */
export interface LoadedComp {
  manifest: Manifest
  /** key 为 images/ 下的文件名（不含目录）。 */
  assets: Map<string, Uint8Array>
}

/** 简单路径守卫：资源名必须是纯文件名。 */
function assertPlainName(name: string): void {
  if (name !== basename(name) || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new CompFormatError(`资源文件名不合法：${name}`)
  }
}

/** 读取一个 .comp 目录。 */
export async function readComp(dir: string): Promise<LoadedComp> {
  const root = resolve(dir)
  const info = await stat(root).catch(() => null)
  if (!info) throw new CompFormatError(`项目不存在：${dir}`)
  if (!info.isDirectory()) throw new CompFormatError(`.comp 应当是一个文件夹：${dir}`)

  const manifestPath = join(root, 'manifest.json')
  let text: string
  try {
    text = await readFile(manifestPath, 'utf8')
  } catch {
    throw new CompFormatError(`缺少 manifest.json：${manifestPath}`)
  }
  const manifest = parseManifest(text)

  const assets = new Map<string, Uint8Array>()
  const imagesDir = join(root, 'images')
  const names = await readdir(imagesDir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.png')) continue
    assertPlainName(name)
    const bytes = await readFile(join(imagesDir, name))
    if (bytes.byteLength > LIMITS.maxAssetBytes) {
      throw new CompFormatError(`素材 ${name} 超过 ${LIMITS.maxAssetBytes / 1024 / 1024} MiB 上限`)
    }
    assets.set(name, new Uint8Array(bytes))
  }

  // manifest 指名的每个资源都必须存在（官方行为：缺一个就整份拒绝）。
  for (const layer of manifest.layers) {
    for (const f of [layer.imageFile, layer.maskFile]) {
      if (f && !assets.has(f)) throw new CompFormatError(`图层「${layer.name}」缺少图片资源 ${f}`)
    }
  }
  return { manifest, assets }
}

export interface WriteCompResult {
  /** 实际写入的图片文件名。 */
  written: string[]
}

/**
 * 写入一个 .comp 目录。
 * `assets` 中出现的文件会写入；manifest 未引用的既有图片会被清理。
 */
export async function writeComp(
  dir: string,
  manifest: Manifest,
  assets: Map<string, Uint8Array>,
): Promise<WriteCompResult> {
  const root = resolve(dir)
  const imagesDir = join(root, 'images')
  await mkdir(imagesDir, { recursive: true })

  const referenced = new Set<string>()
  for (const layer of manifest.layers) {
    if (layer.imageFile) referenced.add(layer.imageFile)
    if (layer.maskFile) referenced.add(layer.maskFile)
  }

  // 1) 先写图片
  const written: string[] = []
  for (const [name, bytes] of assets) {
    assertPlainName(name)
    if (!referenced.has(name)) continue
    if (bytes.byteLength > LIMITS.maxAssetBytes) {
      throw new CompFormatError(`素材 ${name} 超过上限，无法写入`)
    }
    await writeFile(join(imagesDir, name), bytes)
    written.push(name)
  }
  for (const f of referenced) {
    if (!assets.has(f)) throw new CompFormatError(`图层资源 ${f} 尚未生成，已中止保存`)
  }

  // 2) manifest 原子替换
  const text = serializeManifest(manifest)
  const tmp = join(root, '.manifest.json.tmp')
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, join(root, 'manifest.json'))

  // 3) 清理不再引用的图片
  const existing = await readdir(imagesDir).catch(() => [] as string[])
  for (const name of existing) {
    if (name.toLowerCase().endsWith('.png') && !referenced.has(name)) {
      await rm(join(imagesDir, name), { force: true })
    }
  }

  // 4) 清理过期预览
  await rm(join(root, 'QuickLook'), { recursive: true, force: true })

  return { written }
}
