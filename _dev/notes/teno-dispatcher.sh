#!/bin/bash
# Teno bug 清空波次 — 限流 dispatcher v4（耐 429）
# 免費 HF 端點硬限制：4 concurrent/IP + 15 req/min/IP。
# 多隻 hermes 同時啟動的 burst 是最大殺手 → SLOTS=2（留給總統 session）＋啟動間隔 5s 錯開。
# 每隻 PM 一旦進入正常回合，request 頻率極低（數十秒一顆），不會超限。
set -u
cd /home/jupiter/teno || exit 9
DIR="/home/jupiter/teno/_dev/notes"
LOGFILE="$DIR/dispatcher.log"
SLOTS=2
declare -A BUGMAP=(
 [1]="C4 C5 C6 C7 C8 C9 C10 G4 G8 G26 A3"
 [2]="E4 E5 E6 E7 E8 D7 D8 D19 D20 E9 E10 E11 E12 E13 E14 E15 E16"
 [3]="D5 F9 F10 F12 D16 D17 F13 F14 F15 F16 F19"
 [4]="F11 D11 D10"
 [5]="F17 F18 G9 F4 F5 F6 G10"
 [6]="D6 F7 G2 G3 G5 G6 G13 G12 G14 G15 G23 G27 G31"
 [7]="G21 G28 D12 D18 G24 G25 G29 G30"
 [8]="D14 D13 D15 G16 G18 G17 G19 G11 H1 G16b H3 G7 G20 G22"
)
# 吸收登記：ID=覆蓋它的 fix commit ID（PM 發現某 ID 已被別案修掉時自行加行，防 done_pm 永假空轉）
declare -A ABSORBED=()
if [ -f "$DIR/absorbed.txt" ]; then while IFS='=' read -r k v; do case "$k" in \#*|"") continue;; esac; ABSORBED["$k"]="$v"; done < "$DIR/absorbed.txt"; fi
done_pm() { local pm="$1" id cov; for id in ${BUGMAP[$pm]}; do cov="${ABSORBED[$id]:-$id}"; git log --oneline | grep -qE "fix: ${cov}([ :]|$)" || return 1; done; return 0; }
all_done() { local i; for i in 1 2 3 4 5 6 7 8; do done_pm $i || return 1; done; return 0; }
live_pms() { ps -ef | grep "hermes-agent/venv/bin/python3" | grep -v grep | while read -r line; do
  echo "$line" | grep -oE "PM[0-9]-MISSION" ; done | sed 's/[^0-9]//g' | sort -u; }
pm_live() { live_pms | grep -qx "$1"; }

echo "=== dispatcher v4 start $(date) SLOTS=$SLOTS ===" >> "$LOGFILE"
launch_pm() { local i="$1"; ( nohup hermes chat -q "你是 Teno 波次首相${i}。先讀 $DIR/PM${i}-MISSION.md 與 $DIR/GOV-BRIEF.md 嚴格照鐵律執行，從佇列第一顆逐一完成(計畫書→審查→動工→驗證→commit→md log)；預算將盡寫檢查點到 $DIR/ 再收尾。剩餘佇列用 git log 反推" >> "$DIR/pm$i.spot.log" 2>&1 & ) ; }

while ! all_done; do
  # 補槽：SLOTS 內補滿，啟動間隔 5s 錯開 burst
  cnt=$(live_pms | wc -l)
  if [ "$cnt" -lt $SLOTS ]; then
    for i in 1 2 3 4 5 6 7 8; do
      done_pm $i && continue
      pm_live $i && continue
      launch_pm $i
      echo "[$(date +%H:%M:%S)] 啟動 PM$i" >> "$LOGFILE"
      cnt=$((cnt+1))
      [ "$cnt" -ge $SLOTS ] && break
      sleep 5   # 錯開啟動，避免同時 burst
    done
  fi
  echo "[$(date +%H:%M:%S)] heartbeat 存續=$cnt" >> "$LOGFILE"
  sleep 45
done
echo "=== dispatcher DONE $(date) — 8 個 PM 全數 commit ===" >> "$LOGFILE"
exit 0