/** 工具栏与面板用的内联 SVG 图标（stroke 由 CSS 控制）。 */
const wrap = (body: string): string =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`

export const ICONS = {
  move: wrap('<path d="M12 3v18M3 12h18"/><path d="M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  marquee: wrap('<rect x="3" y="4" width="18" height="16" rx="1" stroke-dasharray="4 3"/>'),
  lasso: wrap('<path d="M4 12a8 6 0 1 1 16 0c0 3-3 5-8 5"/>'),
  wand: wrap('<path d="M4 20l10-10"/><path d="M14 6l4 4"/><path d="M18 3l1 3 3 1-3 1-1 3-1-3-3-1 3-1z"/>'),
  brush: wrap('<path d="M15 4l5 5-8 8-5-5z"/><path d="M7 12l-3 7 7-3"/>'),
  eraser: wrap('<path d="M4 15l7-7 6 6-4 4H7z"/><path d="M4 20h16"/>'),
  eyedropper: wrap('<path d="M15 4l5 5-9 9-4 1 1-4z"/><path d="M13 6l5 5"/>'),
  crop: wrap('<path d="M6 2v16h16"/><path d="M2 6h16v16"/>'),
  hand: wrap('<path d="M8 13V5a1.5 1.5 0 0 1 3 0v6"/><path d="M11 11V4a1.5 1.5 0 0 1 3 0v7"/><path d="M14 11V6a1.5 1.5 0 0 1 3 0v8a6 6 0 0 1-6 6H9a5 5 0 0 1-4-2l-3-4a1.5 1.5 0 0 1 2.4-1.8L7 15"/>'),
  zoom: wrap('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  text: wrap('<path d="M5 5h14"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
  // 图层效果：一个图层方块 + 右上角的闪光，表示「给这个图层加效果」。
  // 与 adjust（调整图层）区分开，不再共用同一个图标。
  effects: wrap('<rect x="3" y="6" width="12" height="12" rx="1"/><path d="M18.5 2.5l1.1 2.6 2.6 1.1-2.6 1.1-1.1 2.6-1.1-2.6-2.6-1.1 2.6-1.1z"/>'),
  shape: wrap('<rect x="3" y="3" width="9" height="9" rx="2"/><circle cx="16.5" cy="16.5" r="4.5"/>'),
  clone: wrap('<path d="M7 4h10v4H7z"/><path d="M5 8h14l-1.5 12h-11z"/>'),
  heal: wrap('<path d="M12 3l9 9-9 9-9-9z"/><path d="M12 9v6M9 12h6"/>'),
  smudge: wrap('<path d="M4 18c5 0 7-4 7-8s3-6 9-6"/><circle cx="5" cy="18" r="1.6"/>'),
  liquify: wrap('<circle cx="12" cy="12" r="8"/><path d="M6 12c2-4 4-4 6 0s4 4 6 0"/>'),

  eye: wrap('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="2.5"/>'),
  eyeOff: wrap('<path d="M3 3l18 18"/><path d="M6.5 7C4 8.6 2 12 2 12s3.5 6 10 6c1.8 0 3.4-.5 4.7-1.2"/><path d="M9.9 6.3A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6s-1 1.8-3 3.4"/>'),
  mask: wrap('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="5" fill="currentColor"/>'),
  clip: wrap('<path d="M9 4v10a3 3 0 0 0 6 0V6"/><path d="M12 4v10"/>'),
  adjust: wrap('<path d="M4 8h10M18 8h2M4 16h4M12 16h8"/><circle cx="16" cy="8" r="2"/><circle cx="10" cy="16" r="2"/>'),
  group: wrap('<path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  image: wrap('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M4 18l5-5 4 4 3-3 4 4"/>'),

  plus: wrap('<path d="M12 5v14M5 12h14"/>'),
  trash: wrap('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>'),
  copy: wrap('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>'),
  folder: wrap('<path d="M3 7a2 2 0 0 1 2-2h3l2 2h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  masks: wrap('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor"/>'),
  up: wrap('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>'),
  down: wrap('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>'),
} as const

export type IconName = keyof typeof ICONS
