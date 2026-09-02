#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Teno 翻卡學習 50 天自動模擬
# 每天: 生成 card/rate 命令 → 逐條執行 → log 存桌面/log → 換日
# 用法: bash run-50days.sh [days] [start-date]
# ═══════════════════════════════════════════════════════════════
set -u
cd "$(cd "$(dirname "$0")" && pwd)"

DAYS=${1:-50}
START=${2:-2026-08-03}
DB=/tmp/teno-sim.db
LOGDIR="${HOME}/桌面/log"
mkdir -p "$LOGDIR"

# 測試/模擬: 跳過 rate 每次備份 (避免數百個 .bak 檔 + 損壞)
export TENO_NO_BACKUP=1

# 起始 DB (複製真實 DB)
cp "${HOME}/.config/com.teno.app/teno.db" "$DB"
rm -f "$DB".bak-*

echo "════════ Teno 翻卡學習 ${DAYS} 天自動模擬 ════════"
echo "起始日期: $START | DB: $DB | log: $LOGDIR"
echo ""

for ((d=0; d<DAYS; d++)); do
  DATE=$(date -u -d "$START + $d days" +%Y-%m-%d)
  LOG="$LOGDIR/day-$((d+1))-$DATE.log"

  echo "────────── Day $((d+1)) [$DATE] ──────────"
  echo "> 生成今日命令..."

  # 生成今日命令 (到期卡 + 新卡), 依使用者真實評分比例
  cat > /tmp/gen-day.mjs <<EOF
import { DatabaseSync } from 'node:sqlite';
let rng = mulberry32(1);
function mulberry32(seed) { return function(){ seed|=0; seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
// 使用者真實比例 (from review_log): Again 37.4% Hard 4.7% Good 57.5% Easy 0.5%
const USER_DIST = [0.374, 0.047, 0.575, 0.005];
function pick() { const r=rng(); let acc=0; for(let i=0;i<4;i++){ acc+=USER_DIST[i]; if(r<acc) return i; } return 2; }
const db = new DatabaseSync('$DB', { readOnly: true });
const dueCards = db.prepare(\`SELECT word_id FROM cards WHERE state > 0 AND due IS NOT NULL AND due < ? ORDER BY due\`).all('$DATE' + 'T23:59:59Z');
const newCards = db.prepare(\`SELECT w.id FROM words w LEFT JOIN cards c ON w.id=c.word_id WHERE c.word_id IS NULL LIMIT ?\`).all(80);
let out = '#!/bin/bash\n# Day $((d+1)) [$DATE] 翻卡學習\nexport TENO_DB=$DB\n';
for (const c of dueCards) out += \`node cli.mjs card \${c.word_id}\nnode cli.mjs rate \${c.word_id} \${pick()} --date $DATE\n\n\`;
for (const w of newCards) out += \`node cli.mjs card \${w.id}\nnode cli.mjs rate \${w.id} \${pick()} --date $DATE\n\n\`;
import('node:fs').then(fs => fs.writeFileSync('$LOGDIR/day-$((d+1))-cmd.sh', out));
console.log(dueCards.length + ' 到期卡 + ' + newCards.length + ' 新卡');
EOF
  GEN=$(node /tmp/gen-day.mjs 2>&1)
  echo "> 今日命令: $GEN"

  # 用 timebox 執行, 每天獨立 monitor log
  echo "> 執行中..."
  LOG="$LOGDIR/day-$((d+1)).log"
  echo "[day] Day $((d+1)) [$DATE] 翻卡學習" > "$LOG"
  node cli.mjs timebox --days 1 --date "$DATE" --speed 10 --preset user --seed 1 --save "$DB" 2>&1 | grep -E "\[(build|next|store.rate|fsrs|requeue|rate)\]" >> "$LOG"
  CNT=$(grep -c "\[store.rate\]" "$LOG")
  echo "> 完成: $CNT 條 [store.rate] → $LOG"

  # 驗證 DB
  CARDS=$(sqlite3 "$DB" "SELECT count(*) FROM cards")
  echo "> DB 卡片數: $CARDS"
  echo ""
done

echo "════════ 全部完成 ════════"
echo "log 在: $LOGDIR/day-*.log"
