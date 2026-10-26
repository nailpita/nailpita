// rakuten_candidates.js
// 目的: 楽天で「評価が高く、ヌーディ系の単色ジェルポリッシュ」の候補を探して一覧にする
// ※ products.json は変更しません。結果はGitHub Actionsの画面(Summary)に表示されます。

const fs = require('fs');

const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;

// ===== 条件(ここを変えると探し方が変わります) =====
const KEYWORDS = [
  'ジェルポリッシュ ヌーディ',
  'ポリッシュジェル シアー',
  'ジェルポリッシュ ピンクベージュ',
  'ジェルポリッシュ ミルキー',
];
const MIN_RATING = 4.5;      // 評価の最低ライン
const MIN_REVIEWS = 100;     // レビュー件数の最低ライン
const MAX_COLORS = 20;       // 「全○色」の○がこの数以上のセットは除外
const PAGES_PER_KEYWORD = 2; // 1キーワードあたり何ページ調べるか(1ページ30件)
const SHOW_TOP = 15;         // 一覧に表示する件数
const NG_WORDS = [
  'ラメ', 'グリッター', 'キラキラ', 'アート', 'パーツ', 'ストーン', 'ネオン', '原色',
  'リムーバー', 'トップコート', 'ベースコート', 'LEDライト', 'UVライト', 'ネイルライト',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rakuten_sync.js と同じ送信設定(新API仕様: Origin/Referer とアクセスキーをヘッダーで送る)
const https = require('https');
const SITE_ORIGIN = process.env.RAKUTEN_SITE_ORIGIN || 'https://nailpita.github.io';
const HEADERS = {
  'User-Agent': 'nailpita/1.0',
  Origin: SITE_ORIGIN,
  Referer: SITE_ORIGIN,
  accessKey: ACCESS_KEY,
};
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: HEADERS }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, text: body }));
    }).on('error', reject);
  });
}

async function fetchPage(keyword, page) {
  const url = new URL('https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701');
  url.searchParams.set('applicationId', APP_ID);
  url.searchParams.set('accessKey', ACCESS_KEY);
  url.searchParams.set('affiliateId', AFFILIATE_ID);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page', String(page));
  url.searchParams.set('hits', '30');
  url.searchParams.set('sort', '-reviewCount'); // レビューが多い順
  url.searchParams.set('availability', '1');    // 在庫ありのみ
  url.searchParams.set('format', 'json');

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await httpGet(url.toString());
if (res.status === 429 && attempt === 1) {
console.log('アクセス集中のため少し待って再試行します');
await sleep(3000);
continue;
}
if (res.status < 200 || res.status >= 300) {
throw new Error(`楽天API呼び出し失敗: ${res.status} ${res.text.slice(0, 300)}`);
}
const data = JSON.parse(res.text);
if (data.errors) {
throw new Error(`楽天APIエラー: ${JSON.stringify(data.errors)}`);
}
return (data.Items || []).map(({ Item }) => Item);
  }
  return [];
}

// 商品名から「全120色」のような色数を読み取る(見つからなければ0)
function colorCount(name) {
  const m = name.match(/(\d{1,3})\s*色/);
  return m ? Number(m[1]) : 0;
}

function shorten(text, n) {
  return text.length > n ? text.slice(0, n) + '…' : text;
}

function escapeCell(text) {
  return text.replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
}

async function main() {
  if (!APP_ID || !ACCESS_KEY || !AFFILIATE_ID) {
    console.error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID を設定してください');
    process.exitCode = 1;
    return;
  }

  const all = new Map(); // itemCode -> Item(重複を除く)
  for (const keyword of KEYWORDS) {
    for (let page = 1; page <= PAGES_PER_KEYWORD; page++) {
      console.log(`--- 「${keyword}」 ${page}ページ目を検索中 ---`);
      try {
        const items = await fetchPage(keyword, page);
        items.forEach((it) => all.set(it.itemCode, it));
        if (items.length < 30) break; // 最後のページ
      } catch (err) {
        console.error(`「${keyword}」でエラー:`, err.message);
        process.exitCode = 1;
      }
      await sleep(1100); // 楽天APIは1秒に1回までのため
    }
  }

  const fetched = all.size;
// --- 確認用ログ(原因が分かったら消してOK) ---
const sample = [...all.values()];
if (sample[0]) console.log('項目名一覧:', Object.keys(sample[0]).join(', '));
sample.slice(0, 5).forEach((it, i) => console.log(`確認${i + 1}: 評価=${it.reviewAverage} 件数=${it.reviewCount} 名前=${String(it.itemName).slice(0, 30)}`));

  const step1 = [...all.values()].filter(
    (it) => Number(it.reviewAverage) >= MIN_RATING && Number(it.reviewCount) >= MIN_REVIEWS
  );
  const step2 = step1.filter((it) => !NG_WORDS.some((w) => it.itemName.includes(w)));
  const step3 = step2.filter((it) => colorCount(it.itemName) < MAX_COLORS);
  step3.sort((a, b) => Number(b.reviewCount) - Number(a.reviewCount));
  const top = step3.slice(0, SHOW_TOP);

  console.log(`取得: ${fetched}件 → 評価・件数OK: ${step1.length}件 → NGワード除外後: ${step2.length}件 → 色数OK: ${step3.length}件`);

  const lines = [];
  lines.push('## ジェルポリッシュ 候補商品');
  lines.push('');
  lines.push(`条件: 評価${MIN_RATING}以上 / レビュー${MIN_REVIEWS}件以上 / 色数${MAX_COLORS}色未満 / 在庫あり`);
  lines.push(`絞り込みの流れ: 取得${fetched}件 → 評価・件数OK ${step1.length}件 → NGワード除外後 ${step2.length}件 → 色数OK ${step3.length}件`);
  lines.push('');

  if (top.length === 0) {
    lines.push('**条件に合う商品がありませんでした。** MIN_RATING(評価)やMIN_REVIEWS(件数)を少し下げて、もう一度実行してください。');
  } else {
    lines.push('| 順位 | 商品名 | 価格 | 評価 | 件数 | ショップ |');
    lines.push('|---|---|---|---|---|---|');
    top.forEach((it, i) => {
      lines.push(
        `| ${i + 1} | ${escapeCell(shorten(it.itemName, 60))} | ${Number(it.itemPrice).toLocaleString()}円 | ${it.reviewAverage} | ${it.reviewCount} | ${escapeCell(it.shopName || '')} |`
      );
    });
    lines.push('');
    lines.push('### 商品URL(アフィリエイトリンク)');
    top.forEach((it, i) => {
      lines.push(`${i + 1}. ${it.affiliateUrl || it.itemUrl}`);
    });
  }

  const text = lines.join('\n');
  console.log('\n' + text);

  // GitHub Actionsの「Summary」画面に表示する
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

main();
