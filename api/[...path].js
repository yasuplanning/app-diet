// Vercel Functions のエントリ（catch-all）。/api/* のリクエストをすべてここで受け、
// 既存の handleApi（server.js からエクスポート）に委譲する。
// 静的ファイル（public/）は Vercel が CDN から直接配信するため、ここでは扱わない。
import { handleApi } from '../server.js';

export default async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    await handleApi(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: e.message || 'サーバーエラー' }));
    }
  }
}
