/**
 * WebGL2 合成器。
 *
 * 渲染顺序自下而上遍历图层；每趟都把「已合成背景」与「本图层」按
 * 官方定义的混合模式与 W3C alpha 公式合并到另一个 FBO（乒乓），
 * 因此任意图层都能正确看到它下面的所有内容。
 *
 * 坐标约定
 *   文档坐标：像素，y 向下，(0,0) 在左上角
 *   图层局部：归一化 0..1，映射到该图层的画布像素
 *   纹理：v=0 对应图像顶部
 */
import {
  ADJUST_FS,
  ALPHA_FS,
  DILATE_FS,
  BLIT_FS,
  BLEND_CODES,
  BLUR_FS,
  DISPLAY_FS,
  EFFECTS_FS,
  GRID_FS,
  LAYER_FS,
  MAX_VISIBLE_GUIDES,
  PAD_COPY_FS,
  QUAD_VS,
  RECT_VS,
  RECT_STROKE_FS,
  SELECTION_FS,
  TRANSFORM_FS,
  ADJUST_CODES,
} from './shaders.ts'
import type { BlendMode, LayerRecord, Manifest, Transform } from '../../shared/types.ts'

/** 一个图层的像素载体：可读写、可上传、可编码 PNG。 */
export interface LayerPixels {
  canvas: OffscreenCanvas
  /** 每次像素被修改后自增，用于判断是否需要重新上传纹理。 */
  version: number
}

export interface ViewTransform {
  zoom: number
  /** 文档原点在画布上的位置（CSS 像素）。 */
  panX: number
  panY: number
}

/** 图层效果的渲染结果：一张四周外扩过的纹理。 */
interface EffectRender {
  /** 缓存键，含像素版本与效果参数。 */
  key: string
  tex: WebGLTexture
  /** 外扩像素数（图层局部单位）。 */
  padding: number
  width: number
  height: number
  /** 随结果一起管理的中间纹理与帧缓冲。 */
  textures: WebGLTexture[]
  fbos: WebGLFramebuffer[]
}

/** 收集一次效果渲染产生的临时资源，便于统一释放。 */
interface EffectSink {
  textures: WebGLTexture[]
  fbos: WebGLFramebuffer[]
}

/** 选区蒙版：文档尺寸的灰度图，0 = 未选中，255 = 选中。 */
export interface SelectionMask {
  mask: Uint8ClampedArray
  width: number
  height: number
  /** 内容每次变化时自增，用来判断是否需要重新上传纹理。 */
  version: number
}

export interface RenderInput {
  manifest: Manifest
  pixels: Map<string, LayerPixels>
  view: ViewTransform
  /** 选区轮廓（蚂蚁线）。 */
  selection?: SelectionMask | null
  /** 临时矩形提示（裁剪预览等），文档坐标 [x, y, w, h]。 */
  marqueeRect?: [number, number, number, number] | null
  /** 画布辅助。 */
  showGrid?: boolean
  showPixelGrid?: boolean
  gridSpacing?: number
  guides?: { axis: 'horizontal' | 'vertical'; position: number }[]
  /** 正在拖拽的参考线下标（高亮显示）。 */
  activeGuide?: number
  /** 要显示变换框的图层矩形（文档坐标）。 */
  transformRect?: [number, number, number, number] | null
}

// —— 3×3 矩阵工具（列主序，与 GLSL mat3 一致）——

export type Mat3 = Float32Array

const IDENTITY = (): Mat3 => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])

function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = new Float32Array(9)
  for (let c = 0; c < 3; c++) {
    for (let r = 0; r < 3; r++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum += a[k * 3 + r]! * b[c * 3 + k]!
      out[c * 3 + r] = sum
    }
  }
  return out
}

function translate(tx: number, ty: number): Mat3 {
  return new Float32Array([1, 0, 0, 0, 1, 0, tx, ty, 1])
}

function scale(sx: number, sy: number): Mat3 {
  return new Float32Array([sx, 0, 0, 0, sy, 0, 0, 0, 1])
}

function rotate(theta: number): Mat3 {
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  // y 向下的坐标系中，视觉顺时针旋转
  return new Float32Array([c, s, 0, -s, c, 0, 0, 0, 1])
}

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m as unknown as number[]
  const A = e! * i! - f! * h!
  const B = -(d! * i! - f! * g!)
  const C = d! * h! - e! * g!
  const det = a! * A + b! * B + c! * C
  if (Math.abs(det) < 1e-12) return IDENTITY()
  const inv = 1 / det
  return new Float32Array([
    A * inv, (-(b! * i! - c! * h!)) * inv, (b! * f! - c! * e!) * inv,
    B * inv, (a! * i! - c! * g!) * inv, (-(a! * f! - c! * d!)) * inv,
    C * inv, (-(a! * h! - b! * g!)) * inv, (a! * e! - b! * d!) * inv,
  ])
}

/** 由图层的 transform 构造「图层局部 0..1 → 文档像素」矩阵。 */
export function layerToDocMatrix(t: Transform): Mat3 {
  const w = t.size[0]
  const h = t.size[1]
  const cx = t.origin[0] + w / 2
  const cy = t.origin[1] + h / 2
  let m = translate(cx, cy)
  if (t.rotation) m = multiply(m, rotate((t.rotation * Math.PI) / 180))
  m = multiply(m, scale(w, h))
  // 翻转发生在局部空间，且是绕中心的
  if (t.flipX || t.flipY) {
    m = multiply(m, scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1))
  }
  m = multiply(m, translate(-0.5, -0.5))
  return m
}

/** 纹理采样方式 → GL 过滤参数是否用线性。 */
const isLinear = (t: Transform): boolean => t.sampling !== 'Nearest'

interface Program {
  program: WebGLProgram
  uniforms: Record<string, WebGLUniformLocation | null>
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)
  if (!sh) throw new Error('无法创建着色器')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? ''
    gl.deleteShader(sh)
    throw new Error(`着色器编译失败：${log}`)
  }
  return sh
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): Program {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc)
  const program = gl.createProgram()
  if (!program) throw new Error('无法创建程序')
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.bindAttribLocation(program, 0, 'aPos')
  gl.linkProgram(program)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? ''
    throw new Error(`着色器链接失败：${log}`)
  }
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number
  const uniforms: Record<string, WebGLUniformLocation | null> = {}
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i)
    if (!info) continue
    uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name)
  }
  return { program, uniforms }
}

/** 帧缓冲池：合成的每一层都需要「读一张、写另一张」。 */
class FboPool {
  private free: WebGLFramebuffer[] = []

  constructor(
    private readonly gl: WebGL2RenderingContext,
    public width: number,
    public height: number,
  ) {}

  acquire(): WebGLFramebuffer {
    const reuse = this.free.pop()
    if (reuse) return reuse
    const fbo = this.gl.createFramebuffer()
    if (!fbo) throw new Error('无法创建帧缓冲')
    const tex = this.gl.createTexture()
    if (!tex) throw new Error('无法创建纹理')
    this.gl.bindTexture(this.gl.TEXTURE_2D, tex)
    this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA8, this.width, this.height, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, null)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE)
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo)
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, tex, 0)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null)
    // 把纹理标记到 fbo 上，便于取回
    ;(fbo as unknown as { __tex: WebGLTexture }).__tex = tex
    return fbo
  }

  release(fbo: WebGLFramebuffer): void {
    this.free.push(fbo)
  }

  textureOf(fbo: WebGLFramebuffer): WebGLTexture {
    return (fbo as unknown as { __tex: WebGLTexture }).__tex
  }

  resize(w: number, h: number): void {
    this.dispose()
    this.width = w
    this.height = h
  }

  dispose(): void {
    for (const fbo of this.free) {
      const tex = this.textureOf(fbo)
      this.gl.deleteTexture(tex)
      this.gl.deleteFramebuffer(fbo)
    }
    this.free = []
  }
}

export class Compositor {
  readonly gl: WebGL2RenderingContext
  private layerProgram: Program
  private blitProgram: Program
  private adjustProgram: Program
  private displayProgram: Program
  private selectionProgram: Program
  private rectStrokeProgram: Program
  private blurProgram: Program
  private alphaProgram: Program
  private dilateProgram: Program
  private effectsProgram: Program
  private padCopyProgram: Program
  private gridProgram: Program
  private transformProgram: Program

  private vao: WebGLVertexArrayObject
  private pool!: FboPool
  private docW = 0
  private docH = 0

  /** layerId -> 纹理 */
  // canvas 也一并记住：文字图层重绘时可能换成**新的** canvas 对象，
  // 而新对象的 version 会从头计数，仅比较 version 会漏掉这次更新
  // （表现就是「改了没反应 / 打上字没有显示」）。
  private layerTextures = new Map<
    string,
    { tex: WebGLTexture; version: number; canvas: LayerPixels['canvas'] | null }
  >()
  /** 图层效果渲染结果的缓存；key 里含像素版本与效果参数。 */
  private effectCache = new Map<string, EffectRender>()
  private curveLUT: WebGLTexture | null = null
  /** 选区蒙版纹理及其版本 / 尺寸缓存。 */
  private selectionTex: WebGLTexture | null = null
  private selectionVersion = -1
  private selectionSize = ''
  /** 复用的读像素缓冲 */
  private readBuffer: Uint8Array | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError?: (msg: string) => void,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    })
    if (!gl) throw new Error('当前环境不支持 WebGL2，无法启动渲染引擎。')
    this.gl = gl

    this.layerProgram = link(gl, QUAD_VS, LAYER_FS)
    this.blitProgram = link(gl, QUAD_VS, BLIT_FS)
    this.adjustProgram = link(gl, QUAD_VS, ADJUST_FS)
    this.displayProgram = link(gl, RECT_VS, DISPLAY_FS)
    this.selectionProgram = link(gl, RECT_VS, SELECTION_FS)
    this.rectStrokeProgram = link(gl, RECT_VS, RECT_STROKE_FS)
    this.blurProgram = link(gl, QUAD_VS, BLUR_FS)
    this.alphaProgram = link(gl, QUAD_VS, ALPHA_FS)
    this.dilateProgram = link(gl, QUAD_VS, DILATE_FS)
    this.effectsProgram = link(gl, QUAD_VS, EFFECTS_FS)
    this.padCopyProgram = link(gl, QUAD_VS, PAD_COPY_FS)
    this.gridProgram = link(gl, RECT_VS, GRID_FS)
    this.transformProgram = link(gl, RECT_VS, TRANSFORM_FS)

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('无法创建 VAO')
    this.vao = vao
    gl.bindVertexArray(vao)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    // 两个三角形组成的单位四边形
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND) // 混合由着色器完成
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
  }

  /** 按 CSS 尺寸与设备像素比调整画布。 */
  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssWidth * dpr))
    const h = Math.max(1, Math.round(cssHeight * dpr))
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }
  }

  get canvasWidth(): number {
    return this.canvas.width
  }

  get canvasHeight(): number {
    return this.canvas.height
  }

  /** 确保文档尺寸的 FBO 池就绪。 */
  private ensureDocSize(w: number, h: number): void {
    if (this.docW === w && this.docH === h && this.pool) return
    if (this.pool) this.pool.resize(w, h)
    else this.pool = new FboPool(this.gl, w, h)
    this.docW = w
    this.docH = h
    this.readBuffer = null
  }

  /** 把图层的 OffscreenCanvas 上传/刷新到纹理。 */
  private textureFor(layer: LayerRecord, pixels: LayerPixels): WebGLTexture {
    const gl = this.gl
    let entry = this.layerTextures.get(layer.id)
    if (!entry) {
      const tex = gl.createTexture()
      if (!tex) throw new Error('无法创建图层纹理')
      entry = { tex, version: -1, canvas: null }
      this.layerTextures.set(layer.id, entry)
    }
    if (entry.version !== pixels.version || entry.canvas !== pixels.canvas) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pixels.canvas)
      const filter = isLinear(layer.transform) ? gl.LINEAR : gl.NEAREST
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry.version = pixels.version
      entry.canvas = pixels.canvas
    }
    return entry.tex
  }

  /** 直接由 OffscreenCanvas 取得纹理（用于剪贴蒙版的源图层）。 */
  private pixelTexture(id: string, pixels: LayerPixels): WebGLTexture {
    const gl = this.gl
    let entry = this.layerTextures.get(id)
    if (!entry) {
      const tex = gl.createTexture()
      if (!tex) throw new Error('无法创建纹理')
      entry = { tex, version: -1, canvas: null }
      this.layerTextures.set(id, entry)
    }
    if (entry.version !== pixels.version || entry.canvas !== pixels.canvas) {
      gl.bindTexture(gl.TEXTURE_2D, entry.tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, pixels.canvas)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry.version = pixels.version
      entry.canvas = pixels.canvas
    }
    return entry.tex
  }

  // —— 图层效果 ——

  /** 创建一个离屏渲染目标。 */
  private makeTarget(w: number, h: number): { fbo: WebGLFramebuffer; tex: WebGLTexture } {
    const gl = this.gl
    const tex = gl.createTexture()
    const fbo = gl.createFramebuffer()
    if (!tex || !fbo) throw new Error('无法创建离屏渲染目标')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { fbo, tex }
  }

  /** 在给定目标上画满整个单位四边形。 */
  private drawFullQuad(w: number, h: number, target: WebGLFramebuffer | null): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }

  /** 对 alpha 做一次可分离高斯模糊，返回结果纹理（中间产物记入 sink 以便释放）。 */
  /**
   * 形态学膨胀：取 ±radius 内的最大 alpha，分离式（先水平再垂直）。
   * 描边用它而不是模糊 —— 模糊会把边缘摊成渐变（发虚），膨胀得到的是实色外扩。
   */
  private dilateAlphaInto(
    srcTex: WebGLTexture,
    w: number,
    h: number,
    radius: number,
    sink: EffectSink,
  ): WebGLTexture {
    const gl = this.gl
    const r = Math.max(0, radius)
    if (r <= 0) return srcTex
    const a = this.makeTarget(w, h)
    const b = this.makeTarget(w, h)
    sink.textures.push(a.tex, b.tex)
    sink.fbos.push(a.fbo, b.fbo)

    gl.useProgram(this.dilateProgram.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(this.dilateProgram.uniforms['uSrc']!, 0)
    gl.uniform1f(this.dilateProgram.uniforms['uRadius']!, r)
    gl.uniform2f(this.dilateProgram.uniforms['uStep']!, 1 / w, 0)
    this.drawFullQuad(w, h, a.fbo)

    gl.bindTexture(gl.TEXTURE_2D, a.tex)
    gl.uniform2f(this.dilateProgram.uniforms['uStep']!, 0, 1 / h)
    this.drawFullQuad(w, h, b.fbo)

    gl.bindVertexArray(null)
    return b.tex
  }

  private blurAlphaInto(
    srcTex: WebGLTexture,
    w: number,
    h: number,
    radius: number,
    sink: EffectSink,
  ): WebGLTexture {
    const gl = this.gl
    const r = Math.max(0.5, radius)
    const a = this.makeTarget(w, h)
    const b = this.makeTarget(w, h)
    sink.textures.push(a.tex, b.tex)
    sink.fbos.push(a.fbo, b.fbo)

    gl.useProgram(this.blurProgram.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, srcTex)
    gl.uniform1i(this.blurProgram.uniforms['uSrc']!, 0)
    gl.uniform1f(this.blurProgram.uniforms['uSigma']!, 0.32)
    gl.uniform1f(this.blurProgram.uniforms['uRadius']!, r)
    gl.uniform2f(this.blurProgram.uniforms['uStep']!, 1 / w, 0)
    this.drawFullQuad(w, h, a.fbo)

    gl.bindTexture(gl.TEXTURE_2D, a.tex)
    gl.uniform2f(this.blurProgram.uniforms['uStep']!, 0, 1 / h)
    this.drawFullQuad(w, h, b.fbo)

    gl.bindVertexArray(null)
    return b.tex
  }

  private releaseEffect(r: EffectRender): void {
    const gl = this.gl
    for (const f of r.fbos) gl.deleteFramebuffer(f)
    for (const t of r.textures) gl.deleteTexture(t)
  }

  /**
   * 渲染图层的图层效果，返回一张四周各外扩 padding 像素的纹理。
   *
   * 叠加顺序严格按官方文档（自下而上）：
   * 投影 → 外发光 → 外侧描边 → 图层像素 → 颜色叠加 → 内发光 → 内阴影 → 内侧描边。
   * 描边的膨胀/腐蚀用「模糊 + 阈值化」近似（官方是 GPU 形态学运算）。
   */
  private renderEffects(layer: LayerRecord, own: LayerPixels): EffectRender | null {
    const fx = layer.effects
    const on = (e?: { enabled?: boolean }): boolean => Boolean(e) && e!.enabled !== false
    const any =
      fx && (on(fx.stroke) || on(fx.shadow) || on(fx.colorOverlay) || on(fx.innerShadow) || on(fx.outerGlow) || on(fx.innerGlow))
    if (!any) return null

    const key = `${own.version}|${JSON.stringify(fx)}`
    const cached = this.effectCache.get(layer.id)
    if (cached?.key === key) return cached
    if (cached) this.releaseEffect(cached)

    const gl = this.gl
    const w = own.canvas.width
    const h = own.canvas.height

    let padding = 0
    if (on(fx.shadow)) padding = Math.max(padding, fx.shadow!.distance + fx.shadow!.blur)
    if (on(fx.outerGlow)) padding = Math.max(padding, (fx.outerGlow!.size ?? 0) * 2)
    if (on(fx.stroke) && !fx.stroke!.inside) padding = Math.max(padding, fx.stroke!.size * 2)
    padding = Math.ceil(padding)

    const W = w + padding * 2
    const H = h + padding * 2
    const sink: EffectSink = { textures: [], fbos: [] }

    // 1) 原像素铺进扩展画布的中心
    const padded = this.makeTarget(W, H)
    sink.textures.push(padded.tex)
    sink.fbos.push(padded.fbo)
    gl.useProgram(this.padCopyProgram.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pixelTexture(layer.id, own))
    gl.uniform1i(this.padCopyProgram.uniforms['uSrc']!, 0)
    gl.uniform2f(this.padCopyProgram.uniforms['uInnerSize']!, w, h)
    gl.uniform2f(this.padCopyProgram.uniforms['uOuterSize']!, W, H)
    this.drawFullQuad(W, H, padded.fbo)

    // 2) 抽出 alpha 作为各效果的模糊输入
    const alpha = this.makeTarget(W, H)
    sink.textures.push(alpha.tex)
    sink.fbos.push(alpha.fbo)
    gl.useProgram(this.alphaProgram.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, padded.tex)
    gl.uniform1i(this.alphaProgram.uniforms['uSrc']!, 0)
    this.drawFullQuad(W, H, alpha.fbo)

    const shadowBlur = on(fx.shadow) ? this.blurAlphaInto(alpha.tex, W, H, fx.shadow!.blur, sink) : alpha.tex
    const glowBlur = on(fx.outerGlow) ? this.blurAlphaInto(alpha.tex, W, H, fx.outerGlow!.size ?? 0, sink) : alpha.tex
    const innerShadowBlur = on(fx.innerShadow) ? this.blurAlphaInto(alpha.tex, W, H, fx.innerShadow!.blur, sink) : alpha.tex
    const innerGlowBlur = on(fx.innerGlow) ? this.blurAlphaInto(alpha.tex, W, H, fx.innerGlow!.size ?? 0, sink) : alpha.tex
    // 描边用形态学膨胀（实色外扩），而不是模糊 + 阈值（发散、发虚）。
    // 膨胀半径就等于外侧描边的宽度。
    const strokeBlur = on(fx.stroke)
      ? this.dilateAlphaInto(alpha.tex, W, H, fx.stroke!.size, sink)
      : alpha.tex

    // 3) 合成
    const out = this.makeTarget(W, H)
    sink.textures.push(out.tex)
    sink.fbos.push(out.fbo)

    const p = this.effectsProgram
    gl.useProgram(p.program)
    const bind = (name: string, unit: number, tex: WebGLTexture): void => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.uniform1i(p.uniforms[name]!, unit)
    }
    bind('uLayer', 0, padded.tex)
    bind('uShadowBlur', 1, shadowBlur)
    bind('uGlowBlur', 2, glowBlur)
    bind('uInnerShadowBlur', 3, innerShadowBlur)
    bind('uInnerGlowBlur', 4, innerGlowBlur)
    bind('uStrokeBlur', 5, strokeBlur)

    const black: [number, number, number] = [0, 0, 0]
    const white: [number, number, number] = [1, 1, 1]

    if (on(fx.shadow)) {
      const s = fx.shadow!
      const ang = (s.angle * Math.PI) / 180
      gl.uniform1i(p.uniforms['uHasShadow']!, 1)
      gl.uniform3fv(p.uniforms['uShadowColor']!, s.color ?? black)
      gl.uniform1f(p.uniforms['uShadowOpacity']!, s.opacity ?? 0.75)
      gl.uniform2f(
        p.uniforms['uShadowOffset']!,
        (Math.cos(ang) * s.distance) / W,
        (Math.sin(ang) * s.distance) / H,
      )
    } else {
      gl.uniform1i(p.uniforms['uHasShadow']!, 0)
    }

    if (on(fx.outerGlow)) {
      const g = fx.outerGlow!
      gl.uniform1i(p.uniforms['uHasGlow']!, 1)
      gl.uniform3fv(p.uniforms['uGlowColor']!, g.color ?? white)
      gl.uniform1f(p.uniforms['uGlowOpacity']!, g.opacity ?? 0.75)
    } else {
      gl.uniform1i(p.uniforms['uHasGlow']!, 0)
    }

    if (on(fx.stroke)) {
      const s = fx.stroke!
      gl.uniform1i(p.uniforms['uHasStroke']!, 1)
      gl.uniform3fv(p.uniforms['uStrokeColor']!, s.color ?? black)
      gl.uniform1f(p.uniforms['uStrokeOpacity']!, s.opacity ?? 1)
      gl.uniform1i(p.uniforms['uStrokeInside']!, s.inside ? 1 : 0)
    } else {
      gl.uniform1i(p.uniforms['uHasStroke']!, 0)
    }

    if (on(fx.colorOverlay)) {
      const c = fx.colorOverlay!
      gl.uniform1i(p.uniforms['uHasColorOverlay']!, 1)
      gl.uniform3fv(p.uniforms['uOverlayColor']!, c.color ?? black)
      gl.uniform1f(p.uniforms['uOverlayOpacity']!, c.opacity ?? 1)
    } else {
      gl.uniform1i(p.uniforms['uHasColorOverlay']!, 0)
    }

    if (on(fx.innerShadow)) {
      const s = fx.innerShadow!
      const ang = (s.angle * Math.PI) / 180
      gl.uniform1i(p.uniforms['uHasInnerShadow']!, 1)
      gl.uniform3fv(p.uniforms['uInnerShadowColor']!, s.color ?? black)
      gl.uniform1f(p.uniforms['uInnerShadowOpacity']!, s.opacity ?? 0.75)
      gl.uniform2f(
        p.uniforms['uInnerShadowOffset']!,
        (Math.cos(ang) * s.distance) / W,
        (Math.sin(ang) * s.distance) / H,
      )
    } else {
      gl.uniform1i(p.uniforms['uHasInnerShadow']!, 0)
    }

    if (on(fx.innerGlow)) {
      const g = fx.innerGlow!
      gl.uniform1i(p.uniforms['uHasInnerGlow']!, 1)
      gl.uniform3fv(p.uniforms['uInnerGlowColor']!, g.color ?? white)
      gl.uniform1f(p.uniforms['uInnerGlowOpacity']!, g.opacity ?? 0.75)
    } else {
      gl.uniform1i(p.uniforms['uHasInnerGlow']!, 0)
    }

    this.drawFullQuad(W, H, out.fbo)
    gl.bindVertexArray(null)

    const result: EffectRender = {
      key,
      tex: out.tex,
      padding,
      width: W,
      height: H,
      textures: sink.textures,
      fbos: sink.fbos,
    }
    this.effectCache.set(layer.id, result)
    return result
  }

  dispose(): void {
    const gl = this.gl
    this.pool?.dispose()
    for (const { tex } of this.layerTextures.values()) gl.deleteTexture(tex)
    this.layerTextures.clear()
    for (const r of this.effectCache.values()) this.releaseEffect(r)
    this.effectCache.clear()
    if (this.curveLUT) gl.deleteTexture(this.curveLUT)
    if (this.selectionTex) gl.deleteTexture(this.selectionTex)
    gl.deleteVertexArray(this.vao)
    for (const p of [
      this.layerProgram,
      this.blitProgram,
      this.adjustProgram,
      this.displayProgram,
      this.selectionProgram,
      this.rectStrokeProgram,
      this.gridProgram,
      this.transformProgram,
    ]) {
      gl.deleteProgram(p.program)
    }
  }

  // —— 渲染 ——

  /** 合成整个文档并显示到画布。 */
  render(input: RenderInput): void {
    const gl = this.gl
    const { manifest, pixels, view } = input
    const w = Math.max(1, Math.round(manifest.width))
    const h = Math.max(1, Math.round(manifest.height))
    this.ensureDocSize(w, h)

    // 1) 在文档尺寸上合成
    const target = this.pool.acquire()
    this.compositeInto(target, manifest, pixels, null, 0)

    // 2) 显示到画布
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    const dpr = this.canvas.width / this.canvas.clientWidth || 1
    gl.clearColor(0.106, 0.114, 0.129, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const docW = w * view.zoom * dpr
    const docH = h * view.zoom * dpr
    const rect = [view.panX * dpr, view.panY * dpr, docW, docH]

    gl.useProgram(this.displayProgram.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pool.textureOf(target))
    gl.uniform1i(this.displayProgram.uniforms['uTex']!, 0)
    gl.uniform2f(this.displayProgram.uniforms['uDocSize']!, w, h)
    gl.uniform1f(this.displayProgram.uniforms['uCheckerSize']!, 8)
    gl.uniform3f(this.displayProgram.uniforms['uCheckerA']!, 0.165, 0.173, 0.192)
    gl.uniform3f(this.displayProgram.uniforms['uCheckerB']!, 0.137, 0.145, 0.161)
    gl.uniform4f(this.displayProgram.uniforms['uRect']!, rect[0]!, rect[1]!, rect[2]!, rect[3]!)
    gl.uniform2f(this.displayProgram.uniforms['uCanvasSize']!, this.canvas.width, this.canvas.height)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // 叠加层画在屏幕空间，且必须开真正的 alpha 混合
    this.drawOverlays(input, rect)

    gl.bindVertexArray(null)
    this.pool.release(target)
  }

  /** 屏幕空间的叠加提示：裁剪预览框 + 选区蚂蚁线。 */
  private drawOverlays(input: RenderInput, docRect: number[]): void {
    const gl = this.gl
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // 网格与参考线（画在文档区域内，位于其它提示之下）
    const guides = input.guides ?? []
    const showGrid = Boolean(input.showGrid)
    const showPixel = Boolean(input.showPixelGrid)
    if (showGrid || showPixel || guides.length > 0) {
      const dpr = this.canvas.width / this.canvas.clientWidth || 1
      const count = Math.min(guides.length, MAX_VISIBLE_GUIDES)
      const arr = new Float32Array(MAX_VISIBLE_GUIDES * 2)
      for (let i = 0; i < count; i++) {
        const g = guides[i]!
        arr[i * 2] = g.axis === 'horizontal' ? 0 : 1
        arr[i * 2 + 1] = g.position
      }
      const p = this.gridProgram
      gl.useProgram(p.program)
      gl.uniform2f(p.uniforms['uDocSize']!, input.manifest.width, input.manifest.height)
      gl.uniform4f(p.uniforms['uRect']!, docRect[0]!, docRect[1]!, docRect[2]!, docRect[3]!)
      gl.uniform1f(p.uniforms['uZoom']!, input.view.zoom * dpr)
      gl.uniform1f(p.uniforms['uGridSpacing']!, input.gridSpacing ?? 64)
      gl.uniform1f(p.uniforms['uShowGrid']!, showGrid ? 1 : 0)
      gl.uniform1f(p.uniforms['uShowPixelGrid']!, showPixel ? 1 : 0)
      gl.uniform1f(p.uniforms['uGuideCount']!, count)
      gl.uniform2fv(p.uniforms['uGuides']!, arr)
      gl.uniform1i(p.uniforms['uActiveGuide']!, input.activeGuide ?? -1)
      gl.uniform2f(p.uniforms['uCanvasSize']!, this.canvas.width, this.canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    if (input.marqueeRect) {
      const [mx, my, mw, mh] = input.marqueeRect
      const dpr = this.canvas.width / this.canvas.clientWidth || 1
      const z = input.view.zoom * dpr
      const p = this.rectStrokeProgram
      gl.useProgram(p.program)
      gl.uniform4f(
        p.uniforms['uRect']!,
        docRect[0]! + mx * z,
        docRect[1]! + my * z,
        mw * z,
        mh * z,
      )
      gl.uniform1f(p.uniforms['uOutside']!, 0)
      gl.uniform2f(p.uniforms['uCanvasSize']!, this.canvas.width, this.canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    const sel = input.selection
    if (sel && sel.mask.length === sel.width * sel.height) {
      const p = this.selectionProgram
      gl.useProgram(p.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.selectionTexture(sel))
      gl.uniform1i(p.uniforms['uMask']!, 0)
      gl.uniform2f(p.uniforms['uDocSize']!, sel.width, sel.height)
      gl.uniform4f(p.uniforms['uRect']!, docRect[0]!, docRect[1]!, docRect[2]!, docRect[3]!)
      gl.uniform1f(p.uniforms['uDashPeriod']!, 5)
      gl.uniform3f(p.uniforms['uColorA']!, 1, 1, 1)
      gl.uniform3f(p.uniforms['uColorB']!, 0.08, 0.08, 0.08)
      gl.uniform2f(p.uniforms['uCanvasSize']!, this.canvas.width, this.canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    // 变换框与四角手柄（移动工具下可拖动调整大小）
    if (input.transformRect) {
      const [tx, ty, tw, th] = input.transformRect
      const dpr = this.canvas.width / this.canvas.clientWidth || 1
      const z = input.view.zoom * dpr
      const p = this.transformProgram
      gl.useProgram(p.program)
      gl.uniform4f(
        p.uniforms['uRect']!,
        docRect[0]! + tx * z,
        docRect[1]! + ty * z,
        tw * z,
        th * z,
      )
      gl.uniform1f(p.uniforms['uHandle']!, 10 * dpr)
      gl.uniform2f(p.uniforms['uCanvasSize']!, this.canvas.width, this.canvas.height)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }

    gl.disable(gl.BLEND)
  }

  /** 必要时把选区蒙版上传为单通道纹理（宽度非 4 倍数，必须设 UNPACK_ALIGNMENT）。 */
  private selectionTexture(sel: SelectionMask): WebGLTexture {
    const gl = this.gl
    if (!this.selectionTex) {
      const tex = gl.createTexture()
      if (!tex) throw new Error('无法创建选区纹理')
      this.selectionTex = tex
      this.selectionVersion = -1
      this.selectionSize = ''
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    const key = `${sel.width}x${sel.height}`
    if (this.selectionVersion !== sel.version || this.selectionSize !== key) {
      const bytes = new Uint8Array(sel.mask.buffer, sel.mask.byteOffset, sel.mask.length)
      gl.bindTexture(gl.TEXTURE_2D, this.selectionTex)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, sel.width, sel.height, 0, gl.RED, gl.UNSIGNED_BYTE, bytes)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      this.selectionVersion = sel.version
      this.selectionSize = key
    }
    return this.selectionTex
  }

  /**
   * 把「一组同级图层」自下而上合成到 dst。
   * 结果必定落在 dst 上（内部用临时 FBO 乒乓）。
   */
  private compositeInto(
    dst: WebGLFramebuffer,
    manifest: Manifest,
    pixels: Map<string, LayerPixels>,
    parentID: string | null,
    depth: number,
  ): void {
    const gl = this.gl
    const siblings = manifest.layers.filter((l) => (l.parentID ?? null) === parentID)

    this.clearFbo(dst)
    if (siblings.length === 0) return

    let cur = dst
    let scratch = this.pool.acquire()
    for (const layer of siblings) {
      const next = cur === dst ? scratch : dst
      this.renderLayer(next, cur, layer, manifest, pixels, depth)
      cur = next
    }
    if (cur !== dst) {
      this.blitCopy(cur, dst)
    }
    this.pool.release(scratch)
  }

  private clearFbo(fbo: WebGLFramebuffer): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.viewport(0, 0, this.docW, this.docH)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  private blitCopy(from: WebGLFramebuffer, to: WebGLFramebuffer): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, to)
    gl.viewport(0, 0, this.docW, this.docH)
    gl.useProgram(this.blitProgram.program)
    gl.bindVertexArray(this.vao)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pool.textureOf(from))
    gl.uniform1i(this.blitProgram.uniforms['uTex']!, 0)
    gl.uniform1f(this.blitProgram.uniforms['uOpacity']!, 1)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  /** 渲染单个图层：把 base 与它合成，结果写入 dst。 */
  private renderLayer(
    dst: WebGLFramebuffer,
    base: WebGLFramebuffer,
    layer: LayerRecord,
    manifest: Manifest,
    pixels: Map<string, LayerPixels>,
    depth: number,
  ): void {
    const gl = this.gl

    if (layer.isGroup) {
      // 组先渲染到自己的离屏缓冲，再整体按不透明度合成回来
      const groupFbo = this.pool.acquire()
      this.compositeInto(groupFbo, manifest, pixels, layer.id, depth + 1)
      this.drawLayer(
        dst, base,
        this.pool.textureOf(groupFbo),
        null, null,
        IDENTITY(), // 组缓冲已经是文档空间，直接 1:1 采样
        layer, manifest, pixels,
      )
      this.pool.release(groupFbo)
      return
    }

    if (layer.adjustment) {
      this.drawAdjustment(dst, base, layer, manifest, pixels)
      return
    }

    const own = pixels.get(layer.id)
    const maskTex = this.maskTexture(layer, pixels)
    const clip = this.clipInfo(layer, manifest, pixels)

    let tex: WebGLTexture | null = null
    let docToLayer: Mat3 = invert(layerToDocMatrix(layer.transform))

    if (own) {
      const effects = this.renderEffects(layer, own)
      if (effects) {
        // 图层效果会向四周外扩，映射矩阵要同步放大，否则效果会被裁掉
        tex = effects.tex
        const sx = layer.transform.size[0] / own.canvas.width
        const sy = layer.transform.size[1] / own.canvas.height
        const expanded: Transform = {
          ...layer.transform,
          origin: [
            layer.transform.origin[0] - effects.padding * sx,
            layer.transform.origin[1] - effects.padding * sy,
          ],
          size: [effects.width * sx, effects.height * sy],
        }
        docToLayer = invert(layerToDocMatrix(expanded))
      } else {
        tex = this.pixelTexture(layer.id, own)
      }
    }

    this.drawLayer(
      dst,
      base,
      tex,
      maskTex,
      clip?.tex ?? null,
      docToLayer,
      layer,
      manifest,
      pixels,
      clip?.docToClip,
    )
  }

  /** 图层的蒙版纹理（未启用则返回 null）。 */
  private maskTexture(layer: LayerRecord, pixels: Map<string, LayerPixels>): WebGLTexture | null {    if (!layer.maskFile || layer.maskEnabled === false) return null
    const mp = pixels.get(`${layer.id}:mask`)
    if (!mp) return null
    return this.pixelTexture(`${layer.id}:mask`, mp)
  }

  /** 剪贴蒙版：拿到源图层的纹理与「文档 → 源图层局部」矩阵。 */
  private clipInfo(
    layer: LayerRecord,
    manifest: Manifest,
    pixels: Map<string, LayerPixels>,
  ): { tex: WebGLTexture; docToClip: Mat3 } | null {
    if (!layer.maskSourceID) return null
    const src = manifest.layers.find((l) => l.id === layer.maskSourceID)
    if (!src) return null
    const sp = pixels.get(src.id)
    if (!sp) return null
    return { tex: this.pixelTexture(src.id, sp), docToClip: invert(layerToDocMatrix(src.transform)) }
  }

  /** 通用的「一层」绘制（像素图层与组共用）。 */
  private drawLayer(
    dst: WebGLFramebuffer,
    base: WebGLFramebuffer,
    layerTex: WebGLTexture | null,
    maskTex: WebGLTexture | null,
    clipTex: WebGLTexture | null,
    docToLayer: Mat3,
    layer: LayerRecord,
    manifest: Manifest,
    pixels: Map<string, LayerPixels>,
    docToClip?: Mat3,
  ): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst)
    gl.viewport(0, 0, this.docW, this.docH)

    const p = this.layerProgram
    gl.useProgram(p.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pool.textureOf(base))
    gl.uniform1i(p.uniforms['uBase']!, 0)

    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, layerTex)
    gl.uniform1i(p.uniforms['uLayer']!, 1)

    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, maskTex)
    gl.uniform1i(p.uniforms['uMask']!, 2)
    gl.uniform1i(p.uniforms['uHasMask']!, maskTex ? 1 : 0)

    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, clipTex)
    gl.uniform1i(p.uniforms['uClip']!, 3)
    gl.uniform1i(p.uniforms['uHasClip']!, clipTex ? 1 : 0)
    gl.uniform1f(p.uniforms['uClipOpacity']!, 1)

    gl.uniformMatrix3fv(p.uniforms['uDocToLayer']!, false, docToLayer)
    gl.uniformMatrix3fv(p.uniforms['uDocToMask']!, false, this.maskDocToLayer(layer))
    gl.uniformMatrix3fv(p.uniforms['uDocToClip']!, false, docToClip ?? IDENTITY())
    gl.uniform2f(p.uniforms['uDocSize']!, this.docW, this.docH)
    gl.uniform1f(p.uniforms['uOpacity']!, layer.isVisible ? layer.opacity : 0)
    gl.uniform1i(p.uniforms['uMode']!, BLEND_CODES[layer.blendMode] ?? 0)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  /** 蒙版的「文档 → 局部」矩阵：链接时跟随图层，未链接时用 maskPlacement。 */
  private maskDocToLayer(layer: LayerRecord): Mat3 {
    if (layer.maskPlacement && layer.maskLinked === false) {
      return invert(layerToDocMatrix(layer.maskPlacement))
    }
    return invert(layerToDocMatrix(layer.transform))
  }

  /** 调整图层：读取已合成背景，变换后写回。 */
  private drawAdjustment(
    dst: WebGLFramebuffer,
    base: WebGLFramebuffer,
    layer: LayerRecord,
    manifest: Manifest,
    pixels: Map<string, LayerPixels>,
  ): void {
    const gl = this.gl
    const adj = layer.adjustment!
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst)
    gl.viewport(0, 0, this.docW, this.docH)

    const p = this.adjustProgram
    gl.useProgram(p.program)
    gl.bindVertexArray(this.vao)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.pool.textureOf(base))
    gl.uniform1i(p.uniforms['uBase']!, 0)

    const maskTex = this.maskTexture(layer, pixels)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, maskTex)
    gl.uniform1i(p.uniforms['uMask']!, 1)
    gl.uniform1i(p.uniforms['uHasMask']!, maskTex ? 1 : 0)
    gl.uniformMatrix3fv(p.uniforms['uDocToMask']!, false, this.maskDocToLayer(layer))

    gl.uniform1i(p.uniforms['uKind']!, ADJUST_CODES[adj.kind] ?? 0)
    gl.uniform1f(p.uniforms['uOpacity']!, layer.isVisible ? layer.opacity : 0)
    gl.uniform2f(p.uniforms['uDocSize']!, this.docW, this.docH)
    gl.uniform2f(p.uniforms['uTexel']!, 1 / this.docW, 1 / this.docH)

    // Hue/Saturation
    gl.uniform3f(p.uniforms['uHSV']!, adj.hue, adj.saturation, adj.lightness)
    gl.uniform1f(p.uniforms['uColorize']!, adj.colorize ? 1 : 0)
    // Levels（MVP 用 RGB 通道）
    const rgb = adj.levels.ranges[0]!
    gl.uniform4f(p.uniforms['uLevelsRGB']!, rgb.black, rgb.gamma, rgb.white, 1)
    gl.uniform4f(p.uniforms['uLevelsOutRGB']!, rgb.outputBlack, 0, rgb.outputWhite, 0)
    // Exposure
    gl.uniform3f(p.uniforms['uExposure']!, adj.exposureSettings.exposure, adj.exposureSettings.offset, adj.exposureSettings.gamma)
    // Gradient Map
    gl.uniform3fv(p.uniforms['uGradShadows']!, adj.gradientMapSettings.shadows)
    gl.uniform3fv(p.uniforms['uGradHighlights']!, adj.gradientMapSettings.highlights)
    gl.uniform1f(p.uniforms['uGradReversed']!, adj.gradientMapSettings.reversed ? 1 : 0)
    // Grain / Noise
    gl.uniform4f(
      p.uniforms['uGrain']!,
      adj.kind === 'Add Noise' ? (adj.noiseAmount ?? 0) : adj.grainSettings.amount,
      adj.grainSettings.size,
      adj.grainSettings.roughness,
      adj.kind === 'Add Noise' ? (adj.noiseMonochromatic ? 1 : 0) : adj.grainSettings.monochromatic ? 1 : 0,
    )
    gl.uniform1f(p.uniforms['uSeed']!, adj.kind === 'Add Noise' ? (adj.noiseSeed ?? 0) : adj.grainSettings.seed)
    // Black & White（把 0–100 映射成通道权重）
    const bw = adj.blackWhiteSettings
    gl.uniform3f(p.uniforms['uBW1']!, bw.red / 40, bw.yellow / 100, bw.green / 40)
    gl.uniform3f(p.uniforms['uBW2']!, bw.cyan / 100, bw.blue / 20, bw.magenta / 100)
    // Color Balance
    const cb = adj.colorBalanceSettings
    gl.uniform4f(p.uniforms['uCBShadow']!, cb.shadowCyanRed, cb.shadowMagentaGreen, cb.shadowYellowBlue, 0)
    gl.uniform4f(p.uniforms['uCBMid']!, cb.midCyanRed, cb.midMagentaGreen, cb.midYellowBlue, 0)
    gl.uniform4f(p.uniforms['uCBHighlight']!, cb.highlightCyanRed, cb.highlightMagentaGreen, cb.highlightYellowBlue, 0)
    gl.uniform1f(p.uniforms['uCBPreserve']!, cb.preserveLuminosity ? 1 : 0)
    // 模糊
    gl.uniform1f(p.uniforms['uBlurRadius']!, adj.blurRadius ?? 4)
    gl.uniform1f(p.uniforms['uMotionAngle']!, adj.motionAngle ?? 0)
    gl.uniform1f(p.uniforms['uMotionDistance']!, adj.motionDistance ?? 10)
    // 曲线 LUT
    const lut = this.curvesLUT(adj.curves)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, lut)
    gl.uniform1i(p.uniforms['uCurveLUT']!, 2)
    gl.uniform1i(p.uniforms['uCurvesActive']!, adj.kind === 'Curves' ? 1 : 0)

    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.bindVertexArray(null)
  }

  /**
   * 把 4 条曲线烘焙成一张 256×4 的 LUT 纹理。
   * 行 0=RGB, 1=红, 2=绿, 3=蓝（与着色器中的 v 坐标对应）。
   */
  private curvesLUT(curves: { channels: { x: number; y: number }[][] }): WebGLTexture {
    const gl = this.gl
    if (!this.curveLUT) {
      this.curveLUT = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, this.curveLUT)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    const data = new Uint8Array(256 * 4 * 4)
    for (let ch = 0; ch < 4; ch++) {
      const pts = [...(curves.channels[ch] ?? [])].sort((a, b) => a.x - b.x)
      for (let x = 0; x < 256; x++) {
        data[(ch * 256 + x) * 4 + 0] = Math.round(evaluateCurve(pts, x))
        data[(ch * 256 + x) * 4 + 3] = 255
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.curveLUT)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    return this.curveLUT
  }

  /** 读取合成结果的 RGBA 像素（自上而下排列，可直接编码 PNG）。 */
  readDocumentPixels(manifest: Manifest, pixels: Map<string, LayerPixels>): ImageData {
    const gl = this.gl
    this.ensureDocSize(manifest.width, manifest.height)
    const fbo = this.pool.acquire()
    this.compositeInto(fbo, manifest, pixels, null, 0)

    const w = this.docW
    const h = this.docH
    const raw = new Uint8Array(w * h * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.pool.release(fbo)

    // 合成结果里纹理 v=0 就是文档顶部（与显示路径一致），而 readPixels 的第一行
    // 正是 texel 行 0，所以这里**不能再翻转**，否则导出与吸管会上下颠倒。
    return new ImageData(new Uint8ClampedArray(raw), w, h)
  }
}

/** 用折线（分段线性）求曲线在 x 处的值。 */
export function evaluateCurve(points: { x: number; y: number }[], x: number): number {
  if (points.length === 0) return x
  if (points.length === 1) return points[0]!.y
  if (x <= points[0]!.x) return points[0]!.y
  const last = points[points.length - 1]!
  if (x >= last.x) return last.y
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!
    const b = points[i]!
    if (x <= b.x) {
      const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x)
      return a.y + (b.y - a.y) * t
    }
  }
  return last.y
}

export type { BlendMode }
