/**
 * ネイルピタ 商品データ連携バッチ(楽天版・2026年新API仕様対応)
 *
 * 必要なもの(GitHub Secretsに設定済み):
 *   1. RAKUTEN_APP_ID       … 楽天ウェブサービスのアプリケーションID
 *   2. RAKUTEN_ACCESS_KEY   … 楽天ウェブサービスのアクセスキー(2026年新仕様で必須)
 *   3. RAKUTEN_AFFILIATE_ID … 楽天アフィリエイトID
 *
 * 必要なライブラリ: npm install sharp undici
 */

const sharp = require('sharp');
const fs = require('fs');
const { request: undiciRequest } = require('undici');

const OUTPUT_PATH = 'products.json';

const APP_ID = process.env.RAKUTEN_APP_ID;
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY;
const AFFILIATE_ID = process.env.RAKUTEN_AFFILIATE_ID;
const SITE_ORIGIN = process.env.RAKUTEN_SITE_ORIGIN || 'https://nailpita.github.io';

const SEARCH_KEYWORDS = [
  { keyword: 'ジェルカラー', category: 'color' },
  { keyword: 'ジェルポリッシュ', category: 'color' },
  { keyword: 'ポリッシュジェル', category: 'color' },
  { keyword: 'ジェルネイル パーツ', category: 'parts' },
  { keyword: 'ネイルストーン', category: 'parts' },
];

// --- ① 楽天商品検索APIから商品を取得(新エンドポイント+アクセスキー対応) ---
// 楽天APIが一時的に不調(503など)のときは、少し待って再試行します
const RETRY_WAITS = [3000, 8000, 15000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRakutenProducts(keyword, page = 1, attempt = 0) {
  const url = new URL('https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701');
  url.searchParams.set('applicationId', APP_ID);
  url.searchParams.set('accessKey', ACCESS_KEY);
  url.searchParams.set('affiliateId', AFFILIATE_ID);
  url.searchParams.set('keyword', keyword);
  url.searchParams.set('page', String(page));
  url.searchParams.set('hits', '30');
  url.searchParams.set('sort', '-updateTimestamp');
  url.searchParams.set('format', 'json');

  let statusCode, rawText;
  try {
    const res = await undiciRequest(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'nailpita/1.0',
        Origin: SITE_ORIGIN,
        Referer: SITE_ORIGIN,
        accessKey: ACCESS_KEY,
      },
    });
    statusCode = res.statusCode;
    rawText = await res.body.text();
  } catch (err) {
    // 通信自体が失敗した(タイムアウトなど)
    if (attempt < RETRY_WAITS.length) {
      console.log(`  通信エラー(${err.message})。${RETRY_WAITS[attempt] / 1000}秒待って再試行します`);
      await sleep(RETRY_WAITS[attempt]);
      return fetchRakutenProducts(keyword, page, attempt + 1);
    }
    throw err;
  }

  // 429(アクセス集中)と5xx(楽天側の一時的な不調)は再試行する
  if ((statusCode === 429 || statusCode >= 500) && attempt < RETRY_WAITS.length) {
    console.log(`  楽天APIが一時的に応答できません(HTTP ${statusCode})。${RETRY_WAITS[attempt] / 1000}秒待って再試行します`);
    await sleep(RETRY_WAITS[attempt]);
    return fetchRakutenProducts(keyword, page, attempt + 1);
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`JSONとして解析できない応答(HTTP ${statusCode}): ${rawText.slice(0, 200)}`);
  }

  if (statusCode < 200 || statusCode >= 300) {
    const msg = data.errorMessage || (data.errors && JSON.stringify(data.errors)) || rawText.slice(0, 200);
    throw new Error(`楽天APIエラー(HTTP ${statusCode}): ${msg}`);
  }

  return (data.Items || []).map(({ Item }) => ({
    productId: Item.itemCode,
    name: Item.itemName,
    price: Item.itemPrice,
    imageUrl: (Item.mediumImageUrls?.[0]?.imageUrl || '').replace('?_ex=128x128', ''),
    affiliateUrl: Item.affiliateUrl || Item.itemUrl,
    aspSource: '楽天',
  }));
}

async function extractDominantColor(imageUrl) {
  const res = await fetch(imageUrl);
  const buffer = Buffer.from(await res.arrayBuffer());
  const { data, info } = await sharp(buffer)
    .resize(60, 60, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0, g = 0, b = 0;
  const pixelCount = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i]; g += data[i + 1]; b += data[i + 2];
  }
  r = Math.round(r / pixelCount); g = Math.round(g / pixelCount); b = Math.round(b / pixelCount);
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function assignSceneTags(name) {
  const tags = [];
  if (/シンプル|オフィス|ワンカラー/.test(name)) tags.push('オフィス・シンプル');
  if (/パール|ストーン|ロング|ラグジュアリー/.test(name)) tags.push('ロングネイル・ラグジュアリー');
  if (/クリスマス|桜|ハロウィン|春|夏|秋|冬/.test(name)) tags.push('シーン季節のネイルアート');
  return tags;
}

function loadExistingProducts() {
  if (fs.existsSync(OUTPUT_PATH)) {
    try { return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8')); } catch { return []; }
  }
  return [];
}

function saveProducts(products) {
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(products, null, 2));
}

async function runBatch() {
  if (!APP_ID || !ACCESS_KEY || !AFFILIATE_ID) {
    console.error('RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID を環境変数に設定してください');
    process.exitCode = 1;
    return;
  }

  const existing = loadExistingProducts();
  let okCount = 0;
  let errorCount = 0;
  const productMap = new Map(existing.map((p) => [p.productId, p]));

  for (const { keyword, category } of SEARCH_KEYWORDS) {
    console.log(`--- 「${keyword}」を検索中 ---`);
    try {
      const items = await fetchRakutenProducts(keyword);
      okCount++;
      for (const item of items) {
        try {
          const hexColor = item.imageUrl ? await extractDominantColor(item.imageUrl) : null;
          const sceneTags = assignSceneTags(item.name);
          productMap.set(item.productId, {
            ...item, hexColor, sceneTags,
            sourceKeyword: keyword, category,
            updatedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(`商品処理エラー(${item.name}):`, err.message);
        }
      }
    } catch (err) {
      console.error(`「${keyword}」の検索でエラー:`, err.message);
      errorCount++;
    }
    await sleep(1000);
  }

  if (okCount === 0) {
    // すべてのキーワードが失敗(APIキーの期限切れなど)。products.json は書き換えずに失敗として通知する
    console.error('::error::楽天APIから1件も取得できませんでした。APIキーや楽天側の状況を確認してください');
    process.exitCode = 1;
    return;
  }
  if (errorCount > 0) {
    // 一部だけ取れなかった場合は警告のみ(取れなかったキーワードの商品は前回のデータが残ります)
    console.log(`::warning::${errorCount}件のキーワードが取得できなかったため、その分は前回の商品データを残しました`);
  }

  const merged = Array.from(productMap.values());
  saveProducts(merged);
  console.log(`完了: ${merged.length}件の商品データを ${OUTPUT_PATH} に保存しました`);
}

runBatch();
