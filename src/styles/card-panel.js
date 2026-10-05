// CARDPANEL：字卡右側面板共用樣式（browser / deck-browser 兩頁共用一份）。
// style id 由呼叫端決定，兩頁各自注入、互不覆蓋。
export function cardPanelCss(id = 'cardStyle') {
  return `<style id="${id}">
  .card-panel{position:fixed;top:0;right:0;width:50vw;height:100vh;background:var(--bg-surface);display:flex;flex-direction:column;z-index:1000;box-shadow:-4px 0 32px rgba(0,0,0,.18);animation:panelIn .2s ease}
  .card-panel.full{width:100vw}
  @media(max-width:600px){.card-panel{width:100vw}.card-panel:not(.full) .card-panel-toggle-full{display:none}}
  @keyframes panelIn{from{transform:translateX(100%)}to{transform:translateX(0)}}
  .card-panel-head{display:flex;align-items:center;justify-content:space-between;padding:var(--s3) var(--s5);border-bottom:1px solid var(--border);flex-shrink:0}
  .card-panel-head-actions{display:flex;gap:4px}
  .card-panel-head-actions button{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:16px;transition:background-color .15s,border-color .15s,color .15s}
  .card-panel-head-actions button:hover{background:var(--state-hover);color:var(--text-primary)}
  .card-panel-body{flex:1;overflow-y:auto;padding:var(--s8) var(--s6);text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:safe center;gap:var(--s4);cursor:pointer;overflow-wrap:break-word;word-break:break-word}
  .card-panel-body .card-hidden{display:none}
  .card-panel-body.revealed .card-hidden{display:flex !important}
  .card-panel-word{font-size:40px;font-weight:800;color:var(--text-primary);letter-spacing:-.5px;line-height:1.2;overflow-wrap:break-word;word-break:break-word;hyphens:auto}
  .card-panel-pron{font-size:18px;color:var(--text-tertiary)}
  .card-panel-def{font-size:22px;color:var(--text-secondary);line-height:1.6}
  .card-panel-example{font-size:14px;color:var(--text-tertiary);font-style:italic;padding:var(--s4) var(--s5);background:var(--bg-base);border-radius:12px;line-height:1.6;text-align:left;width:100%;max-width:420px;box-sizing:border-box}
  .card-panel-desc{font-size:13px;color:var(--text-tertiary);line-height:1.5;text-align:left;width:100%;max-width:420px;box-sizing:border-box;padding:var(--s2) 0}
  .card-panel-tags{display:flex;gap:6px;flex-wrap:wrap;justify-content:center}
  .card-panel-nav{display:flex;align-items:center;justify-content:space-between;padding:var(--s3) var(--s5);border-top:1px solid var(--border);flex-shrink:0}
  .card-panel-nav-btn{width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--bg-surface);color:var(--text-primary);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background-color .15s,border-color .15s,color .15s;flex-shrink:0}
  .card-panel-nav-btn:hover{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}
  .card-ruler{flex:1;height:32px;overflow-x:hidden;position:relative;margin:0 6px;cursor:pointer}
  .card-ruler::-webkit-scrollbar{display:none}
  .ruler-track{position:absolute;top:0;left:0;height:100%;pointer-events:none}
  .ruler-ind{position:absolute;top:4px;width:2px;height:22px;border-radius:2px;background:var(--accent);box-shadow:0 0 6px var(--accent);transition:left .25s cubic-bezier(.4,0,.2,1);pointer-events:none}
  .ruler-base{position:absolute;top:50%;left:0;right:0;height:1px;background:var(--border);transform:translateY(-.5px)}
  .ruler-tick{position:absolute;top:8px;height:10px;display:flex;flex-direction:column;align-items:center;gap:1px}
  .ruler-tick-line{width:1px;height:8px;background:var(--border)}
  .ruler-num{font-size:7px;color:var(--text-quaternary);white-space:nowrap;font-family:var(--mono);font-feature-settings:'tnum';line-height:1}
  .card-popover{display:none;position:absolute;top:calc(100% + 4px);right:0;background:var(--bg-surface);border:1px solid var(--border);border-radius:12px;padding:var(--s4);z-index:1001;width:270px;box-shadow:0 8px 32px rgba(0,0,0,.2)}
  .card-popover.open{display:block}
  .card-popover label{display:flex;align-items:center;justify-content:space-between;font-size:12px;color:var(--text-secondary);padding:4px 0}
  .card-popover label:has(input[type=checkbox]){cursor:pointer}
  .card-popover select{padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg-surface);color:var(--text-primary);font-size:12px;font-family:var(--mono)}
  .card-popover-title{font-size:11px;font-weight:600;color:var(--text-tertiary);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em}
  .card-popover-divider{border:none;border-top:1px solid var(--border);margin:8px 0}
</style>`;
}
