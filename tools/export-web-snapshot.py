#!/usr/bin/env python3
"""WEB-DEMO 真資料快照（2026-09-08）：把本機 teno.db 倒成 public/real-data.json，
vite build 會自動拷進 dist/（dist 會被清空，直寫 dist 會被洗掉）。
public/real-data.json 已進 .gitignore，不進版本庫、不上 GitHub。
跑法：python3 tools/export-web-snapshot.py（build 前跑一次即可）。
demo-data.js seed() 會優先 fetch 此檔，失敗才回退 36 詞種子。"""
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = Path.home() / '.config/com.teno.app/teno.db'
OUT = ROOT / 'public/real-data.json'
REVIEW_LIMIT = 3000
IMG_CAP = 200_000  # 單張圖超過此位元組數就留空（防快照爆炸）


def J(s, default):
    if s is None or s == '':
        return default
    if isinstance(s, (list, dict)):
        return s
    try:
        v = json.loads(s)
        return v if isinstance(v, type(default)) else default
    except (ValueError, TypeError):
        return default


def main():
    if not DB.exists():
        print(f'ERR: no db at {DB}')
        return 1
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    con.row_factory = sqlite3.Row
    cols = {r['name'] for r in con.execute('PRAGMA table_info(words)')}

    words = []
    for r in con.execute('SELECT * FROM words'):
        d = dict(r)
        w = (d['word'] or '').strip()
        definition = d.get('definition') or ''
        pos = d.get('part_of_speech') or ''
        pron = d.get('pronunciation') or ''
        example = d.get('example') or ''
        deck = d.get('deck') or 'Default'
        tags = J(d.get('tags'), [])
        related = J(d.get('related'), [])
        forms = J(d.get('forms'), [])
        synonym = d.get('synonym') or ''
        antonym = d.get('antonym') or ''
        derivative = d.get('derivative') or ''
        examples = J(d.get('examples'), [])
        # ── WEB-DEMO 回填（2026-09-08 使用者裁示：每欄都填上、一樣也可以）──
        # 只動快照、不寫 DB。拿既有資料互填，填完網頁卡片每欄都有東西。
        if not pos:
            pos = '名詞'
        if not pron and w:
            pron = f'/{w.lower()}/'
        if not example and w:
            example = f'{w} — {definition}' if definition else w
        if not tags:
            tags = [deck]
        if not related and w:
            # 同字本抓兩個鄰居當相關詞（去重、去自己）
            related = []
        if not forms and w:
            forms = [w]
        if not synonym and related:
            synonym = ', '.join(related[:3])
        if not synonym and w:
            synonym = w
        if not antonym:
            antonym = '（待補）'
        if not derivative and forms:
            derivative = ', '.join(forms[:3])
        if not derivative and w:
            derivative = w
        if not examples and example:
            examples = [example]
        words.append({
            'id': d['id'], 'word': w, 'definition': definition,
            'pos': pos, 'pron': pron,
            'example': example, 'deck': deck,
            'tags': tags,
            'image': d.get('image') or '' if len(d.get('image') or '') < IMG_CAP else '',
            'description': d.get('description') or definition,
            'related': related, 'forms': forms,
            'synonym': synonym, 'antonym': antonym,
            'derivative': derivative, 'examples': examples,
            # v13 三欄：此機 DB 若還沒跑過 migration 就留空（means: 舊庫相容）
            'etymology': (d.get('etymology') or '') if 'etymology' in cols else '',
            'syllables': (d.get('syllables') or '') if 'syllables' in cols else '',
            'phrases': (d.get('phrases') or '') if 'phrases' in cols else '',
            'createdAt': d.get('created_at') or '',
        })
    # 相關詞空的第二遍：同字本鄰居互填（第一遍時全表還沒齊）
    by_deck = {}
    for x in words:
        by_deck.setdefault(x['deck'], []).append(x['word'])
    for x in words:
        if not x['related']:
            mates = [m for m in by_deck.get(x['deck'], []) if m != x['word']][:3]
            x['related'] = mates if mates else [x['word']]
            if x['synonym'] in ('', x['word']):
                x['synonym'] = ', '.join(x['related'][:3])
    # v13 三欄空的：拿既有欄位互填（字源/音節/片語）
    for x in words:
        if not x['etymology']:
            x['etymology'] = f"{x['word']}（字源待補）"
        if not x['syllables']:
            x['syllables'] = x['word']
        if not x['phrases']:
            x['phrases'] = x['example'] or x['word']

    cards = {}
    for r in con.execute('SELECT * FROM cards'):
        d = dict(r)
        cards[d['word_id']] = {
            'due': d['due'], 'stability': d['stability'], 'difficulty': d['difficulty'],
            'elapsedDays': d['elapsed_days'], 'scheduledDays': d['scheduled_days'],
            'reps': d['reps'], 'lapses': d['lapses'], 'state': d['state'],
            'step': d.get('step') or 0, 'lastReview': d.get('last_review'),
            'buried': bool(d.get('buried')), 'suspended': bool(d.get('suspended')),
            'interval': d.get('scheduled_days') or 0,
            'mcData': J(d.get('mc_data'), None), 'spellData': J(d.get('spell_data'), None),
        }

    decks = [{'id': r['id'], 'name': r['name'], 'color': r['color'] or '#5e6ad2'}
             for r in con.execute('SELECT id, name, color FROM decks')]

    logs = list(con.execute('SELECT * FROM review_log ORDER BY id DESC LIMIT ?', (REVIEW_LIMIT,)))
    logs.reverse()
    reviewLogs = [{
        'id': r['id'], 'wordId': r['word_id'], 'rating': r['rating'],
        'duration': r['duration'], 'elapsedDays': r['elapsed_days'],
        'scheduledDays': r['scheduled_days'], 'stability': r['stability'],
        'difficulty': r['difficulty'], 'reviewed_at': r['reviewed_at'],
        'state': r['card_state'], 'newState': r['new_state'],
        'ivl': r['scheduled_days'], 'mode': r['mode'] or 'flip',
    } for r in map(dict, logs)]

    gs = con.execute('SELECT daily_goal, current, best, dates FROM goal_streak WHERE id=1').fetchone()
    goalStreak = None
    if gs:
        goalStreak = {'dailyGoal': gs[0] or 20, 'current': gs[1] or 0, 'best': gs[2] or 0,
                      'dates': J(gs[3], {'flip': [], 'mc': [], 'spell': []})}

    examHistory = [{'word': r['word'], 'correct': r['correct'],
                    'questionType': r['question_type'], 'examinedAt': r['examined_at']}
                   for r in con.execute('SELECT word, correct, question_type, examined_at FROM exam_history')]

    snap = {'words': words, 'cards': cards, 'decks': decks,
            'reviewLogs': reviewLogs, 'goalStreak': goalStreak, 'examHistory': examHistory}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(snap, ensure_ascii=False), encoding='utf-8')
    print(f'OK: {len(words)} words, {len(cards)} cards, {len(decks)} decks, '
          f'{len(reviewLogs)} logs -> {OUT} ({OUT.stat().st_size // 1024} KB)')
    con.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
