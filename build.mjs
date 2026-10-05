// 构建脚本：用 esbuild 把主进程 / 预加载 / 渲染进程分别打包。
// - 主进程与预加载 -> CommonJS(.cjs)，外部化 electron
// - 渲染进程 -> 浏览器 IIFE，并把 index.html 复制到 dist/renderer
import { build, context } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const watch = process.argv.includes('--watch')
const dev = watch || process.argv.includes('--dev')

/** 主进程 + 预加载：Node/CommonJS 目标 */
const nodeTargets = [
  { in: 'src/main/main.ts', out: 'dist/main/main.cjs' },
  { in: 'src/main/preload.ts', out: 'dist/main/preload.cjs' },
]

/** 渲染进程：浏览器 IIFE */
const renderTarget = { in: 'src/renderer/main.ts', out: 'dist/renderer/app.js' }

function common(entry, outfile, opts) {
  return {
    entryPoints: [resolve(root, entry)],
    outfile: resolve(root, outfile),
    bundle: true,
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    logLevel: 'info',
    ...opts,
  }
}

async function run() {
  await rm(resolve(root, 'dist'), { recursive: true, force: true })
  await mkdir(resolve(root, 'dist/renderer'), { recursive: true })

  const configs = [
    ...nodeTargets.map((t) =>
      common(t.in, t.out, { platform: 'node', format: 'cjs', target: 'node20', external: ['electron'] }),
    ),
    common(renderTarget.in, renderTarget.out, { platform: 'browser', format: 'iife', target: 'chrome120' }),
  ]

  if (watch) {
    for (const cfg of configs) {
      const ctx = await context(cfg)
      await ctx.watch()
    }
    console.log('[build] 监听中…')
  } else {
    await Promise.all(configs.map((cfg) => build(cfg)))
  }

  await cp(resolve(root, 'src/renderer/index.html'), resolve(root, 'dist/renderer/index.html'))
  await cp(resolve(root, 'src/renderer/styles.css'), resolve(root, 'dist/renderer/styles.css'))
  console.log('[build] 完成')
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
