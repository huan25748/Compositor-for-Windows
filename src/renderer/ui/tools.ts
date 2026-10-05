/** 工具定义。 */
import type { IconName } from './icons.ts'

export type ToolID =
  | 'move'
  | 'marquee'
  | 'lasso'
  | 'wand'
  | 'brush'
  | 'eraser'
  | 'eyedropper'
  | 'crop'
  | 'hand'
  | 'zoom'
  | 'text'
  | 'shape'
  | 'clone'
  | 'heal'
  | 'smudge'
  | 'liquify'

export interface ToolDef {
  id: ToolID
  name: string
  icon: IconName
  shortcut: string
  /** 工具选项栏与状态栏显示的操作提示。 */
  hint: string
}

export const TOOLS: ToolDef[] = [
  { id: 'move', name: '移动 / 变换', icon: 'move', shortcut: 'V', hint: '拖动以移动图层' },
  { id: 'marquee', name: '矩形选框', icon: 'marquee', shortcut: 'M', hint: '拖动以建立矩形选区（按住 Shift 为正比）' },
  { id: 'lasso', name: '套索', icon: 'lasso', shortcut: 'L', hint: '按住并拖动以手绘选区' },
  { id: 'wand', name: '魔棒', icon: 'wand', shortcut: 'W', hint: '点击以选择相近颜色区域' },
  { id: 'brush', name: '画笔', icon: 'brush', shortcut: 'B', hint: '拖动以绘制' },
  { id: 'eraser', name: '橡皮擦', icon: 'eraser', shortcut: 'E', hint: '拖动以擦除' },
  { id: 'text', name: '文字', icon: 'text', shortcut: 'T', hint: '点击画布添加文字；双击已有文字图层可再次编辑' },
  { id: 'shape', name: '形状', icon: 'shape', shortcut: 'U', hint: '拖动以绘制形状（保持可再编辑）' },
  { id: 'clone', name: '仿制图章', icon: 'clone', shortcut: 'S', hint: '按住 Alt 点击设置仿制源点，然后拖动复制' },
  { id: 'heal', name: '修复画笔', icon: 'heal', shortcut: 'J', hint: '拖动以修复污点（用周围像素填充）' },
  { id: 'smudge', name: '涂抹', icon: 'smudge', shortcut: 'K', hint: '拖动以推挤像素颜色' },
  { id: 'liquify', name: '液化', icon: 'liquify', shortcut: 'X', hint: '拖动以局部变形' },
  { id: 'eyedropper', name: '吸管', icon: 'eyedropper', shortcut: 'I', hint: '点击以拾取颜色' },
  { id: 'crop', name: '裁剪', icon: 'crop', shortcut: 'C', hint: '拖动以裁剪画布' },
  { id: 'hand', name: '抓手', icon: 'hand', shortcut: 'H', hint: '拖动以平移画布' },
  { id: 'zoom', name: '缩放', icon: 'zoom', shortcut: 'Z', hint: '点击放大，按住 Alt 点击缩小' },
]

export const TOOL_BY_ID = new Map(TOOLS.map((t) => [t.id, t]))

/** 需要「工具选项栏」额外参数的工具。 */
export const BRUSH_TOOLS: ToolID[] = ['brush', 'eraser']
export const SELECT_TOOLS: ToolID[] = ['marquee', 'lasso', 'wand']
