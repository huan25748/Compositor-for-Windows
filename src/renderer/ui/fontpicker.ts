/**
 * 自绘字体选择器。
 *
 * 为什么不用原生 `<select>`：Windows 上它的绘制由系统接管，给 `<select>` 或 `<option>` 设
 * `font-family` 都不生效 —— 设置能"设上去"，但实际不用它画，于是用户看不到「这个字体长什么样」。
 * 这里的按钮与每个列表项都由我们自己渲染，字体一定生效。
 */
import { el } from './dom.ts'
import { fontLabel } from '../text.ts'

/** 一次最多列出多少项（系统字体可能几百个，全画出来会卡）。 */
const MAX_ROWS = 80

/** 构造 font-family 串；末尾保留回退，避免个别字体名解析失败时变成空白。 */
function stackOf(name: string): string {
  return `"${name}", "Microsoft YaHei UI", sans-serif`
}

export interface FontPickerOptions {
  /** 候选字体（真实字体名）。 */
  fonts: string[]
  /** 当前字体名。 */
  value: string
  /** 选中某字体时回调。 */
  onPick: (fontName: string) => void
}

export interface FontPickerHandle {
  /** 根元素，放到选项栏里。 */
  root: HTMLElement
  /** 外部改了字体时刷新显示。 */
  setValue: (fontName: string) => void
  /** 面板是否展开（自检用）。 */
  isOpen: () => boolean
  /** 当前按钮上显示的文字（自检用）。 */
  labelText: () => string
  /** 当前列表里渲染了多少项（自检用）。 */
  rowCount: () => number
}

export function fontPicker(opts: FontPickerOptions): FontPickerHandle {
  let current = opts.value
  const root = el('div', { class: 'font-picker' })
  const button = el('button', { class: 'font-picker-btn', type: 'button' })
  const panel = el('div', { class: 'font-picker-panel', hidden: true })
  const search = el('input', { class: 'font-picker-search', type: 'text', placeholder: '搜索字体…' })
  const list = el('div', { class: 'font-picker-list' })
  panel.append(search, list)
  root.append(button, panel)

  const paintButton = (): void => {
    button.textContent = fontLabel(current)
    button.style.fontFamily = stackOf(current)
  }

  // 面板挂到 body 而不是留在 root 里：选项栏是横向滚动容器（overflow-x: auto），
  // 绝对定位的面板放在里面会被裁掉。代价是要自己用 fixed 定位，见 positionPanel()。
  document.body.append(panel)

  const positionPanel = (): void => {
    const box = button.getBoundingClientRect()
    // 必须在面板显示之后调用，否则 offsetWidth/offsetHeight 都是 0
    const w = panel.offsetWidth || 360
    const h = panel.offsetHeight || 400
    // 水平收边：靠近窗口右缘时向左收，避免超出被裁
    panel.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - w - 8)))}px`
    const below = window.innerHeight - box.bottom
    panel.style.top =
      below < h + 8 && box.top > h + 8
        ? `${Math.round(box.top - h - 4)}px`
        : `${Math.round(box.bottom + 4)}px`
  }

  let rows: HTMLElement[] = []
  const renderList = (filter: string): void => {
    const needle = filter.trim().toLowerCase()
    const matched = opts.fonts.filter(
      (f) => !needle || f.toLowerCase().includes(needle) || fontLabel(f).toLowerCase().includes(needle),
    )
    const shown = matched.slice(0, MAX_ROWS)
    list.replaceChildren()
    rows = shown.map((name) => {
      const row = el('button', {
        class: name === current ? 'font-picker-row current' : 'font-picker-row',
        type: 'button',
        text: fontLabel(name),
      })
      // 每一项都用它自己的字体画，这样才能一眼扫出合适的字体
      row.style.fontFamily = stackOf(name)
      row.addEventListener('click', () => {
        current = name
        paintButton()
        close()
        opts.onPick(name)
      })
      return row
    })
    list.append(...rows)
    if (matched.length > shown.length) {
      list.append(
        el('div', { class: 'font-picker-more', text: `还有 ${matched.length - shown.length} 项，输入关键词缩小范围` }),
      )
    }
  }

  const close = (): void => {
    panel.hidden = true
    root.classList.remove('open')
  }
  const open = (): void => {
    // 先显示再定位：隐藏时量不到尺寸，收边就无从谈起
    panel.hidden = false
    positionPanel()
    root.classList.add('open')
    search.value = ''
    renderList('')
    search.focus()
  }

  button.addEventListener('click', (ev) => {
    ev.stopPropagation()
    if (panel.hidden) open()
    else close()
  })
  // 点面板外面收起。注意面板已挂到 body，所以「内部」要同时判断 root 与 panel。
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (panel.hidden) return
      const target = ev.target
      if (target instanceof Node && (root.contains(target) || panel.contains(target))) return
      close()
    },
    true,
  )
  search.addEventListener('input', () => renderList(search.value))
  search.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      ev.preventDefault()
      close()
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      const first = rows[0]
      if (first) first.click()
      return
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      rows[0]?.focus()
    }
  })
  list.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Escape') {
      close()
      button.focus()
      return
    }
    const active = document.activeElement
    const index = rows.findIndex((r) => r === active)
    if (index < 0) return
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      rows[Math.min(rows.length - 1, index + 1)]?.focus()
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      if (index === 0) search.focus()
      else rows[index - 1]?.focus()
    }
  })

  paintButton()

  return {
    root,
    setValue: (fontName: string): void => {
      current = fontName
      paintButton()
      if (!panel.hidden) renderList(search.value)
    },
    isOpen: () => !panel.hidden,
    labelText: () => button.textContent ?? '',
    rowCount: () => rows.length,
  }
}
