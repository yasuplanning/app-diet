// ===== 栄養管理アプリ フロントエンド (vanilla JS SPA) =====

// ---------- API ----------
const api = {
  async req(method, path, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `エラー ${res.status}`);
    return data;
  },
  get: (p) => api.req('GET', p),
  post: (p, b) => api.req('POST', p, b),
  put: (p, b) => api.req('PUT', p, b),
  del: (p) => api.req('DELETE', p),
};

// ---------- state ----------
let META = null; // { nutrients, mealTypes, today }
const app = document.getElementById('app');

// ---------- utils ----------
const $ = (sel, el = document) => el.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v, d = 1) { if (v === null || v === undefined || v === '') return '—'; const n = Number(v); return Number.isInteger(n) ? String(n) : n.toFixed(d); }
function todayStr() { return META.today; }
function addDays(dateStr, n) { const [y, m, d] = dateStr.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); }

function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2200);
}

function openModal(node) {
  const root = document.getElementById('modal-root');
  const bg = el('<div class="modal-bg"></div>');
  bg.appendChild(node);
  bg.addEventListener('click', (e) => { if (e.target === bg) closeModal(); });
  root.innerHTML = ''; root.appendChild(bg);
}
function closeModal() { document.getElementById('modal-root').innerHTML = ''; }

// 栄養素値の表示（partial=一部データ未登録）
function nutrientCell(obj) {
  if (!obj) return '—';
  const v = num(obj.value, 1);
  return obj.partial ? `${v} <span class="pill partial" title="一部の食材で栄養データが未登録です">一部未登録</span>` : v;
}

// 全栄養素テーブル
function nutrientTable(total) {
  const rows = META.nutrients.map((n) => {
    const o = total[n.key];
    return `<tr><td>${n.label}</td><td class="num">${nutrientCell(o)}</td><td class="muted small">${n.unit}</td></tr>`;
  }).join('');
  return `<div class="table-wrap"><table><thead><tr><th>栄養素</th><th class="num">摂取量</th><th>単位</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- router ----------
const routes = {
  '/dashboard': viewDashboard,
  '/input': viewInput,
  '/records': viewRecords,
  '/history': viewHistory,
  '/foods': viewFoods,
  '/supplements': viewSupplements,
  '/unregistered': viewUnregistered,
  '/weekly': viewWeekly,
  '/monthly': viewMonthly,
  '/goals': viewGoals,
};

async function router() {
  const hash = location.hash.replace(/^#/, '') || '/dashboard';
  const path = hash.split('?')[0];
  document.querySelectorAll('.nav a').forEach((a) => {
    a.classList.toggle('active', a.getAttribute('href') === '#' + path);
  });
  const view = routes[path] || viewDashboard;
  app.innerHTML = '<div class="empty">読み込み中…</div>';
  try { await view(new URLSearchParams(hash.split('?')[1] || '')); }
  catch (e) { app.innerHTML = `<div class="card"><p class="status-over">読み込みエラー: ${esc(e.message)}</p></div>`; }
}

// ======================================================
// ダッシュボード
// ======================================================
async function viewDashboard() {
  const date = todayStr();
  const d = await api.get(`/api/dashboard?date=${date}`);
  const g = d.goals || {};
  const t = d.today.total;

  const statCard = (label, obj, unit, goal) => {
    const val = obj.value;
    let barHtml = '';
    if (goal) {
      const pct = Math.min(100, Math.round((val / goal) * 100));
      const over = val > goal;
      barHtml = `<div class="bar ${over ? 'over' : ''}"><span style="width:${pct}%"></span></div>
        <div class="sub muted">目標 ${goal}${unit} の ${Math.round((val / goal) * 100)}%</div>`;
    }
    return `<div class="stat"><div class="label">${label}</div>
      <div class="value">${num(val, 0)} <small>${unit}</small></div>
      ${obj.partial ? '<div class="sub"><span class="pill partial">一部未登録</span></div>' : ''}
      ${barHtml}</div>`;
  };

  // 7日カロリー/タンパク質
  const weekChart = (key, cls) => {
    const max = Math.max(1, ...d.week.days.map((x) => x.total[key].value));
    return `<div class="chart">${d.week.days.map((x) => {
      const v = x.total[key].value;
      const h = Math.round((v / max) * 100);
      return `<div class="col"><div class="amt">${v ? num(v, 0) : ''}</div><div class="fill ${cls}" style="height:${h}%"></div><div class="cap">${x.date.slice(5)}</div></div>`;
    }).join('')}</div>`;
  };

  // 不足・過剰チェック
  const check = META.nutrients.map((n) => {
    const o = t[n.key]; if (!o) return '';
    const ref = (n.key === 'calories' && g.targetCalories) || (n.key === 'protein' && g.targetProtein)
      || (n.key === 'fiber' && g.targetFiber) || (n.key === 'salt' && g.saltLimit) || n.ref;
    if (!ref) return '';
    const ratio = o.value / ref;
    let status = '', cls = 'status-ok';
    if (n.limit || n.key === 'salt') { // 上限系
      if (ratio > 1) { status = '過剰'; cls = 'status-over'; } else { status = '適正'; cls = 'status-ok'; }
    } else {
      if (ratio < 0.5) { status = '不足'; cls = 'status-low'; }
      else if (ratio > 1.5) { status = '過剰'; cls = 'status-over'; }
      else { status = '適正'; cls = 'status-ok'; }
    }
    return `<tr><td>${n.label}</td><td class="num">${nutrientCell(o)}</td><td class="num muted">${ref}${n.unit}</td><td class="${cls}">${status}</td></tr>`;
  }).join('');

  const freq = d.foodFrequency.length
    ? d.foodFrequency.map((f) => `<tr><td>${esc(f.foodName)}</td><td class="num">${f.count}回</td><td class="num muted">${num(f.totalGrams, 0)}g</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">記録なし</td></tr>';

  // 消費カロリーとカロリー収支
  const burn = d.energy && d.energy.burnedCalories != null ? d.energy.burnedCalories : null;
  const intake = t.calories.value;
  const netVal = burn != null ? intake - burn : null;
  const netCard = `
    <div class="stat"><div class="label">今日の消費カロリー</div>
      <div class="value">${burn != null ? num(burn, 0) : '—'} <small>kcal</small></div>
      <div class="sub muted">${burn != null ? 'スマートウォッチ等の記録' : '未入力（食事入力画面で登録）'}</div></div>
    <div class="stat"><div class="label">カロリー収支（摂取 − 消費）</div>
      <div class="value ${netVal != null ? (netVal > 0 ? 'status-over' : 'status-ok') : ''}">${netVal != null ? (netVal > 0 ? '+' : '') + num(netVal, 0) : '—'} <small>kcal</small></div>
      <div class="sub muted">${netVal != null ? (netVal > 0 ? '摂取オーバー' : '消費が上回る') : '消費カロリー未入力'}</div></div>`;

  // 最新の体組成
  const lb = d.latestBody;
  const bodyCard = lb ? `
    <div class="card"><h2>最新の体組成 <span class="muted small">(${lb.date})</span></h2>
      <div class="grid grid-4">
        <div class="stat"><div class="label">体重</div><div class="value">${num(lb.weight)} <small>kg</small></div></div>
        <div class="stat"><div class="label">体脂肪率</div><div class="value">${num(lb.bodyFat)} <small>%</small></div></div>
        <div class="stat"><div class="label">内臓脂肪</div><div class="value">${num(lb.visceralFat)}</div></div>
        <div class="stat"><div class="label">目標体重</div><div class="value">${num(g.weightGoal)} <small>kg</small></div></div>
      </div>
    </div>` : '';

  app.innerHTML = `
    <h1>ホーム / ダッシュボード <span class="muted small">(${date})</span></h1>
    <div class="grid grid-4">
      ${statCard('今日のカロリー', t.calories, 'kcal', g.targetCalories)}
      ${statCard('タンパク質', t.protein, 'g', g.targetProtein)}
      ${statCard('食物繊維', t.fiber, 'g', g.targetFiber)}
      ${statCard('食塩相当量', t.salt, 'g', g.saltLimit)}
    </div>

    <div class="grid grid-2">${netCard}</div>

    ${bodyCard}

    <div class="grid grid-2">
      <div class="card"><h2>直近7日間のカロリー推移</h2>${weekChart('calories', '')}</div>
      <div class="card"><h2>直近7日間のタンパク質推移</h2>${weekChart('protein', 'alt')}</div>
    </div>

    <div class="grid grid-2">
      <div class="stat"><div class="label">直近30日 平均カロリー</div><div class="value">${num(d.month.average.calories.value, 0)} <small>kcal/日</small></div><div class="sub muted">記録 ${d.month.recordedDays} 日</div></div>
      <div class="stat"><div class="label">直近30日 平均タンパク質</div><div class="value">${num(d.month.average.protein.value, 0)} <small>g/日</small></div><div class="sub muted">記録 ${d.month.recordedDays} 日</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card"><h2>栄養素の不足・過剰チェック</h2>
        <div class="table-wrap"><table><thead><tr><th>栄養素</th><th class="num">今日</th><th class="num">目安</th><th>判定</th></tr></thead><tbody>${check}</tbody></table></div>
        <p class="small muted">目安は目標設定値または一般的な推奨量。食塩は上限。</p>
      </div>
      <div class="card"><h2>食材別 摂取頻度 (直近30日)</h2>
        <div class="table-wrap"><table><thead><tr><th>食材</th><th class="num">回数</th><th class="num">合計</th></tr></thead><tbody>${freq}</tbody></table></div>
      </div>
    </div>

    <div class="card"><h2>今日の主要栄養素一覧</h2>${nutrientTable(t)}</div>
  `;
}

// ======================================================
// 食事入力
// ======================================================
async function viewInput(params) {
  const date = params.get('date') || todayStr();
  const nowTime = new Date().toTimeString().slice(0, 5); // 現在時刻 HH:MM
  const [frequent, supplements] = await Promise.all([
    api.get('/api/foods/frequent'),
    api.get('/api/supplements'),
  ]);

  app.innerHTML = `
    <h1>食事入力</h1>
    <div class="card">
      <div class="flex-between">
        <div class="row" style="flex:2">
          <div><label>日付</label><input type="date" id="f-date" value="${date}"></div>
          <div><label>時刻</label><input type="time" id="f-time" value="${nowTime}"></div>
          <div><label>食事区分</label><select id="f-type">${META.mealTypes.map((m) => `<option>${m}</option>`).join('')}</select></div>
        </div>
      </div>

      ${frequent.length ? `<label>よく食べる食材（クイック入力・タップでグラム数だけ変更して再入力）</label>
      <div class="chips" id="quick">
        ${frequent.map((f) => `<span class="chip" data-name="${esc(f.foodName)}" data-id="${f.foodId ?? ''}" data-grams="${f.grams}">${esc(f.foodName)} <span class="muted small">${num(f.grams, 0)}g</span></span>`).join('')}
      </div>` : ''}

      <label>サプリ（個数を入れてタップで記録。1個 = 登録した含有量がそのまま摂取に加算されます）</label>
      ${supplements.length ? `
      <div class="row" style="align-items:flex-end;margin-bottom:6px">
        <div><label class="small muted">個数</label><input type="number" id="supp-units" value="1" min="0" step="1" style="max-width:90px"></div>
      </div>
      <div class="chips" id="supp-quick">
        ${supplements.map((s) => `<span class="chip supp" data-suppid="${s.id}" data-name="${esc(s.name)}">💊 ${esc(s.name)}${s.brand ? ` <span class="muted small">${esc(s.brand)}</span>` : ''}</span>`).join('')}
      </div>` : '<p class="small muted">登録済みのサプリはありません。<a href="#/supplements">サプリ管理</a>から追加してください。</p>'}

      <div class="row" style="margin-top:12px">
        <div class="suggest-wrap" style="flex:2">
          <label>食材名</label>
          <input type="text" id="f-food" placeholder="食材名を入力（候補が出ます）" autocomplete="off">
          <input type="hidden" id="f-foodid">
          <div class="suggest" id="suggest" style="display:none"></div>
        </div>
        <div><label>グラム数 (g)</label><input type="number" id="f-grams" min="0" step="1" placeholder="150"></div>
      </div>
      <label>メモ</label>
      <input type="text" id="f-memo" placeholder="任意">
      <div class="row" style="margin-top:12px">
        <button id="btn-add">記録する</button>
        <button class="ghost" id="btn-copy">前日の食事をこの日にコピー</button>
      </div>
    </div>

    <div class="card" id="today-meals"></div>
  `;

  // --- suggest ---
  const foodInput = $('#f-food'), foodId = $('#f-foodid'), suggestBox = $('#suggest');
  let sugItems = [], sugActive = -1;
  const renderSuggest = () => {
    if (!sugItems.length) { suggestBox.style.display = 'none'; return; }
    suggestBox.innerHTML = sugItems.map((it, i) => it.__new
      ? `<div class="new ${i === sugActive ? 'active' : ''}" data-i="${i}">＋「${esc(it.name)}」を未登録食材として使う</div>`
      : `<div class="${i === sugActive ? 'active' : ''}" data-i="${i}">${esc(it.name)} <span class="muted small">${num(it.calories, 0)}kcal/100g</span></div>`).join('');
    suggestBox.style.display = 'block';
    suggestBox.querySelectorAll('div').forEach((d) => d.addEventListener('mousedown', (e) => { e.preventDefault(); pickSuggest(Number(d.dataset.i)); }));
  };
  const pickSuggest = (i) => {
    const it = sugItems[i]; if (!it) return;
    foodInput.value = it.name; foodId.value = it.__new ? '' : it.id;
    suggestBox.style.display = 'none'; sugItems = []; $('#f-grams').focus();
  };
  let sugTimer;
  foodInput.addEventListener('input', () => {
    foodId.value = '';
    const q = foodInput.value.trim();
    clearTimeout(sugTimer);
    if (!q) { suggestBox.style.display = 'none'; return; }
    sugTimer = setTimeout(async () => {
      const rows = await api.get(`/api/foods?search=${encodeURIComponent(q)}`);
      sugItems = rows.slice(0, 8);
      if (!rows.some((r) => r.name === q)) sugItems.push({ __new: true, name: q });
      sugActive = -1; renderSuggest();
    }, 120);
  });
  foodInput.addEventListener('keydown', (e) => {
    if (suggestBox.style.display === 'none') return;
    if (e.key === 'ArrowDown') { e.preventDefault(); sugActive = Math.min(sugItems.length - 1, sugActive + 1); renderSuggest(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sugActive = Math.max(0, sugActive - 1); renderSuggest(); }
    else if (e.key === 'Enter' && sugActive >= 0) { e.preventDefault(); pickSuggest(sugActive); }
  });
  foodInput.addEventListener('blur', () => setTimeout(() => { suggestBox.style.display = 'none'; }, 150));

  // --- quick chips ---
  $('#quick')?.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
    foodInput.value = c.dataset.name;
    foodId.value = c.dataset.id || '';
    $('#f-grams').value = c.dataset.grams;
    $('#f-grams').focus(); $('#f-grams').select();
  }));

  // --- supplement quick chips（タップで個数ぶん記録）---
  $('#supp-quick')?.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', async () => {
    const units = $('#supp-units').value;
    if (units === '' || Number(units) <= 0) { toast('個数を入力してください', true); return; }
    try {
      await api.post('/api/supplement-logs', {
        date: $('#f-date').value, time: $('#f-time').value,
        supplementId: c.dataset.suppid, supplementName: c.dataset.name, units,
      });
      toast(`${c.dataset.name} を ${num(units, 0)}個 記録しました`);
      loadTodayMeals($('#f-date').value);
    } catch (e) { toast(e.message, true); }
  }));

  // --- add ---
  $('#btn-add').addEventListener('click', addMeal);
  $('#f-grams').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMeal(); });

  async function addMeal() {
    const foodName = foodInput.value.trim();
    const grams = $('#f-grams').value;
    if (!foodName || grams === '') { toast('食材名とグラム数を入力してください', true); return; }
    const payload = {
      date: $('#f-date').value, time: $('#f-time').value, mealType: $('#f-type').value,
      foodId: foodId.value || null, foodName, grams, memo: $('#f-memo').value,
    };
    try {
      const r = await api.post('/api/meals', payload);
      toast('記録しました');
      foodInput.value = ''; foodId.value = ''; $('#f-grams').value = ''; $('#f-memo').value = '';
      foodInput.focus();
      loadTodayMeals($('#f-date').value);
      if (r.unregistered) promptRegister(foodName);
    } catch (e) { toast(e.message, true); }
  }

  // --- copy ---
  $('#btn-copy').addEventListener('click', async () => {
    const to = $('#f-date').value; const from = addDays(to, -1);
    if (!confirm(`${from} の食事を ${to} にコピーします。よろしいですか？`)) return;
    try { const r = await api.post('/api/meals/copy', { from, to }); toast(`${r.copied} 件コピーしました`); loadTodayMeals(to); }
    catch (e) { toast(e.message, true); }
  });

  $('#f-date').addEventListener('change', () => loadTodayMeals($('#f-date').value));
  loadTodayMeals(date);

  async function loadTodayMeals(d) {
    const [data, energy] = await Promise.all([
      api.get(`/api/nutrition/daily?date=${d}`),
      api.get(`/api/energy?date=${d}`),
    ]);
    const burn = energy && energy.burnedCalories != null ? energy.burnedCalories : null;

    const box = $('#today-meals');
    const rows = data.meals.length ? data.meals.map((m) => `
      <tr>
        <td>${esc(m.time || '')}</td><td>${esc(m.mealType)}</td>
        <td>${esc(m.foodName)} ${m.isUnregistered ? '<span class="pill unreg">未登録</span>' : ''}</td>
        <td class="num">${num(m.grams, 0)}g</td>
        <td class="num">${nutrientCell(m.nutrients.calories)}</td>
        <td><button class="ghost sm" data-del="${m.id}">削除</button></td>
      </tr>`).join('') : '<tr><td colspan="6" class="muted">この日の記録はまだありません</td></tr>';
    const intake = data.total.calories.value;
    const net = burn != null
      ? `摂取 ${num(intake, 0)} − 消費 ${num(burn, 0)} = <b class="${intake - burn > 0 ? 'status-over' : 'status-ok'}">${num(intake - burn, 0)}</b> kcal`
      : `摂取 <b>${num(intake, 0)}</b> kcal <span class="muted small">(消費カロリーは「記録」画面で入力)</span>`;

    const supps = data.supplements || [];
    const suppSection = supps.length ? `
      <h3 style="margin-top:16px">💊 サプリ</h3>
      <div class="table-wrap"><table><thead><tr><th>時刻</th><th>サプリ</th><th class="num">個数</th><th class="num">kcal</th><th></th></tr></thead><tbody>
      ${supps.map((s) => `<tr>
        <td>${esc(s.time || '')}</td><td>${esc(s.supplementName)}</td>
        <td class="num">${num(s.units, 0)}個</td>
        <td class="num">${nutrientCell(s.nutrients.calories)}</td>
        <td><button class="ghost sm" data-suppdel="${s.id}">削除</button></td>
      </tr>`).join('')}
      </tbody></table></div>` : '';

    box.innerHTML = `<div class="flex-between"><h2>${d} の記録</h2><div>${net} ／ タンパク質 ${num(data.total.protein.value, 0)}g</div></div>
      <div class="table-wrap"><table><thead><tr><th>時刻</th><th>区分</th><th>食材</th><th class="num">量</th><th class="num">kcal</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
      ${suppSection}
      <p class="small muted" style="margin-top:8px">※ 上部の合計（摂取kcal・タンパク質）には食事とサプリの両方が含まれます。</p>`;
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      await api.del(`/api/meals/${b.dataset.del}`); toast('削除しました'); loadTodayMeals(d);
    }));
    box.querySelectorAll('[data-suppdel]').forEach((b) => b.addEventListener('click', async () => {
      await api.del(`/api/supplement-logs/${b.dataset.suppdel}`); toast('削除しました'); loadTodayMeals(d);
    }));
  }
}

// 未登録食材 → 登録を促す
function promptRegister(name) {
  const node = el(`<div class="modal">
    <h2>「${esc(name)}」は食材マスタにありません</h2>
    <p class="muted">食材マスタへ追加しますか？追加すると栄養素が計算に反映されます。</p>
    <div class="row" style="margin-top:12px">
      <button id="pr-llm">🤖 LLMで栄養を推定して追加</button>
      <button class="ghost" id="pr-manual">手動で追加</button>
      <button class="ghost" id="pr-later">あとで</button>
    </div>
    <p class="small muted" style="margin-top:8px">※ LLM推定値は「推定値」として登録され、確定データと区別されます。</p>
  </div>`);
  node.querySelector('#pr-later').onclick = closeModal;
  node.querySelector('#pr-manual').onclick = () => { closeModal(); openFoodEditor({ name }); };
  node.querySelector('#pr-llm').onclick = async () => {
    const btn = node.querySelector('#pr-llm'); btn.textContent = '推定中…'; btn.disabled = true;
    try {
      const r = await api.post('/api/foods/estimate', { name });
      closeModal();
      const draft = { ...r.draft, isEstimated: true };
      openFoodEditor(draft, r.available ? '🤖 LLM推定値です。内容を確認・修正して保存してください。' : '⚠ LLM未接続のため空欄です。手動で入力してください。');
    } catch (e) { toast(e.message, true); btn.textContent = '🤖 LLMで栄養を推定して追加'; btn.disabled = false; }
  };
  openModal(node);
}

// ======================================================
// 食事履歴
// ======================================================
async function viewHistory() {
  const meals = await api.get('/api/meals');
  const byDate = {};
  meals.forEach((m) => (byDate[m.date] ||= []).push(m));
  const dates = Object.keys(byDate).sort().reverse();

  app.innerHTML = `<h1>食事履歴</h1>` + (dates.length ? dates.map((d) => `
    <div class="card">
      <div class="flex-between"><h2>${d}</h2><a href="#/input?date=${d}" class="pill">この日に追加</a></div>
      <div class="table-wrap"><table><thead><tr><th>時刻</th><th>区分</th><th>食材</th><th class="num">量</th><th>メモ</th><th></th></tr></thead><tbody>
      ${byDate[d].map((m) => `<tr>
        <td>${esc(m.time || '')}</td><td>${esc(m.mealType)}</td>
        <td>${esc(m.foodName)} ${m.isUnregistered ? '<span class="pill unreg">未登録</span>' : ''}</td>
        <td class="num">${num(m.grams, 0)}g</td><td class="muted small">${esc(m.memo || '')}</td>
        <td><button class="ghost sm" data-del="${m.id}">削除</button></td>
      </tr>`).join('')}
      </tbody></table></div>
    </div>`).join('') : '<div class="card empty">まだ食事記録がありません。<a href="#/input">食事入力</a>から始めましょう。</div>');

  app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('この記録を削除しますか？')) return;
    await api.del(`/api/meals/${b.dataset.del}`); toast('削除しました'); viewHistory();
  }));
}

// ======================================================
// 食材マスタ一覧
// ======================================================
async function viewFoods(params) {
  const search = params.get('q') || '';
  const foods = await api.get(`/api/foods${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  app.innerHTML = `
    <div class="flex-between"><h1>食材マスタ (${foods.length})</h1><div class="row"><button class="ghost" id="bulk-food">📋 まとめて貼り付け</button><button id="new-food">＋ 新規食材</button></div></div>
    <div class="card">
      <input type="search" id="food-search" placeholder="食材名・別名で検索" value="${esc(search)}">
      <div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>食材名</th><th class="num">kcal</th><th class="num">P</th><th class="num">F</th><th class="num">C</th><th></th></tr></thead>
        <tbody>${foods.map((f) => `<tr>
          <td>${esc(f.name)} ${f.isEstimated ? '<span class="pill est">推定値</span>' : ''}<div class="muted small">${esc(f.aliases || '')}</div></td>
          <td class="num">${num(f.calories, 0)}</td><td class="num">${num(f.protein)}</td><td class="num">${num(f.fat)}</td><td class="num">${num(f.carbs)}</td>
          <td><button class="ghost sm" data-edit="${f.id}">編集</button> <button class="ghost sm danger" data-del="${f.id}">削除</button></td>
        </tr>`).join('')}</tbody>
      </table></div>
    </div>`;

  const searchEl = $('#food-search');
  let tm; searchEl.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { location.hash = `#/foods?q=${encodeURIComponent(searchEl.value)}`; }, 300); });
  $('#new-food').onclick = () => openFoodEditor({});
  $('#bulk-food').onclick = () => openBulkFoodEditor();
  app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const f = (await api.get('/api/foods')).find((x) => x.id == b.dataset.edit); openFoodEditor(f);
  });
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('この食材を削除しますか？（過去の記録の食材は未登録扱いになります）')) return;
    await api.del(`/api/foods/${b.dataset.del}`); toast('削除しました'); viewFoods(params);
  });
}

// 食材編集モーダル（新規・編集・LLM下書き共通）
function openFoodEditor(food = {}, banner = '') {
  const isEdit = !!food.id;
  const groups = { macro: '主要栄養素', mineral: 'ミネラル', vitamin: 'ビタミン', fat: '脂肪酸' };
  const fieldFor = (n) => `<div><label>${n.label} <span class="muted small">${n.unit}/100g</span></label>
    <input type="number" step="any" data-k="${n.key}" value="${food[n.key] ?? ''}" placeholder="未登録"></div>`;
  const sections = Object.entries(groups).map(([g, title]) => `
    <h2>${title}</h2><div class="grid grid-4">${META.nutrients.filter((n) => n.group === g).map(fieldFor).join('')}</div>`).join('');

  const node = el(`<div class="modal">
    <div class="flex-between"><h2>${isEdit ? '食材を編集' : '食材を追加'}</h2><button class="ghost sm" id="fe-close">✕</button></div>
    ${banner ? `<p class="pill est" style="display:block;padding:8px 12px">${esc(banner)}</p>` : ''}
    <div class="row">
      <div style="flex:1"><label>食材名 *</label><input id="fe-name" value="${esc(food.name || '')}"></div>
    </div>
    <label>別名・表記ゆれ（カンマ区切り）</label><input id="fe-alias" value="${esc(food.aliases || '')}" placeholder="例: ごはん,ご飯,ライス">
    ${sections}
    <div class="row"><div><label>データソース</label><input id="fe-src" value="${esc(food.dataSource || '')}"></div>
      <div><label>備考</label><input id="fe-note" value="${esc(food.note || '')}"></div></div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="fe-est" ${food.isEstimated ? 'checked' : ''} style="width:auto"> LLM推定値として扱う（確定データと区別）</label>
    <div class="row" style="margin-top:16px"><button id="fe-save">${isEdit ? '更新' : '追加'}</button><button class="ghost" id="fe-cancel">キャンセル</button></div>
  </div>`);

  node.querySelector('#fe-close').onclick = closeModal;
  node.querySelector('#fe-cancel').onclick = closeModal;
  node.querySelector('#fe-save').onclick = async () => {
    const payload = {
      name: node.querySelector('#fe-name').value.trim(),
      aliases: node.querySelector('#fe-alias').value,
      dataSource: node.querySelector('#fe-src').value,
      note: node.querySelector('#fe-note').value,
      isEstimated: node.querySelector('#fe-est').checked,
    };
    if (!payload.name) { toast('食材名は必須です', true); return; }
    node.querySelectorAll('input[data-k]').forEach((i) => { payload[i.dataset.k] = i.value === '' ? null : i.value; });
    try {
      let r;
      if (isEdit) r = await api.put(`/api/foods/${food.id}`, payload);
      else r = await api.post('/api/foods', payload);
      closeModal();
      toast(isEdit ? '更新しました' : `追加しました${r.relinked ? `（未登録記録 ${r.relinked} 件を紐付け）` : ''}`);
      router();
    } catch (e) { toast(e.message, true); }
  };
  openModal(node);
}

// 貼り付け一括登録モーダル（AI生成データ等をコピペ一発で登録）
function openBulkFoodEditor() {
  const example = `食材名：ハンバーグ
カロリー
約230 kcal
タンパク質
約15.5 g
脂質
約16.5 g
…`;
  const node = el(`<div class="modal">
    <div class="flex-between"><h2>まとめて貼り付け登録</h2><button class="ghost sm" id="bf-close">✕</button></div>
    <p class="small muted">AI等で生成した栄養データを、下の欄に貼り付けて登録します。<b>「食材名：○○」</b>で始まる区切りごとに1食材として登録され、複数食材をまとめて貼り付けできます。数値は<b>100gあたり</b>として扱われます。同名の食材は栄養素が上書き更新されます。</p>
    <label>貼り付けテキスト</label>
    <textarea id="bf-text" rows="12" style="width:100%;font-family:monospace" placeholder="${esc(example)}"></textarea>
    <div class="row" style="margin-top:16px"><button id="bf-save">登録</button><button class="ghost" id="bf-cancel">キャンセル</button></div>
  </div>`);

  node.querySelector('#bf-close').onclick = closeModal;
  node.querySelector('#bf-cancel').onclick = closeModal;
  node.querySelector('#bf-save').onclick = async () => {
    const text = node.querySelector('#bf-text').value;
    if (!text.trim()) { toast('テキストを貼り付けてください', true); return; }
    try {
      const r = await api.post('/api/foods/bulk', { text });
      closeModal();
      const parts = [];
      if (r.added) parts.push(`新規 ${r.added} 件`);
      if (r.updated) parts.push(`更新 ${r.updated} 件`);
      if (r.relinked) parts.push(`未登録記録 ${r.relinked} 件を紐付け`);
      toast(`登録しました（${parts.join(' / ') || '0 件'}）`);
      router();
    } catch (e) { toast(e.message, true); }
  };
  openModal(node);
}

// ======================================================
// サプリマスタ一覧（食材マスタと同様だが別管理・栄養値は1個あたり）
// ======================================================
async function viewSupplements(params) {
  const search = params.get('q') || '';
  const supps = await api.get(`/api/supplements${search ? `?search=${encodeURIComponent(search)}` : ''}`);
  app.innerHTML = `
    <div class="flex-between"><h1>サプリ (${supps.length})</h1><button id="new-supp">＋ 新規サプリ</button></div>
    <div class="card">
      <p class="small muted">サプリは食材マスタとは別に管理します。栄養素の値は「1粒／1個あたり」の含有量で登録してください。食事入力画面で「○個」と記録すると、その個数ぶんが摂取栄養素に加算されます。</p>
      <input type="search" id="supp-search" placeholder="サプリ名・別名・メーカーで検索" value="${esc(search)}">
      <div class="table-wrap" style="margin-top:12px"><table>
        <thead><tr><th>サプリ名</th><th>メーカー</th><th class="num">kcal</th><th class="num">P</th><th class="num">C</th><th class="num">Vit.C</th><th></th></tr></thead>
        <tbody>${supps.length ? supps.map((s) => `<tr>
          <td>${esc(s.name)} ${s.isEstimated ? '<span class="pill est">推定値</span>' : ''}<div class="muted small">${esc(s.aliases || '')}</div></td>
          <td>${esc(s.brand || '')}</td>
          <td class="num">${num(s.calories, 0)}</td><td class="num">${num(s.protein)}</td><td class="num">${num(s.carbs)}</td><td class="num">${num(s.vitaminC)}</td>
          <td><button class="ghost sm" data-edit="${s.id}">編集</button> <button class="ghost sm danger" data-del="${s.id}">削除</button></td>
        </tr>`).join('') : '<tr><td colspan="7" class="muted">まだサプリが登録されていません</td></tr>'}</tbody>
      </table></div>
      <p class="small muted" style="margin-top:8px">値はすべて「1個あたり」。kcal=カロリー / P=タンパク質 / C=炭水化物 / Vit.C=ビタミンC。</p>
    </div>`;

  const searchEl = $('#supp-search');
  let tm; searchEl.addEventListener('input', () => { clearTimeout(tm); tm = setTimeout(() => { location.hash = `#/supplements?q=${encodeURIComponent(searchEl.value)}`; }, 300); });
  $('#new-supp').onclick = () => openSupplementEditor({});
  app.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const s = (await api.get('/api/supplements')).find((x) => x.id == b.dataset.edit); openSupplementEditor(s);
  });
  app.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
    if (!confirm('このサプリを削除しますか？（過去のサプリ記録はマスタとの紐付けが外れます）')) return;
    await api.del(`/api/supplements/${b.dataset.del}`); toast('削除しました'); viewSupplements(params);
  });
}

// サプリ編集モーダル（新規・編集共通）。栄養素は1個あたりで入力。
function openSupplementEditor(supp = {}) {
  const isEdit = !!supp.id;
  const groups = { macro: '主要栄養素', mineral: 'ミネラル', vitamin: 'ビタミン', fat: '脂肪酸' };
  const fieldFor = (n) => `<div><label>${n.label} <span class="muted small">${n.unit}/個</span></label>
    <input type="number" step="any" data-k="${n.key}" value="${supp[n.key] ?? ''}" placeholder="未登録"></div>`;
  const sections = Object.entries(groups).map(([g, title]) => `
    <h2>${title} <span class="muted small">（1個あたり）</span></h2><div class="grid grid-4">${META.nutrients.filter((n) => n.group === g).map(fieldFor).join('')}</div>`).join('');

  const node = el(`<div class="modal">
    <div class="flex-between"><h2>${isEdit ? 'サプリを編集' : 'サプリを追加'}</h2><button class="ghost sm" id="se-close">✕</button></div>
    <p class="small muted">栄養素はすべて「1粒／1個あたり」の含有量で入力してください。</p>
    <div class="row">
      <div style="flex:2"><label>サプリ名 *</label><input id="se-name" value="${esc(supp.name || '')}"></div>
      <div style="flex:1"><label>メーカー</label><input id="se-brand" value="${esc(supp.brand || '')}"></div>
    </div>
    <label>別名・表記ゆれ（カンマ区切り）</label><input id="se-alias" value="${esc(supp.aliases || '')}" placeholder="例: マルチビタミン,MVM">
    ${sections}
    <div class="row"><div><label>データソース</label><input id="se-src" value="${esc(supp.dataSource || '')}" placeholder="例: 製品ラベル"></div>
      <div><label>備考</label><input id="se-note" value="${esc(supp.note || '')}"></div></div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="se-est" ${supp.isEstimated ? 'checked' : ''} style="width:auto"> 推定値として扱う（確定データと区別）</label>
    <div class="row" style="margin-top:16px"><button id="se-save">${isEdit ? '更新' : '追加'}</button><button class="ghost" id="se-cancel">キャンセル</button></div>
  </div>`);

  node.querySelector('#se-close').onclick = closeModal;
  node.querySelector('#se-cancel').onclick = closeModal;
  node.querySelector('#se-save').onclick = async () => {
    const payload = {
      name: node.querySelector('#se-name').value.trim(),
      brand: node.querySelector('#se-brand').value,
      aliases: node.querySelector('#se-alias').value,
      dataSource: node.querySelector('#se-src').value,
      note: node.querySelector('#se-note').value,
      isEstimated: node.querySelector('#se-est').checked,
    };
    if (!payload.name) { toast('サプリ名は必須です', true); return; }
    node.querySelectorAll('input[data-k]').forEach((i) => { payload[i.dataset.k] = i.value === '' ? null : i.value; });
    try {
      if (isEdit) await api.put(`/api/supplements/${supp.id}`, payload);
      else await api.post('/api/supplements', payload);
      closeModal();
      toast(isEdit ? '更新しました' : '追加しました');
      router();
    } catch (e) { toast(e.message, true); }
  };
  openModal(node);
}

// ======================================================
// 未登録食材確認
// ======================================================
async function viewUnregistered() {
  const rows = await api.get('/api/meals/unregistered');
  app.innerHTML = `<div class="flex-between"><h1>未登録食材の確認</h1><button class="ghost" id="bulk-food">📋 まとめて貼り付け</button></div>
    <div class="card">
      <p class="muted">食材マスタに存在しない食材です。登録すると過去の記録にも栄養素が反映されます。個別に「推定して登録」「手動登録」するほか、AI等で生成したデータを「まとめて貼り付け」で一括登録できます。</p>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>食材名</th><th class="num">記録回数</th><th>最終記録日</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.foodName)}</td><td class="num">${r.count}</td><td>${esc(r.lastDate)}</td>
          <td><button class="sm" data-llm="${esc(r.foodName)}">🤖推定して登録</button> <button class="ghost sm" data-manual="${esc(r.foodName)}">手動登録</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">未登録食材はありません 🎉</div>'}
    </div>`;
  $('#bulk-food').onclick = () => openBulkFoodEditor();
  app.querySelectorAll('[data-manual]').forEach((b) => b.onclick = () => openFoodEditor({ name: b.dataset.manual }));
  app.querySelectorAll('[data-llm]').forEach((b) => b.onclick = async () => {
    b.textContent = '推定中…'; b.disabled = true;
    try {
      const r = await api.post('/api/foods/estimate', { name: b.dataset.llm });
      openFoodEditor({ ...r.draft, isEstimated: true }, r.available ? '🤖 LLM推定値です。確認・修正して保存してください。' : '⚠ LLM未接続のため空欄です。手動入力してください。');
    } catch (e) { toast(e.message, true); }
    b.textContent = '🤖推定して登録'; b.disabled = false;
  });
}

// ======================================================
// 週次・月次レポート
// ======================================================
async function viewWeekly(params) {
  const start = params.get('start') || addDays(todayStr(), -6);
  const data = await api.get(`/api/nutrition/weekly?start=${start}`);
  app.innerHTML = `
    <div class="flex-between"><h1>週次レポート</h1>
      <div class="row" style="flex:0 0 auto">
        <button class="ghost sm" id="prev">← 前の週</button>
        <span class="muted">${data.start} 〜 ${data.end}</span>
        <button class="ghost sm" id="next">次の週 →</button>
      </div>
    </div>
    ${rangeReport(data, 'calories')}`;
  $('#prev').onclick = () => location.hash = `#/weekly?start=${addDays(start, -7)}`;
  $('#next').onclick = () => location.hash = `#/weekly?start=${addDays(start, 7)}`;
  wireRangeChart(data);
}

async function viewMonthly(params) {
  const month = params.get('month') || todayStr().slice(0, 7);
  const data = await api.get(`/api/nutrition/monthly?month=${month}`);
  const [y, m] = month.split('-').map(Number);
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  app.innerHTML = `
    <div class="flex-between"><h1>月次レポート</h1>
      <div class="row" style="flex:0 0 auto">
        <button class="ghost sm" id="prev">← 前の月</button>
        <span class="muted">${month}</span>
        <button class="ghost sm" id="next">次の月 →</button>
      </div>
    </div>
    ${rangeReport(data, 'calories')}`;
  $('#prev').onclick = () => location.hash = `#/monthly?month=${prev}`;
  $('#next').onclick = () => location.hash = `#/monthly?month=${next}`;
  wireRangeChart(data);
}

function rangeReport(data, defKey) {
  return `
    <div class="grid grid-4">
      <div class="stat"><div class="label">合計カロリー</div><div class="value">${num(data.total.calories.value, 0)}<small>kcal</small></div></div>
      <div class="stat"><div class="label">1日平均カロリー</div><div class="value">${num(data.average.calories.value, 0)}<small>kcal</small></div></div>
      <div class="stat"><div class="label">1日平均タンパク質</div><div class="value">${num(data.average.protein.value)}<small>g</small></div></div>
      <div class="stat"><div class="label">記録日数</div><div class="value">${data.recordedDays}<small>日</small></div></div>
    </div>
    <div class="card">
      <div class="flex-between"><h2>日別推移</h2>
        <select id="chart-key">${META.nutrients.map((n) => `<option value="${n.key}" ${n.key === defKey ? 'selected' : ''}>${n.label}</option>`).join('')}</select>
      </div>
      <div id="range-chart"></div>
    </div>
    <div class="card"><h2>期間の栄養素 合計</h2>${nutrientTable(data.total)}</div>
    <div class="card"><h2>期間の栄養素 1日平均</h2>${nutrientTable(data.average)}</div>`;
}

function wireRangeChart(data) {
  const sel = $('#chart-key'), box = $('#range-chart');
  const draw = (key) => {
    const unit = META.nutrients.find((n) => n.key === key).unit;
    const max = Math.max(1, ...data.days.map((x) => x.total[key].value));
    box.innerHTML = `<div class="chart">${data.days.map((x) => {
      const v = x.total[key].value; const h = Math.round((v / max) * 100);
      return `<div class="col"><div class="amt">${v ? num(v, 0) : ''}</div><div class="fill" style="height:${h}%"></div><div class="cap">${x.date.slice(5)}</div></div>`;
    }).join('')}</div><p class="small muted">単位: ${unit}／最大 ${num(max, 0)}</p>`;
  };
  draw(sel.value);
  sel.onchange = () => draw(sel.value);
}

// ======================================================
// 記録（消費カロリー・体組成）— いずれも日付を指定して入力
// ======================================================
async function viewRecords() {
  const [energyList, bodyList] = await Promise.all([api.get('/api/energy'), api.get('/api/body')]);

  app.innerHTML = `
    <h1>記録</h1>

    <div class="card">
      <h2>消費カロリー</h2>
      <p class="small muted">スマートウォッチ等の消費カロリーを、日付を指定して入力（日付ごとに1つ・上書き保存）。</p>
      <div class="row" style="align-items:flex-end">
        <div><label>日付</label><input type="date" id="e-date" value="${todayStr()}"></div>
        <div style="flex:2"><label>消費カロリー (kcal)</label><input type="number" id="e-val" min="0" step="1" placeholder="例: 2200"></div>
        <div style="flex:0 0 auto"><button id="e-add">記録</button></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>日付</th><th class="num">消費カロリー</th><th></th></tr></thead>
        <tbody>${energyList.length ? energyList.map((r) => `<tr><td>${r.date}</td><td class="num">${num(r.burnedCalories, 0)} kcal</td><td><button class="ghost sm" data-edate="${r.date}">削除</button></td></tr>`).join('') : '<tr><td colspan="3" class="muted">記録なし</td></tr>'}</tbody>
      </table></div>
    </div>

    <div class="card">
      <h2>体重・体脂肪率・内臓脂肪</h2>
      <p class="small muted">翌朝の測定値を登録する想定。日付を指定して入力（日付ごとに1セット・同じ日付は上書き）。</p>
      <div class="row" style="align-items:flex-end">
        <div><label>日付</label><input type="date" id="b-date" value="${todayStr()}"></div>
        <div><label>体重 (kg)</label><input type="number" step="0.1" id="b-wt"></div>
        <div><label>体脂肪率 (%)</label><input type="number" step="0.1" id="b-bf"></div>
        <div><label>内臓脂肪</label><input type="number" step="0.1" id="b-vf"></div>
        <div style="flex:0 0 auto"><button id="b-add">記録</button></div>
      </div>
      <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>日付</th><th class="num">体重</th><th class="num">体脂肪率</th><th class="num">内臓脂肪</th><th></th></tr></thead>
        <tbody>${bodyList.length ? bodyList.map((r) => `<tr><td>${r.date}</td><td class="num">${num(r.weight)}kg</td><td class="num">${num(r.bodyFat)}%</td><td class="num">${num(r.visceralFat)}</td><td><button class="ghost sm" data-bdel="${r.id}">削除</button></td></tr>`).join('') : '<tr><td colspan="5" class="muted">記録なし</td></tr>'}</tbody>
      </table></div>
    </div>`;

  // --- 消費カロリー ---
  const loadEnergy = async (d) => {
    const rec = await api.get(`/api/energy?date=${d}`);
    $('#e-val').value = rec && rec.burnedCalories != null ? rec.burnedCalories : '';
  };
  $('#e-date').onchange = () => loadEnergy($('#e-date').value);
  loadEnergy(todayStr());
  $('#e-add').onclick = async () => {
    if ($('#e-val').value === '') { toast('消費カロリーを入力してください', true); return; }
    await api.post('/api/energy', { date: $('#e-date').value, burnedCalories: $('#e-val').value });
    toast('記録しました'); viewRecords();
  };
  app.querySelectorAll('[data-edate]').forEach((b) => b.onclick = async () => {
    await api.del(`/api/energy/${b.dataset.edate}`); toast('削除しました'); viewRecords();
  });

  // --- 体組成 ---
  const loadBody = async (d) => {
    const rec = await api.get(`/api/body?date=${d}`);
    $('#b-wt').value = rec && rec.weight != null ? rec.weight : '';
    $('#b-bf').value = rec && rec.bodyFat != null ? rec.bodyFat : '';
    $('#b-vf').value = rec && rec.visceralFat != null ? rec.visceralFat : '';
  };
  $('#b-date').onchange = () => loadBody($('#b-date').value);
  loadBody(todayStr());
  $('#b-add').onclick = async () => {
    if (!$('#b-wt').value && !$('#b-bf').value && !$('#b-vf').value) { toast('体重・体脂肪率・内臓脂肪のいずれかを入力してください', true); return; }
    await api.post('/api/body', { date: $('#b-date').value, weight: $('#b-wt').value, bodyFat: $('#b-bf').value, visceralFat: $('#b-vf').value });
    toast('記録しました'); viewRecords();
  };
  app.querySelectorAll('[data-bdel]').forEach((b) => b.onclick = async () => {
    await api.del(`/api/body/${b.dataset.bdel}`); toast('削除しました'); viewRecords();
  });
}

// ======================================================
// 目標設定
// ======================================================
async function viewGoals() {
  const g = await api.get('/api/goals');
  app.innerHTML = `
    <h1>目標設定</h1>
    <div class="card">
      <h2>1日の栄養目標</h2>
      <div class="grid grid-2">
        <div><label>目標カロリー (kcal)</label><input type="number" id="g-cal" value="${g.targetCalories ?? ''}"></div>
        <div><label>目標タンパク質 (g)</label><input type="number" id="g-pro" value="${g.targetProtein ?? ''}"></div>
        <div><label>目標食物繊維 (g)</label><input type="number" id="g-fib" value="${g.targetFiber ?? ''}"></div>
        <div><label>食塩の上限 (g)</label><input type="number" step="0.1" id="g-salt" value="${g.saltLimit ?? ''}"></div>
      </div>
      <h2>体組成の目標</h2>
      <div class="grid grid-2">
        <div><label>目標体重 (kg)</label><input type="number" step="0.1" id="g-wt" value="${g.weightGoal ?? ''}"></div>
        <div><label>目標体脂肪率 (%)</label><input type="number" step="0.1" id="g-bf" value="${g.bodyFatGoal ?? ''}"></div>
      </div>
      <div style="margin-top:16px"><button id="g-save">目標を保存</button></div>
      <p class="small muted" style="margin-top:12px">体重・体脂肪率・内臓脂肪・消費カロリーの日々の記録は「記録」画面で入力できます。</p>
    </div>

    <div class="card">
      <h2>データのエクスポート（ZIP）</h2>
      <p class="small muted">マスタ（食材・サプリ）と、日々の記録（食事・消費カロリー・体組成）を別々に書き出せます。インポート時はファイル名で内容を自動判別します。</p>

      <h3>① 食材マスタ・サプリ</h3>
      <p class="small muted">食材マスタ・サプリマスタ・目標設定を全件書き出します（期間指定なし）。</p>
      <button id="ex-masters">マスタをエクスポート</button>

      <h3 style="margin-top:16px">② 食事・消費カロリー・体組成</h3>
      <p class="small muted">期間を指定して、食事・サプリ摂取記録・消費カロリー・体組成を書き出します。</p>
      <div class="row" style="align-items:flex-end">
        <div><label>開始日</label><input type="date" id="ex-start" value="${addDays(todayStr(), -30)}"></div>
        <div><label>終了日</label><input type="date" id="ex-end" value="${todayStr()}"></div>
        <div style="flex:0 0 auto"><button id="ex-records">記録をエクスポート</button></div>
      </div>
    </div>

    <div class="card">
      <h2>データのインポート（ZIP）</h2>
      <p class="small muted">エクスポートしたZIPを取り込みます。マスタのみ・記録のみ・全部入り、どのZIPでもファイル名を見て含まれるものだけを取り込みます。食材・サプリは名前で突き合わせ、食事・サプリ記録は完全一致する重複を自動でスキップします。</p>
      <label>ZIPファイル</label>
      <input type="file" id="im-file" accept=".zip,application/zip">
      <div class="row" style="margin-top:8px">
        <div>
          <label>重複した日付の扱い</label>
          <select id="im-mode">
            <option value="skip">既存を保持（スキップ）</option>
            <option value="overwrite">インポート内容で上書き</option>
          </select>
        </div>
        <div style="display:flex;align-items:flex-end">
          <label style="display:flex;align-items:center;gap:8px;margin:0"><input type="checkbox" id="im-goals" style="width:auto"> 目標設定も取り込む</label>
        </div>
        <div style="display:flex;align-items:flex-end;flex:0 0 auto"><button class="warn" id="im-btn">インポート実行</button></div>
      </div>
      <div id="im-result" style="margin-top:12px"></div>
    </div>`;

  $('#g-save').onclick = async () => {
    await api.put('/api/goals', {
      targetCalories: $('#g-cal').value, targetProtein: $('#g-pro').value, targetFiber: $('#g-fib').value,
      saltLimit: $('#g-salt').value, weightGoal: $('#g-wt').value, bodyFatGoal: $('#g-bf').value,
    });
    toast('目標を保存しました');
  };

  // --- エクスポート（ブラウザのダウンロード）---
  $('#ex-masters').onclick = () => {
    window.location.href = `/api/export?scope=masters`;
    toast('マスタのエクスポートを開始しました');
  };
  $('#ex-records').onclick = () => {
    const s = $('#ex-start').value, e = $('#ex-end').value;
    if (s && e && s > e) { toast('開始日は終了日より前にしてください', true); return; }
    window.location.href = `/api/export?scope=records&start=${encodeURIComponent(s)}&end=${encodeURIComponent(e)}`;
    toast('記録のエクスポートを開始しました');
  };

  // --- インポート ---
  $('#im-btn').onclick = async () => {
    const file = $('#im-file').files[0];
    if (!file) { toast('ZIPファイルを選択してください', true); return; }
    const mode = $('#im-mode').value;
    const goals = $('#im-goals').checked ? '1' : '0';
    if (!confirm(`「${file.name}」を取り込みます。よろしいですか？`)) return;
    const btn = $('#im-btn'); btn.disabled = true; btn.textContent = '取り込み中…';
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`/api/import?mode=${mode}&goals=${goals}`, {
        method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: buf,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'インポート失敗');
      const s = data.summary;
      const scopeLabel = { masters: '食材マスタ・サプリ', records: '食事・消費カロリー・体組成', all: '全データ' }[data.manifest.scope] || '全データ';
      const rangeLabel = data.manifest.range ? `期間 ${esc(data.manifest.range.start)} 〜 ${esc(data.manifest.range.end)}` : '期間 —（マスタ）';
      $('#im-result').innerHTML = `<div class="card" style="background:var(--brand-light)">
        <b>インポート完了</b>（種別: ${scopeLabel} / ${rangeLabel} / モード: ${mode === 'overwrite' ? '上書き' : 'スキップ'}）
        <ul class="small" style="margin:8px 0 0">
          <li>食材: 追加 ${s.foods.added} / 更新 ${s.foods.updated} / スキップ ${s.foods.skipped}</li>
          <li>食事: 追加 ${s.meals.added} / スキップ(重複) ${s.meals.skipped}</li>
          <li>消費カロリー: 追加 ${s.daily_energy.added} / 更新 ${s.daily_energy.updated} / スキップ ${s.daily_energy.skipped}</li>
          <li>体組成: 追加 ${s.body_records.added} / 更新 ${s.body_records.updated} / スキップ ${s.body_records.skipped}</li>
          ${s.supplements ? `<li>サプリ: 追加 ${s.supplements.added} / 更新 ${s.supplements.updated} / スキップ ${s.supplements.skipped}</li>` : ''}
          ${s.supplement_logs ? `<li>サプリ記録: 追加 ${s.supplement_logs.added} / スキップ(重複) ${s.supplement_logs.skipped}</li>` : ''}
          <li>目標: ${s.goals === 'imported' ? '取り込み' : '対象外'}</li>
        </ul></div>`;
      toast('インポートしました');
    } catch (e) { toast(e.message, true); }
    btn.disabled = false; btn.textContent = 'インポート実行';
  };
}

// ---------- boot ----------
(async function boot() {
  META = await api.get('/api/meta');
  window.addEventListener('hashchange', router);
  if (!location.hash) location.hash = '#/dashboard';
  router();
})();
