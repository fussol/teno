# SR-C4 修法計畫書 v1.0（總統直修，scope-request 裁示案）

## Bug 定義 / 裁示背景
PM1 修 C4 時登 scope-requests `C4-SR1`：`tools/cli.mjs:134 makeSession` 用 `new Session({...s, fsrs: new FSRS(), ...ANKI})` — **FSRS 用預設權重/cap**，與 app store.rateCard（讀 ankiSettings）及 cmdAudit replay（讀 fsrsWeights）**權重漂移** → 跑 CLI rate/sim/study 排程值與 replay 不一致（重現 E5 假 mismatch 模式）。

## Root Cause
E4/E5 已建 `fsrsCtx(mode)` 共享構造器並讓 cmdRate/cmdSim/cmdStudy/cmdWhatif 走它（:1240/1314/1669/3308），但 **makeSession 是漏網** — 三呼叫端（:1311/:1378/:1440）都交給 makeSession 的預設 new FSRS()。

## 裁示判斷（實錘）
- **C4-SR1 成立**：makeSession 漏網真凶，需改走 fsrsCtx。
- **E5-SR1 部分不成立**：cmdSelfTest:2238 的 `new FSRS(null,0.9,false,365)` 是**selftest 固定參數單元測試**（非 bug，不該改）;:2545 cmdSimulate 已從 anki 讀權重/maxIvl（語意已對齊 fsrsCtx，內嵌非共享 helper 屬風格非 bug）→ 登為「已涵蓋/測試本體」。

## 修法
`tools/cli.mjs:134 makeSession`：
```js
function makeSession(s) {
  const _ctx = fsrsCtx(s.mode || 'flip');
  return new Session({ ...s, fsrs: _ctx.fsrs, ...ANKI, learnSteps: _ctx.learnSteps, relearnSteps: _ctx.relearnSteps });
}
```
關鍵：以下順序正確度 — `fsrs` 用 _ctx 版（非 new FSRS() 預設）、`learnSteps/relearnSteps` 用 _ctx 的 parseStepsStr 版（**置於 ANKI 之後**，否則 ANKI 的字串 '1,10' 會覆蓋 parse 版）。

## 驗證
tools/verify-src4-makesession.mjs：
- T1 makeSession 不用 new FSRS() 預設權重
- T2 呼叫 fsrsCtx(s.mode)
- T3 用 _ctx.fsrs
- T4 learnSteps 覆蓋 ANKI（順序對）
- T5 fsrsCtx 為 hoisted function 宣告（makeSession 前可用）
- T6 保留 ...s（含 mode）
- T7 含統一註解標記
（已實測 7/7 ALL PASS + node --check + vite build + E4/E5 回歸 24/24 18/18 + cli rate 正常）

## 風險
- 極低：makeSession 三呼叫端行為權重不再漂移；E4/E5 harness 全過證明不破壞既有修復。

## 範圍外
- cmdSelfTest fixed FSRS（測試本體，不動）
- cmdSimulate 內嵌構造（語意已對齊，風格非 bug）
- C6-SR2、C7-SR1（另裁）