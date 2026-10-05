/**
 * 混合模式的参考实现（0–1 归一化空间）。
 *
 * 这是「标准答案」版本：用于单元测试、CPU 回退路径，
 * 以及作为 WebGL 着色器公式（src/renderer/gl/shaders.ts）的依据。
 * 两者必须给出相同结果。
 *
 * 公式取自 PDF 32000-1（Adobe 混合模式）与 W3C Compositing and Blending，
 * 即 Photoshop 实际使用的定义。
 */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

// —— 分量级混合函数 ——

export const normal = (_b: number, s: number): number => s
export const darken = (b: number, s: number): number => Math.min(b, s)
export const multiply = (b: number, s: number): number => b * s
export const lighten = (b: number, s: number): number => Math.max(b, s)
export const screen = (b: number, s: number): number => b + s - b * s
export const difference = (b: number, s: number): number => Math.abs(b - s)

/** Color Burn：Cs 为 0 时结果为 0（等价于极限情形）。 */
export function colorBurn(b: number, s: number): number {
  if (s <= 0) return 0
  return 1 - Math.min(1, (1 - b) / s)
}

/** Color Dodge：Cs 为 1 时结果为 1。 */
export function colorDodge(b: number, s: number): number {
  if (s >= 1) return 1
  return Math.min(1, b / (1 - s))
}

export const linearBurn = (b: number, s: number): number => clamp01(b + s - 1)
export const linearDodge = (b: number, s: number): number => clamp01(b + s)

export function hardLight(b: number, s: number): number {
  return s <= 0.5 ? multiply(b, 2 * s) : screen(b, 2 * s - 1)
}

/** Overlay 就是「参数对调」的 Hard Light。 */
export function overlay(b: number, s: number): number {
  return hardLight(s, b)
}

export function softLight(b: number, s: number): number {
  if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b)
  const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)
  return b + (2 * s - 1) * (d - b)
}

export function vividLight(b: number, s: number): number {
  return s <= 0.5 ? colorBurn(b, 2 * s) : colorDodge(b, 2 * s - 1)
}

export function linearLight(b: number, s: number): number {
  return s <= 0.5 ? linearBurn(b, 2 * s) : linearDodge(b, 2 * s - 1)
}

export function pinLight(b: number, s: number): number {
  return s <= 0.5 ? darken(b, 2 * s) : lighten(b, 2 * s - 1)
}

/** Hard Mix：Vivid Light 之后再二值化，与 Photoshop 的表现一致。 */
export function hardMix(b: number, s: number): number {
  return vividLight(b, s) < 0.5 ? 0 : 1
}

export const subtract = (b: number, s: number): number => clamp01(b - s)

/** Divide：Cs 为 0 时结果为白。 */
export function divide(b: number, s: number): number {
  if (s <= 0) return 1
  return clamp01(b / s)
}

// —— 非分量级（Hue / Saturation / Color / Luminosity）——

/** 亮度权重（Rec.709），与 PDF/W3C 一致。 */
const LUM_R = 0.3
const LUM_G = 0.59
const LUM_B = 0.11

export type RGB = readonly [number, number, number]

export const lum = (c: RGB): number => LUM_R * c[0] + LUM_G * c[1] + LUM_B * c[2]

export function clipColor(c: RGB): RGB {
  const l = lum(c)
  let r = c[0]
  let g = c[1]
  let b = c[2]
  const min = Math.min(r, g, b)
  const max = Math.max(r, g, b)
  if (min < 0) {
    const d = l - min
    if (d > 0) {
      r = l + ((r - l) * l) / d
      g = l + ((g - l) * l) / d
      b = l + ((b - l) * l) / d
    }
  }
  if (max > 1) {
    const d = max - l
    if (d > 0) {
      r = l + ((r - l) * (1 - l)) / d
      g = l + ((g - l) * (1 - l)) / d
      b = l + ((b - l) * (1 - l)) / d
    }
  }
  return [r, g, b]
}

export const setLum = (c: RGB, l: number): RGB => {
  const d = l - lum(c)
  return clipColor([c[0] + d, c[1] + d, c[2] + d])
}

export const sat = (c: RGB): number => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2])

export function setSat(c: RGB, s: number): RGB {
  const idx = [0, 1, 2] as const
  const sorted = idx.slice().sort((i, j) => c[i]! - c[j]!)
  const lo = sorted[0]!
  const mid = sorted[1]!
  const hi = sorted[2]!
  const out: [number, number, number] = [0, 0, 0]
  if (c[hi]! > c[lo]!) {
    out[mid] = ((c[mid]! - c[lo]!) * s) / (c[hi]! - c[lo]!)
    out[hi] = s
  }
  return out
}

export function hue(b: RGB, s: RGB): RGB {
  return setLum(setSat(s, sat(b)), lum(b))
}

export function saturation(b: RGB, s: RGB): RGB {
  return setLum(setSat(b, sat(s)), lum(b))
}

export function color(b: RGB, s: RGB): RGB {
  return setLum(s, lum(b))
}

export function luminosity(b: RGB, s: RGB): RGB {
  return setLum(b, lum(s))
}

/** 按官方名称分派。未知名称回退到 Normal。 */
export function blendRGB(mode: string, base: RGB, src: RGB): RGB {
  switch (mode) {
    case 'Normal':
      return src
    case 'Darken':
      return [darken(base[0], src[0]), darken(base[1], src[1]), darken(base[2], src[2])]
    case 'Multiply':
      return [multiply(base[0], src[0]), multiply(base[1], src[1]), multiply(base[2], src[2])]
    case 'Color Burn':
      return [colorBurn(base[0], src[0]), colorBurn(base[1], src[1]), colorBurn(base[2], src[2])]
    case 'Linear Burn':
      return [linearBurn(base[0], src[0]), linearBurn(base[1], src[1]), linearBurn(base[2], src[2])]
    case 'Lighten':
      return [lighten(base[0], src[0]), lighten(base[1], src[1]), lighten(base[2], src[2])]
    case 'Screen':
      return [screen(base[0], src[0]), screen(base[1], src[1]), screen(base[2], src[2])]
    case 'Color Dodge':
      return [colorDodge(base[0], src[0]), colorDodge(base[1], src[1]), colorDodge(base[2], src[2])]
    case 'Linear Dodge (Add)':
      return [linearDodge(base[0], src[0]), linearDodge(base[1], src[1]), linearDodge(base[2], src[2])]
    case 'Overlay':
      return [overlay(base[0], src[0]), overlay(base[1], src[1]), overlay(base[2], src[2])]
    case 'Soft Light':
      return [softLight(base[0], src[0]), softLight(base[1], src[1]), softLight(base[2], src[2])]
    case 'Hard Light':
      return [hardLight(base[0], src[0]), hardLight(base[1], src[1]), hardLight(base[2], src[2])]
    case 'Vivid Light':
      return [vividLight(base[0], src[0]), vividLight(base[1], src[1]), vividLight(base[2], src[2])]
    case 'Linear Light':
      return [linearLight(base[0], src[0]), linearLight(base[1], src[1]), linearLight(base[2], src[2])]
    case 'Pin Light':
      return [pinLight(base[0], src[0]), pinLight(base[1], src[1]), pinLight(base[2], src[2])]
    case 'Hard Mix':
      return [hardMix(base[0], src[0]), hardMix(base[1], src[1]), hardMix(base[2], src[2])]
    case 'Difference':
      return [difference(base[0], src[0]), difference(base[1], src[1]), difference(base[2], src[2])]
    case 'Exclusion':
      return [base[0] + src[0] - 2 * base[0] * src[0], base[1] + src[1] - 2 * base[1] * src[1], base[2] + src[2] - 2 * base[2] * src[2]]
    case 'Subtract':
      return [subtract(base[0], src[0]), subtract(base[1], src[1]), subtract(base[2], src[2])]
    case 'Divide':
      return [divide(base[0], src[0]), divide(base[1], src[1]), divide(base[2], src[2])]
    case 'Hue':
      return hue(base, src)
    case 'Saturation':
      return saturation(base, src)
    case 'Color':
      return color(base, src)
    case 'Luminosity':
      return luminosity(base, src)
    default:
      return src
  }
}

/**
 * 一个源像素按给定模式、不透明度和蒙版覆盖叠加到目标像素上。
 * 返回结果 RGB 与 alpha；输入 alpha 均为 0–1 预乘前的直通值。
 */
export function compositePixel(
  mode: string,
  base: RGB,
  baseAlpha: number,
  src: RGB,
  srcAlpha: number,
): { rgb: RGB; alpha: number } {
  const cs = srcAlpha
  const cb = baseAlpha
  const blended = blendRGB(mode, base, src)
  // W3C: Co = (1 - αb)·αs·Cs + αb·αs·B(Cb, Cs) + (1 - αs)·αb·Cb
  const outA = cs + cb * (1 - cs)
  if (outA <= 0) return { rgb: [0, 0, 0], alpha: 0 }
  const mix = (i: 0 | 1 | 2): number =>
    ((1 - cb) * cs * src[i] + cb * cs * blended[i] + (1 - cs) * cb * base[i]) / outA
  return { rgb: [mix(0), mix(1), mix(2)], alpha: outA }
}
