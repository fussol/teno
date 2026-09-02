// ═══════════════════════════════════════════════════════════════
// OCR 錄入黑名單 — 預設詞表 + 過濾幫助
//
// 三組預設來源：
//   1. 簡單/功能詞（使用者指定）：is are he she it i + 過於簡單字 cat hot dog
//   2. 草漯國小 109 學年度 英語分級檢定優級 100 詞（109_.pdf）
//   3. 同表基礎/初級級數詞（109_ 另兩張，118/101 詞）
//
// 黑名單持久化於 db settings 'blacklist'（Array<string>），devMode 下可增刪。
// 本檔負責：載入時以預設值為基底 ∪ db 自訂 → 供 importWords 過濾。
// ═══════════════════════════════════════════════════════════════

/** 簡單/功能詞（使用者指定：is are he she it i + cat hot dog 過於簡單） */
export const SIMPLE_WORDS = [
  'i', 'is', 'are', 'he', 'she', 'it',
  'cat', 'hot', 'dog',
];

/** 草漯國小 109 學年度英語分級檢定優級 100 詞（PDF 第一張） */
export const PDF_PUBLIC_100 = [
  'address','alphabet','ambulance','apartment','badminton','blackboard','building',
  'business','careless','cockroach','comfortable','conversation','countryside','dangerous',
  'dictionary','document','doughnut','education','encourage','envelope','excellent',
  'expensive','fantastic','flashlight','foreigner','friendship','government','guess',
  'guest','happen','health','history','holiday','important','information','interview',
  'invite','jealous','ketchup','knife','knowledge','language','learn','lonely','minute',
  'moment','monster','mountain','museum','neighbor','newspaper','noise','ocean','office',
  'outside','plate','pocket','popcorn','question','quickly','rainbow','restaurant',
  'restroom','river','scientist','secret','seed','shape','sour','street','success',
  'surprise','swimsuit','thirsty','throat','traffic','triangle','tummy','umbrella',
  'university','upstairs','vacation','victory','vocabulary','waterfall','wedding',
  'yesterday','youth',
];

/** 109 學年度同表另兩張（基礎/初級級數，PDF 二、三張） */
export const PDF_BASIC = [
  'again','angry','apple','arm','bag','banana','basketball','bathroom','bed','bedroom',
  'beetle','big','bike','bird','birthday','black','blue','book','bored','bread','breakfast',
  'brother','brush','bus','by','cake','can','car','chicken','chocolate','cold','color','comb',
  'cook','cool','cream','cupcake','dance','dining','dinner','do','doctor','draw','egg',
  'eight','eighteen','eleven','eraser','face','farmer','fat','father','fifteen','five',
  'flower','fly','foot','four','fourteen','get','gift','go','grandma','grandpa','grape',
  'green','hair','hamburger','hand','happy','head','hiking','hippo','home','homework',
  'horse','hungry','ice','juice','jump','kitchen','kite','leg','like','lion','listen',
  'living','lunch','marker','math','milk','moon','mother','music','my','name','nine',
  'nineteen','noodles','nurse','one','on','orange','papaya','park','pencil','pink','pizza',
  'play','please','rabbit','rainy','read','recorder','red','ride','room','ruler','run',
  'sad','sandwich','school','scooter','seven','seventeen','shopping','short','sick','sing',
  'singer','sister','six','sixteen','sleep','small','student','study','sunny','surf','swim',
  'tall','taxi','tea','teacher','teeth','ten','that','the','these','thin','thirteen','this',
  'those','three','tiger','time','tired','to','train','try','turtle','twelve','twenty',
  'two','up','want','warm','wash','watch','water','watermelon','who','write','yellow','you',
  'your','yummy','zoo',
];

/** 合併全部預設黑名單詞（小寫去重）。db 自訂由 store 載入時合一。 */
export const DEFAULT_BLACKLIST = Array.from(new Set([
  ...SIMPLE_WORDS,
  ...PDF_PUBLIC_100,
  ...PDF_BASIC,
])).map(w => w.toLowerCase());

/** 資料是否為黑名單 WordCleanliness — 純小寫英文字 */
export function normalizeBlackWord(w) {
  return String(w || '').toLowerCase().trim();
}