/**
 * 混合模式数学测试。
 * 这些函数是 WebGL 着色器的「参考实现」，两者必须一致。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  blendRGB,
  colorDodge,
  colorBurn,
  compositePixel,
  hardLight,
  lum,
  multiply,
  overlay,
  screen,
  setLum,
  softLight,
  type RGB,
} from '../src/shared/blend.ts'
import { BLEND_MODES } from '../src/shared/types.ts'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

test('基本分量公式与 PDF/W3C 定义一致', () => {
  assert.equal(multiply(0.5, 0.5), 0.25)
  assert.equal(screen(0.5, 0.5), 0.75)
  assert.ok(close(colorBurn(0.5, 0.5), 0))
  assert.ok(close(colorDodge(0.5, 0.5), 1))
  // Hard Light 在 s=0.5 时退化为 Multiply(b,1)=b
  assert.ok(close(hardLight(0.3, 0.5), 0.3))
  // Overlay 是参数对调的 Hard Light
  for (const b of [0, 0.25, 0.5, 0.75, 1]) {
    for (const s of [0, 0.3, 0.5, 0.8, 1]) {
      assert.ok(close(overlay(b, s), hardLight(s, b)), `overlay(${b},${s})`)
    }
  }
})

test('Soft Light 在 s=0.5 时保持基色不变', () => {
  for (const b of [0, 0.2, 0.5, 0.8, 1]) {
    assert.ok(close(softLight(b, 0.5), b, 1e-9), `softLight(${b},0.5)`)
  }
})

test('setLum 后亮度等于目标亮度', () => {
  const c: RGB = [0.2, 0.6, 0.9]
  for (const target of [0, 0.35, 0.5, 0.75, 1]) {
    assert.ok(close(lum(setLum(c, target)), target, 1e-6), `setLum target=${target}`)
  }
})

test('全部 24 种模式：输出有限且在 0–1 内', () => {
  const samples: RGB[] = [
    [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5], [0, 0.5, 1], [1, 0, 0.5], [0.25, 0.75, 0.1],
  ]
  for (const mode of BLEND_MODES) {
    for (const b of samples) {
      for (const s of samples) {
        const out = blendRGB(mode, b, s)
        for (const v of out) {
          assert.ok(Number.isFinite(v), `${mode} 产生了非有限值`)
          assert.ok(v >= -1e-6 && v <= 1 + 1e-6, `${mode} 越界: ${v}（base=${b} src=${s}）`)
        }
      }
    }
  }
})

test('Normal 直接返回源色', () => {
  assert.deepEqual(blendRGB('Normal', [0.1, 0.2, 0.3], [0.9, 0.8, 0.7]), [0.9, 0.8, 0.7])
})

test('Difference 与 Exclusion 的已知取值', () => {
  assert.ok(close(blendRGB('Difference', [0.8, 0.2, 0.5], [0.3, 0.2, 0.9])[0]!, 0.5))
  assert.deepEqual(blendRGB('Difference', [0.4, 0.4, 0.4], [0.4, 0.4, 0.4]), [0, 0, 0])
  // Exclusion: b + s - 2bs
  const ex = blendRGB('Exclusion', [0.5, 0.5, 0.5], [0.5, 0.5, 0.5])
  assert.ok(close(ex[0]!, 0.5))
})

test('Subtract / Divide 的边界行为', () => {
  assert.deepEqual(blendRGB('Subtract', [0.3, 0.3, 0.3], [0.7, 0.7, 0.7]), [0, 0, 0])
  assert.deepEqual(blendRGB('Divide', [0.5, 0.5, 0.5], [0, 0, 0]), [1, 1, 1])
})

test('源不透明时 compositePixel 等于混合结果', () => {
  for (const mode of BLEND_MODES) {
    const b: RGB = [0.4, 0.55, 0.7]
    const s: RGB = [0.9, 0.2, 0.33]
    const { rgb, alpha } = compositePixel(mode, b, 1, s, 1)
    const expected = blendRGB(mode, b, s)
    for (let i = 0; i < 3; i++) assert.ok(close(rgb[i]!, expected[i]!), `${mode}[${i}]`)
    assert.ok(close(alpha, 1))
  }
})

test('源完全透明时不改变基色', () => {
  const { rgb, alpha } = compositePixel('Multiply', [0.3, 0.6, 0.9], 1, [1, 0, 0], 0)
  assert.ok(close(rgb[0]!, 0.3) && close(rgb[1]!, 0.6) && close(rgb[2]!, 0.9))
  assert.ok(close(alpha, 1))
})

test('alpha 合成符合 W3C：两者都半透明', () => {
  const { alpha } = compositePixel('Normal', [0, 0, 0], 0.5, [0, 0, 0], 0.5)
  // outA = 0.5 + 0.5*0.5 = 0.75
  assert.ok(close(alpha, 0.75))
})
