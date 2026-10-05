/**
 * 启动时的整屏起始页。
 *
 * 参照 Morupixel 的做法：启动后先看到它，**新建 / 打开 / 导入**之后才进入工作区。
 * 原先只是一个版本信息对话框，一关就直接掉进空工作区，缺少「从哪开始」的引导。
 */
import { el } from './dom.ts'

export interface WelcomeActions {
  newDocument: () => void
  openProject: () => void
  importImage: () => void
}

/** 把一张卡片做成「图标 + 标题 + 一行说明」。 */
function card(
  icon: string,
  title: string,
  desc: string,
  onClick: () => void,
): HTMLElement {
  const btn = el('button', { class: 'welcome-card', onClick })
  btn.append(
    el('span', { class: 'welcome-card-icon', html: icon }),
    el('span', { class: 'welcome-card-body' }, [
      el('span', { class: 'welcome-card-title', text: title }),
      el('span', { class: 'welcome-card-desc', text: desc }),
    ]),
  )
  return btn
}

const ICON_NEW =
  '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M12 11v6M9 14h6"/></svg>'
const ICON_OPEN =
  '<svg viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v10H3z"/><path d="M3 7V5h6l2 2"/></svg>'
const ICON_IMPORT =
  '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 6"/><circle cx="9" cy="9" r="1.5"/></svg>'

/**
 * 创建起始页。返回的元素需要自己挂到 DOM 上；
 * 任一操作被选中后由调用方调用 `hide()`。
 */
export function createWelcome(
  actions: WelcomeActions,
  info: { version: string; electron: string },
): { root: HTMLElement; hide: () => void } {
  const root = el('div', { class: 'welcome' })
  const inner = el('div', { class: 'welcome-inner' })

  const brand = el('div', { class: 'welcome-brand' })
  brand.append(
    el('div', { class: 'welcome-title', text: 'Compositor' }),
    el('div', { class: 'welcome-sub', text: 'Windows 版图像编辑器' }),
  )

  const cards = el('div', { class: 'welcome-cards' })
  cards.append(
    card(ICON_NEW, '新建项目', '选好画布尺寸，从空白开始', actions.newDocument),
    card(ICON_OPEN, '打开项目', '打开 .comp 项目文件夹', actions.openProject),
    card(ICON_IMPORT, '导入图像', '把图片作为图层带进来', actions.importImage),
  )

  const foot = el('div', { class: 'welcome-foot' })
  foot.append(
    el('div', {
      class: 'welcome-keys',
      text: 'V 移动 · M 矩形选框 · L 套索 · W 魔棒 · B 画笔 · E 橡皮 · I 吸管 · C 裁剪 · H 抓手 · Z 缩放',
    }),
    el('div', {
      class: 'welcome-version',
      text: `v${info.version} · Electron ${info.electron} · 项目格式 .comp 与 Mac 版互通`,
    }),
  )

  inner.append(brand, cards, foot)
  root.append(inner)

  const hide = (): void => {
    root.remove()
  }
  return { root, hide }
}
