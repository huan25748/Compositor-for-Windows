/** UUID 生成与校验工具（官方 manifest 中 ID 一律大写）。 */

/** 生成一个大写 UUID v4，用作图层 / 文档 ID。 */
export function newID(): string {
  const c = globalThis.crypto
  if (!c?.randomUUID) throw new Error('当前环境缺少 crypto.randomUUID')
  return c.randomUUID().toUpperCase()
}

const UUID_RE = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/

/** 校验是否为大写 UUID。 */
export function isID(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

/** 把任意大小写的 UUID 规范成大写。 */
export function normalizeID(value: string): string {
  return value.toUpperCase()
}
