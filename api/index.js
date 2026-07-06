// Vercel Functions のエントリ。vercel.json の rewrite で /api/* をすべてここへ流す。
// 元のパスは rewrite で `apipath` クエリとして渡し、確実に復元する
// （rewrite 後の req.url が元パスか宛先パスかは環境差があるため、クエリ経由が最も確実）。
//
// 重要: トップレベル import を置かず、handler 内の動的 import を try/catch で包む。
// server.js 系の読み込みで例外が出ても FUNCTION_INVOCATION_FAILED で潰れず、
// 原因の分かる 500 JSON（スタックトレース）を返せる。
export default async function handler(req, res) {
  try {
    const { handleApi } = await import('../server.js');
    const base = `http://${req.headers.host || 'localhost'}`;
    const orig = new URL(req.url, base);

    let pathname = orig.pathname;
    const apipath = orig.searchParams.get('apipath');
    if (apipath !== null) {
      orig.searchParams.delete('apipath');
      pathname = '/api/' + apipath;
    }
    const url = new URL(pathname + (orig.search || ''), base);

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
