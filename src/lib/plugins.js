// 插件入口註冊表 —— 題目頁的「隨插隨拔」接縫。
// 新增一個題目入口＝這裡加一筆 + src/pages/<id>.js（main.js 的 PAGE_NAMES／
// SUBPAGE_PARENT 都從這裡展開，不再三處硬編碼）。
export const PLUGINS = [
  {
    id: 'grammar',
    label: '文法翻譯',
    desc: '16 章句型多選與翻譯，LLM 逐題批改',
    icon: 'bookOpen',
    color: 'var(--cyan)',
  },
  {
    id: 'essay',
    label: '作文批改',
    desc: '貼上作文，四項評分與五軸雷達',
    icon: 'edit',
    color: 'var(--orange)',
  },
  {
    id: 'gsat',
    label: '學測題庫',
    desc: '97–115 年學測英文，本地對答案',
    icon: 'scrollText',
    color: 'var(--green)',
  },
];

/** 插件子頁 → 所屬主頁（nav 高亮）；入口集中題目頁（使用者 2026-09-28 指定，與學習／測驗同級）。 */
export const PLUGIN_PARENT = Object.fromEntries(PLUGINS.map(p => [p.id, 'topics']));
