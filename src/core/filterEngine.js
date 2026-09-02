// ═══════════════════════════════════════════════════════════════
// Filter Engine — 解析搜尋條件、執行查詢
// ═══════════════════════════════════════════════════════════════

import { getToday, toLocalDateStr } from './scheduler.js';
import { STATE_NEW, STATE_LEARNING, STATE_REVIEW } from './fsrs.js';

/**
 * 解析搜尋條件字串
 * @param {string} query - 搜尋字串，例如 "deck:TOEFL tag:hard is:due"
 * @returns {object} 解析後的條件物件
 */
export function parseSearchQuery(query) {
  const conditions = [];
  const tokens = query.trim().split(/\s+/);
  
  for (const token of tokens) {
    const [key, value] = token.split(':');
    
    if (!value) {
      // 沒有 : 的當作全文搜尋
      conditions.push({ type: 'text', value: key });
      continue;
    }
    
    switch (key.toLowerCase()) {
      case 'deck':
        conditions.push({ type: 'deck', value });
        break;
      case 'tag':
        conditions.push({ type: 'tag', value });
        break;
      case 'is':
        conditions.push({ type: 'state', value });
        break;
      case 'lapses':
        const lapsesMatch = value.match(/^([<>]=?|=)?(\d+)$/);
        if (lapsesMatch) {
          conditions.push({ 
            type: 'lapses', 
            operator: lapsesMatch[1] || '=', 
            value: parseInt(lapsesMatch[2]) 
          });
        }
        break;
      case 'props':
        // props:ivl>30, props:due<7
        const propsMatch = value.match(/^(ivl|due)([<>]=?|=)(\d+)$/);
        if (propsMatch) {
          conditions.push({ 
            type: 'props', 
            prop: propsMatch[1],
            operator: propsMatch[2], 
            value: parseInt(propsMatch[3]) 
          });
        }
        break;
    }
  }
  
  return conditions;
}

/**
 * 執行過濾查詢
 * @param {Array} cards - 所有卡片陣列
 * @param {string} query - 搜尋字串
 * @param {object} options - 選項 { maxCards, orderBy, dayCutoff }
 * @returns {Array} 過濾後的卡片
 */
export function executeFilter(cards, query, options = {}) {
  const { maxCards = 100, orderBy = 'due', dayCutoff = 0, timezoneOffset } = options;
  const conditions = parseSearchQuery(query);
  const today = getToday(dayCutoff, timezoneOffset);
  
  let results = cards.filter(card => {
    for (const cond of conditions) {
      if (!matchCondition(card, cond, today, dayCutoff, timezoneOffset)) {
        return false;
      }
    }
    return true;
  });
  
  // 排序
  results = sortResults(results, orderBy, today);
  
  // 限制數量
  if (maxCards > 0) {
    results = results.slice(0, maxCards);
  }
  
  return results;
}

/**
 * 檢查卡片是否符合單一條件
 */
function matchCondition(card, condition, today, dayCutoff = 0, timezoneOffset) {
  switch (condition.type) {
    case 'text':
      // 全文搜尋（在 word 或 translation 中）
      const searchText = condition.value.toLowerCase();
      return (card.word || '').toLowerCase().includes(searchText) ||
             (card.translation && card.translation.toLowerCase().includes(searchText));
    
    case 'deck':
      return card.deck === condition.value;
    
    case 'tag':
      return card.tags && card.tags.includes(condition.value);
    
    case 'state':
      switch (condition.value.toLowerCase()) {
        case 'new':
          return card.state === STATE_NEW;
        case 'learning':
        case 'learn':
          return card.state === STATE_LEARNING;
        case 'review':
          return card.state === STATE_REVIEW;
        case 'due':
          if (!card.due) return false;
          return toLocalDateStr(new Date(card.due), timezoneOffset, dayCutoff) <= today;
        default:
          return true;
      }
    
    case 'lapses':
      return compareValues(card.lapses || 0, condition.operator, condition.value);
    
    case 'props':
      if (condition.prop === 'ivl') {
        return compareValues(card.interval || 0, condition.operator, condition.value);
      } else if (condition.prop === 'due') {
        if (!card.due) return false;
        const dueDateStr = toLocalDateStr(new Date(card.due), timezoneOffset, dayCutoff);
        const dueParts = dueDateStr.split('-').map(Number);
        const todayParts = today.split('-').map(Number);
        const dueDays = Math.floor((new Date(dueParts[0], dueParts[1] - 1, dueParts[2]) - new Date(todayParts[0], todayParts[1] - 1, todayParts[2])) / 86400000);
        return compareValues(dueDays, condition.operator, condition.value);
      }
      return true;
    
    default:
      return true;
  }
}

/**
 * 比較數值
 */
function compareValues(actual, operator, expected) {
  switch (operator) {
    case '=': return actual === expected;
    case '>': return actual > expected;
    case '>=': return actual >= expected;
    case '<': return actual < expected;
    case '<=': return actual <= expected;
    default: return true;
  }
}

/**
 * 排序結果
 */
function sortResults(results, orderBy, today) {
  const sorted = [...results];
  
  switch (orderBy) {
    case 'due':
      // 按到期日排序，到期的優先，然後是未到期的
      sorted.sort((a, b) => {
        const aDue = a.due ? new Date(a.due).getTime() : Infinity;
        const bDue = b.due ? new Date(b.due).getTime() : Infinity;
        return aDue - bDue;
      });
      break;
    
    case 'random':
      // 隨機排序
      for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
      }
      break;
    
    case 'added':
      // 按加入時間排序（最新的優先）
      sorted.sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });
      break;
    
    case 'interval':
      // 按間隔天數排序（最短的優先）
      sorted.sort((a, b) => (a.interval || 0) - (b.interval || 0));
      break;
    
    case 'lapses':
      // 按遺忘次數排序（最多的優先）
      sorted.sort((a, b) => (b.lapses || 0) - (a.lapses || 0));
      break;
  }
  
  return sorted;
}

/**
 * 取得搜尋條件的提示文字
 */
export function getSearchHints() {
  return [
    { syntax: 'deck:名稱', desc: '指定牌組' },
    { syntax: 'tag:標籤', desc: '指定標籤' },
    { syntax: 'is:due', desc: '到期的卡片' },
    { syntax: 'is:new', desc: '新卡片' },
    { syntax: 'is:review', desc: '複習卡片' },
    { syntax: 'is:learning', desc: '學習中卡片' },
    { syntax: 'lapses:>5', desc: '遺忘次數大於 5' },
    { syntax: 'props:ivl>30', desc: '間隔天數大於 30' },
    { syntax: 'props:due<7', desc: '7 天內到期' },
  ];
}
