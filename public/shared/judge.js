// 栄養素の不足・過剰判定（サーバー・ブラウザ共用の単一実装）。
//
// public/ 配下に置いてあるのは、ブラウザから素の ES module として import できるようにするため。
// サーバー(server.js)は相対パスで、ブラウザ(app.js)は /shared/judge.js で同じファイルを読む。
// 判定基準を変えるときはこのファイル1箇所だけを直せばよい。

// 目安値の決定。目標設定(goals)があればそれを優先し、無ければ栄養素既定の推奨量(n.ref)。
// 目安が無い栄養素は null。
export function nutrientRef(n, goals = {}) {
  return (n.key === 'calories' && goals.targetCalories) || (n.key === 'protein' && goals.targetProtein)
    || (n.key === 'fiber' && goals.targetFiber) || (n.key === 'salt' && goals.saltLimit) || n.ref || null;
}

// 摂取量 obj（{value, partial}）を目安と比較して判定する。
// 食塩など上限系(n.limit)は「超えたら過剰」、それ以外は 0.5倍未満で不足・1.5倍超で過剰。
// 目安が無い / 摂取値が無い場合は null（＝判定しない）。
export function nutrientJudge(n, obj, goals = {}) {
  const ref = nutrientRef(n, goals);
  if (!obj || !ref) return null;
  const ratio = obj.value / ref;
  if (n.limit || n.key === 'salt') { // 上限系
    return ratio > 1 ? { ref, ratio, status: '過剰', cls: 'status-over' } : { ref, ratio, status: '適正', cls: 'status-ok' };
  }
  if (ratio < 0.5) return { ref, ratio, status: '不足', cls: 'status-low' };
  if (ratio > 1.5) return { ref, ratio, status: '過剰', cls: 'status-over' };
  return { ref, ratio, status: '適正', cls: 'status-ok' };
}
