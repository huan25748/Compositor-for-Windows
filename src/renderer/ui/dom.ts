/** 极简 DOM 工具与对话层。 */

type Props = Record<string, unknown>

/** 创建元素；`props` 中的 `class`/`text`/`html`/`on*` 有特殊含义。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = String(value)
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'html') node.innerHTML = String(value)
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value as object)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener)
    } else if (key === 'value' && node instanceof HTMLInputElement) node.value = String(value)
    else if (key === 'checked' && node instanceof HTMLInputElement) node.checked = Boolean(value)
    else node.setAttribute(key, String(value))
  }
  for (const child of children) node.append(child)
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

/** 查询元素，找不到就抛错（配置错误应尽早暴露）。 */
export function need<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`缺少界面元素 #${id}`)
  return node as T
}

let toastTimer: number | undefined

/** 短暂提示。 */
export function toast(message: string, ms = 2200): void {
  document.querySelectorAll('.toast').forEach((n) => n.remove())
  const node = el('div', { class: 'toast', text: message })
  document.body.append(node)
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => node.remove(), ms)
}

export interface ModalOptions {
  title: string
  body: (Node | string)[]
  /** 返回 false 可阻止关闭。 */
  onConfirm?: () => boolean | void
  confirmLabel?: string
  cancelLabel?: string
  /** 隐藏取消按钮（仅提示类对话框）。 */
  infoOnly?: boolean
}

/** 打开一个模态框，返回关闭函数。 */
export function modal(opts: ModalOptions): () => void {
  const root = document.getElementById('modalRoot')
  if (!root) return () => undefined
  const previousFocus = document.activeElement as HTMLElement | null

  const close = (): void => {
    root.hidden = true
    clear(root)
    document.removeEventListener('keydown', onKey, true)
    previousFocus?.focus?.()
  }

  const confirm = (): void => {
    if (opts.onConfirm && opts.onConfirm() === false) return
    close()
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.stopPropagation()
      close()
    } else if (ev.key === 'Enter' && !(ev.target instanceof HTMLTextAreaElement)) {
      ev.stopPropagation()
      confirm()
    }
  }

  const actions: (Node | string)[] = []
  if (!opts.infoOnly) {
    actions.push(el('button', { class: 'btn', text: opts.cancelLabel ?? '取消', onClick: close }))
  }
  actions.push(
    el('button', {
      class: 'btn primary',
      text: opts.confirmLabel ?? (opts.infoOnly ? '好' : '确定'),
      onClick: confirm,
    }),
  )

  const box = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
    el('h2', { text: opts.title }),
    el('div', { class: 'modal-body' }, opts.body),
    el('div', { class: 'modal-actions' }, actions),
  ])

  clear(root)
  root.append(box)
  root.hidden = false
  root.onclick = (ev) => {
    if (ev.target === root) close()
  }
  document.addEventListener('keydown', onKey, true)
  const first = box.querySelector<HTMLElement>('input, select, textarea, button.primary')
  first?.focus()
  return close
}

/** 一行带标签的表单控件。 */
export function field(label: string, control: HTMLElement): HTMLElement {
  return el('div', { class: 'field' }, [el('label', { text: label }), control])
}

/** 数字输入。 */
export function numberInput(value: number, opts: { min?: number; max?: number; step?: number } = {}): HTMLInputElement {
  return el('input', {
    type: 'number',
    value: String(value),
    min: opts.min,
    max: opts.max,
    step: opts.step ?? 1,
  })
}

/** #rrggbb -> 0–1 三元组（官方 .comp 里颜色一律是 0–1）。 */
export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const parse = (s: string): number => Math.min(255, Math.max(0, parseInt(s, 16) || 0))
  return [parse(h.slice(0, 2)) / 255, parse(h.slice(2, 4)) / 255, parse(h.slice(4, 6)) / 255]
}

/** 0–1 三元组 -> #rrggbb。 */
export function rgb01ToHex(r: number, g: number, b: number): string {
  const to = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

/** 范围滑块 + 数值显示。 */
export function slider(
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  onCommit: (v: number) => void,
): HTMLElement {
  const display = el('input', { type: 'number', value: String(value), min, max, step, class: 'opacity-input' })
  const range = el('input', { type: 'range', min, max, step, value: String(value) })
  const sync = (v: number): void => {
    range.value = String(v)
    display.value = String(v)
  }
  range.addEventListener('input', () => {
    const v = Number(range.value)
    display.value = String(v)
    onInput(v)
  })
  range.addEventListener('change', () => onCommit(Number(range.value)))
  display.addEventListener('change', () => {
    const v = Number(display.value)
    sync(v)
    onCommit(v)
  })
  return el('div', { class: 'prop-pair' }, [range, display])
}
