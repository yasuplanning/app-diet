// Vercel Functions のエントリ（catch-all）。/api/* をすべてここで受け、
// server.js の handleApi に委譲する。
//
// 重要: トップレベル import を置かず、handler 内の動的 import を try/catch で包む。
// こうすると server.js 系の読み込みで例外が出ても FUNCTION_INVOCATION_FAILED で
// 潰れず、原因の分かる 500 JSON（スタックトレース）を返せる。
// 静的ファイル（public/）は Vercel が CDN から直接配信するため、ここでは扱わない。
export default async function handler(req, res) {
  try {
    const { handleApi } = await import('../server.js');
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    await handleApi(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: String(e && e.stack ? e.stack : e) }));
    }
  }
}
