// ═══════════════════════════════════════════════════════════════
// PaddleOCR Adapter 佔位（P2，計畫 v1.3 §6.6 Adapter B）
// ONNX Runtime Web 轉譯 PP-OCR 官方導出模型路線，P2 spike 通過前
// available() 恆 false → engine.js 自動回退 tesseract（UI 選得過、
// 辨識不會炸）。禁止在本檔接任何未過 spike 的模型。
// ═══════════════════════════════════════════════════════════════

async function available() {
  return false; // P2 spike 未立項
}

async function recognize() {
  throw new Error('PaddleOCR 引擎尚未啟用（P2 開發中），請改用 Tesseract');
}

export default { id: 'paddle', available, recognize };
