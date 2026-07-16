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
let META = null; // { nutrients, today }
const app = document.getElementById('app');

// ---------- utils ----------
const $ = (sel, el = document) => el.querySelector(sel);
const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function num(v, d = 1) { if (v === null || v === undefined || v === '') return '—'; const n = Number(v); return Number.isInteger(n) ? String(n) : n.toFixed(d); }
// 「今日」はブラウザのローカル日付で判定する。サーバ(Vercel)はUTCで動くため
// META.today だと JST 早朝に前日になってしまう（時刻はクライアント基準なので日付も揃える）。
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
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

// 画像ファイルをブラウザ側で縮小・JPEG圧縮し data URL を返す。
// サーバ(Vercel)はディスク保存不可のため画像はDBに data URL として保存する。
// 長辺 maxDim に収まるよう縮小し、アップロードとDBを軽量に保つ（概ね100〜300KB）。
function downscaleImage(file, maxDim = 1024, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.onload = () => {
        let { width, height } = img;
        if (width >= height && width > maxDim) { height = Math.round(height * maxDim / width); width = maxDim; }
        else if (height > width && height > maxDim) { width = Math.round(width * maxDim / height); height = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

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
  // 履歴の日別サブ画面: /history/YYYY-MM-DD（内訳）と /history/YYYY-MM-DD/matrix（栄養素×食材の行列）。
  const matrixMatch = path.match(/^\/history\/(\d{4}-\d{2}-\d{2})\/matrix\/?$/);
  const dayMatch = path.match(/^\/history\/(\d{4}-\d{2}-\d{2})\/?$/);
  document.querySelectorAll('.nav a').forEach((a) => {
    const href = a.getAttribute('href');
    a.classList.toggle('active', href === '#' + path || ((!!dayMatch || !!matrixMatch) && href === '#/history'));
  });
  app.innerHTML = '<div class="empty">読み込み中…</div>';
  try {
    if (matrixMatch) await viewHistoryMatrix(matrixMatch[1]);
    else if (dayMatch) await viewHistoryDay(dayMatch[1]);
    else { const view = routes[path] || viewDashboard; await view(new URLSearchParams(hash.split('?')[1] || '')); }
  }
  catch (e) { app.innerHTML = `<div class="card"><p class="status-over">読み込みエラー: ${esc(e.message)}</p></div>`; }
}

// ======================================================
// ダッシュボード
// ======================================================
async function viewDashboard() {
  const date = todayStr();
  const [d, bodyRecs, energyRecs] = await Promise.all([
    api.get(`/api/dashboard?date=${date}`),
    api.get('/api/body'),
    api.get('/api/energy'),
  ]);

  // 過去1週間（d.week は date を末尾とする直近7日）を、体重・体脂肪率・カロリー収支に整形。
  const bodyMap = {}; for (const r of bodyRecs) bodyMap[r.date] = r;
  const energyMap = {}; for (const r of energyRecs) energyMap[r.date] = r;
  const week = d.week.days.map((x) => {
    const b = bodyMap[x.date] || {};
    const e = energyMap[x.date];
    const burned = e && e.burnedCalories != null ? e.burnedCalories : null;
    return {
      date: x.date,
      weight: b.weight != null ? b.weight : null,
      bodyFat: b.bodyFat != null ? b.bodyFat : null,
      net: burned != null ? x.total.calories.value - burned : null,
    };
  });

  app.innerHTML = `
    <h1>ホーム / ダッシュボード <span class="muted small">(${date})</span></h1>

    <div class="card"><h2>1週間の推移 <span class="muted small">(${d.week.start} 〜 ${d.week.end})</span></h2>
      <div class="chart-title">体重（棒）・体脂肪率（棒）</div>
      <div class="legend"><span><i style="background:var(--brand)"></i>体重 (kg)</span><span><i style="background:var(--accent)"></i>体脂肪率 (%)</span></div>
      ${weekBodyChart(week)}
      <div class="chart-title" style="margin-top:22px">摂取カロリー − 消費カロリー（折れ線）</div>
      ${netLineChart(week)}
      <p class="small muted">プラス＝摂取が消費を上回る／マイナス＝消費が上回る。消費カロリー未入力の日は線に表示されません。体重・体脂肪率は各系列内の増減が見えるよう縦軸を拡大しています。</p>
    </div>
  `;
}

// 過去1週間の体重・体脂肪率を、日ごとに細い縦棒2本で描く。
// 体重(60kg前後)と体脂肪率(十数%)は絶対値が離れるため、各系列を自分の最小〜最大で
// スケールし直し（0基準ではなく増減が見える拡大表示）、色で区別する。
function weekBodyChart(week) {
  const H = 130; // 棒エリアの高さ(px)
  if (!week.some((w) => w.weight != null || w.bodyFat != null)) {
    return '<p class="small muted">この期間の体重・体脂肪率の記録がありません（<a href="#/records">記録</a>から入力）。</p>';
  }
  const barPx = (series, v) => {
    const nums = series.filter((x) => x != null);
    if (v == null || !nums.length) return 0;
    const mn = Math.min(...nums), mx = Math.max(...nums);
    if (mx === mn) return Math.round(H * 0.55);
    return Math.round(((v - mn) / (mx - mn)) * (H - 24)) + 20; // 20px〜H に写像
  };
  const wts = week.map((w) => w.weight), bfs = week.map((w) => w.bodyFat);
  return `<div class="wk-bars">
    ${week.map((w) => `<div class="wk-day">
      <div class="wk-col" style="height:${H}px">
        <div class="wk-bar" style="height:${barPx(wts, w.weight)}px;background:var(--brand)" title="体重 ${w.weight != null ? num(w.weight) + 'kg' : '—'}"></div>
        <div class="wk-bar" style="height:${barPx(bfs, w.bodyFat)}px;background:var(--accent)" title="体脂肪率 ${w.bodyFat != null ? num(w.bodyFat) + '%' : '—'}"></div>
      </div>
      <div class="wk-cap">${w.date.slice(5)}</div>
    </div>`).join('')}
  </div>`;
}

// 過去1週間の「摂取カロリー − 消費カロリー」を折れ線で描く（0を基準線に含める）。
// プラス（摂取オーバー）は赤、マイナス（消費が上回る）は緑の点で示す。
function netLineChart(week) {
  const pts = week.map((w, i) => ({ i, date: w.date, val: w.net }));
  const vals = pts.filter((p) => p.val != null).map((p) => p.val);
  if (!vals.length) return '<p class="small muted">摂取・消費カロリーがそろった日がありません（消費カロリーは<a href="#/records">記録</a>から入力）。</p>';
  const W = 720, H = 220, padX = 46, padT = 22, padB = 34;
  let mn = Math.min(0, ...vals), mx = Math.max(0, ...vals);
  if (mn === mx) { mx += 1; mn -= 1; }
  const n = week.length;
  const X = (i) => padX + (n === 1 ? (W - 2 * padX) / 2 : (i / (n - 1)) * (W - 2 * padX));
  const Y = (v) => padT + (1 - (v - mn) / (mx - mn)) * (H - padT - padB);
  const y0 = Y(0);
  const seg = pts.filter((p) => p.val != null);
  const poly = seg.map((p) => `${X(p.i).toFixed(1)},${Y(p.val).toFixed(1)}`).join(' ');
  const dots = seg.map((p) => {
    const col = p.val > 0 ? 'var(--danger)' : 'var(--brand)';
    return `<circle cx="${X(p.i).toFixed(1)}" cy="${Y(p.val).toFixed(1)}" r="3.5" fill="${col}"></circle>
      <text x="${X(p.i).toFixed(1)}" y="${(Y(p.val) - 8).toFixed(1)}" text-anchor="middle" font-size="10" fill="var(--ink)">${p.val > 0 ? '+' : ''}${num(p.val, 0)}</text>`;
  }).join('');
  const caps = pts.map((p) => `<text x="${X(p.i).toFixed(1)}" y="${H - 12}" text-anchor="middle" font-size="10" fill="var(--muted)">${p.date.slice(5)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;overflow:visible">
    <line x1="${padX}" y1="${y0.toFixed(1)}" x2="${W - padX}" y2="${y0.toFixed(1)}" stroke="var(--line)" stroke-dasharray="4 4"></line>
    <text x="${padX - 8}" y="${(y0 + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">0</text>
    <text x="${padX - 8}" y="${padT + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${num(mx, 0)}</text>
    <text x="${padX - 8}" y="${(H - padB + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${num(mn, 0)}</text>
    <polyline points="${poly}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>
    ${dots}
    ${caps}
  </svg>`;
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
      <label>写真（任意・撮影またはファイル選択）</label>
      <div class="row" style="align-items:center">
        <input type="file" id="f-photo" accept="image/*" capture="environment">
        <div id="f-photo-preview"></div>
      </div>
      <p class="small muted" style="margin-top:4px">写真を付けると食材名は任意です（未入力なら「名称未設定」で登録され、あとで<a href="#/history">履歴</a>の編集で名前を付けたり写真を削除できます）。</p>
      <label>メモ</label>
      <input type="text" id="f-memo" placeholder="任意">
      <div class="row" style="margin-top:12px">
        <button id="btn-add">記録する</button>
        <button class="ghost" id="btn-copy">前日の食事をこの日にコピー</button>
      </div>
      <p class="small muted" style="margin-top:10px">記録した内容は<a href="#/history">履歴</a>で確認・編集・削除できます。</p>
    </div>
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
    } catch (e) { toast(e.message, true); }
  }));

  // --- photo（撮影/選択したらブラウザ側で縮小して保持）---
  let photoData = null;
  const clearPhoto = () => { photoData = null; $('#f-photo').value = ''; $('#f-photo-preview').innerHTML = ''; };
  $('#f-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) { clearPhoto(); return; }
    try {
      photoData = await downscaleImage(file);
      $('#f-photo-preview').innerHTML = `<img src="${photoData}" style="max-height:72px;border-radius:8px;margin-left:8px"> <button type="button" class="ghost sm" id="f-photo-clear">写真を外す</button>`;
      $('#f-photo-clear').onclick = clearPhoto;
    } catch (err) { toast(err.message || '画像の読み込みに失敗しました', true); clearPhoto(); }
  });

  // --- add ---
  $('#btn-add').addEventListener('click', addMeal);
  $('#f-grams').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMeal(); });

  async function addMeal() {
    const foodName = foodInput.value.trim();
    const grams = $('#f-grams').value;
    if (grams === '') { toast('グラム数を入力してください', true); return; }
    if (!foodName && !photoData) { toast('食材名を入力するか写真を撮影してください', true); return; }
    const payload = {
      date: $('#f-date').value, time: $('#f-time').value,
      foodId: foodId.value || null, foodName, grams, memo: $('#f-memo').value,
      photo: photoData,
    };
    try {
      const r = await api.post('/api/meals', payload);
      toast('記録しました');
      foodInput.value = ''; foodId.value = ''; $('#f-grams').value = ''; $('#f-memo').value = '';
      clearPhoto();
      foodInput.focus();
      // 写真なしで名前を打った場合のみ、未登録食材の登録を促す（写真だけの記録は促さない）。
      if (r.unregistered && foodName) promptRegister(foodName);
    } catch (e) { toast(e.message, true); }
  }

  // --- copy ---
  $('#btn-copy').addEventListener('click', async () => {
    const to = $('#f-date').value; const from = addDays(to, -1);
    if (!confirm(`${from} の食事を ${to} にコピーします。よろしいですか？`)) return;
    try { const r = await api.post('/api/meals/copy', { from, to }); toast(`${r.copied} 件コピーしました`); }
    catch (e) { toast(e.message, true); }
  });
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
// 履歴タブ = 栄養素の不足・過剰チェック（日付選択式）。
// 「内訳チェック」で選択中の日の食事・サプリ記録一覧（#/history/DATE）へ遷移する。
async function viewHistory() {
  const date = todayStr();
  const g = (await api.get('/api/goals')) || {};

  // 指定日の集計 total に対して不足・過剰を判定するテーブル行を返す。
  const checkRows = (total) => META.nutrients.map((n) => {
    const o = total[n.key]; if (!o) return '';
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

  const day = await api.get(`/api/nutrition/daily?date=${date}`);

  app.innerHTML = `
    <h1>履歴</h1>
    <div class="card">
      <div class="flex-between">
        <h2>栄養素の不足・過剰チェック
          <a href="#/history/${date}/" id="breakdown-link" class="pill" style="cursor:pointer">内訳チェック →</a>
          <a href="#/history/${date}/matrix" id="matrix-link" class="pill" style="cursor:pointer">行列生成 →</a>
        </h2>
        <div><label class="small muted">日付 </label><input type="date" id="check-date" value="${date}" max="${date}"></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>栄養素</th><th class="num">摂取量</th><th class="num">目安</th><th>判定</th></tr></thead><tbody id="check-body">${checkRows(day.total)}</tbody></table></div>
      <p class="small muted">選択した日の摂取量を目安（目標設定値または一般的な推奨量。食塩は上限）と比較します。「内訳チェック」でその日の食事・サプリの記録一覧を確認できます。</p>
    </div>
  `;

  // 日付を変えたらチェック表を取り直し、内訳チェックのリンク先もその日に更新する。
  const cd = $('#check-date');
  cd.onchange = async () => {
    $('#breakdown-link').setAttribute('href', `#/history/${cd.value}/`);
    $('#matrix-link').setAttribute('href', `#/history/${cd.value}/matrix`);
    const body = $('#check-body');
    body.innerHTML = '<tr><td colspan="4" class="muted">読み込み中…</td></tr>';
    try {
      const d2 = await api.get(`/api/nutrition/daily?date=${cd.value}`);
      body.innerHTML = checkRows(d2.total);
    } catch (e) { toast(e.message, true); }
  };
}

// 履歴の内訳: 指定日1日分の食事・サプリ記録を時系列で表示（#/history/YYYY-MM-DD）。
async function viewHistoryDay(date) {
  const [meals, suppLogs] = await Promise.all([
    api.get(`/api/meals?date=${date}`),
    api.get(`/api/supplement-logs?date=${date}`),
  ]);
  const rows = [
    ...meals.map((m) => ({ ...m, kind: 'meal' })),
    ...suppLogs.map((s) => ({ ...s, kind: 'supp' })),
  ].sort((a, b) => (a.time || '').localeCompare(b.time || ''));

  const rowHtml = (r) => r.kind === 'supp' ? `<tr>
        <td>${esc(r.time || '')}</td>
        <td>💊 ${esc(r.supplementName)} <span class="pill supp">サプリ</span></td>
        <td class="num">${num(r.units, 0)}個</td><td class="muted small">${esc(r.memo || '')}</td>
        <td><button class="ghost sm" data-supedit="${r.id}">編集</button> <button class="ghost sm" data-supdel="${r.id}">削除</button></td>
      </tr>` : `<tr>
        <td>${esc(r.time || '')}</td>
        <td>${r.hasPhoto ? `<img src="/api/meals/${r.id}/photo" alt="写真" data-photo="${r.id}" style="height:34px;width:34px;object-fit:cover;border-radius:6px;vertical-align:middle;margin-right:6px;cursor:pointer">` : ''}${esc(r.foodName)} ${r.isUnregistered ? '<span class="pill unreg">未登録</span>' : ''}</td>
        <td class="num">${num(r.grams, 0)}g</td><td class="muted small">${esc(r.memo || '')}</td>
        <td><button class="ghost sm" data-edit="${r.id}">編集</button> <button class="ghost sm" data-del="${r.id}">削除</button></td>
      </tr>`;

  app.innerHTML = `
    <div class="flex-between"><h1>食事履歴 <span class="muted small">(${date})</span></h1><a href="#/history" class="pill">← チェックへ戻る</a></div>
    <div class="card">
      <div class="flex-between"><h2>${date}</h2><a href="#/input?date=${date}" class="pill">この日に追加</a></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>時刻</th><th>食材・サプリ</th><th class="num">量</th><th>メモ</th><th></th></tr></thead><tbody>
        ${rows.map(rowHtml).join('')}
      </tbody></table></div>` : '<div class="empty">この日の記録はありません。</div>'}
    </div>`;

  const reload = () => viewHistoryDay(date);
  // 写真サムネのクリックで拡大表示。
  app.querySelectorAll('[data-photo]').forEach((im) => im.addEventListener('click', () => {
    const node = el(`<div class="modal" style="text-align:center">
      <img src="/api/meals/${im.dataset.photo}/photo" alt="写真" style="max-width:100%;max-height:78vh;border-radius:8px">
      <div class="row" style="margin-top:12px;justify-content:center"><button class="ghost" id="ph-close">閉じる</button></div>
    </div>`);
    node.querySelector('#ph-close').onclick = closeModal;
    openModal(node);
  }));
  app.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
    openMealEditor(meals.find((x) => String(x.id) === b.dataset.edit), reload);
  }));
  app.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('この記録を削除しますか？')) return;
    await api.del(`/api/meals/${b.dataset.del}`); toast('削除しました'); reload();
  }));
  app.querySelectorAll('[data-supedit]').forEach((b) => b.addEventListener('click', () => {
    openSupplementLogEditor(suppLogs.find((x) => String(x.id) === b.dataset.supedit), reload);
  }));
  app.querySelectorAll('[data-supdel]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('このサプリ記録を削除しますか？')) return;
    await api.del(`/api/supplement-logs/${b.dataset.supdel}`); toast('削除しました'); reload();
  }));
}

// 履歴の行列: 行=栄養素 / 列=食材・サプリ。各セルにその食材が寄与した栄養量を並べ、
// どの食材がどの栄養素にどれだけ効いているかを一望する（#/history/YYYY-MM-DD/matrix）。
async function viewHistoryMatrix(date) {
  const day = await api.get(`/api/nutrition/daily?date=${date}`);
  const meals = day.meals || [];
  const supps = day.supplements || [];
  // 列 = その日の食材（食事）＋サプリ。各列はそれ自身の栄養寄与 nutrients を持つ。
  const cols = [
    ...meals.map((m) => ({ label: m.foodName, sub: `${num(m.grams, 0)}g`, nutrients: m.nutrients, unreg: m.isUnregistered })),
    ...supps.map((s) => ({ label: `💊 ${s.supplementName}`, sub: `${num(s.units, 0)}個`, nutrients: s.nutrients, supp: true })),
  ];

  // セル: 未登録で寄与量が不明なら「?」、そうでなければ数値。
  const cell = (obj) => (!obj || obj.partial)
    ? '<span class="muted" title="この食材・サプリは栄養データが未登録で寄与量が不明です">?</span>'
    : num(obj.value, 1);

  const headCols = cols.map((c) => `<th class="num">${esc(c.label)}${c.unreg ? ' <span class="pill unreg">未登録</span>' : ''}<div class="muted small" style="font-weight:normal">${esc(c.sub)}</div></th>`).join('');
  const bodyRows = META.nutrients.map((n) => {
    const cells = cols.map((c) => `<td class="num">${cell(c.nutrients[n.key])}</td>`).join('');
    const tot = day.total[n.key];
    // 目安は栄養素定義の固定値 n.ref（食塩は上限）。基準なしは「—」。
    const refCell = (n.ref != null) ? `${num(n.ref, 1)}${n.limit ? ' (上限)' : ''}` : '—';
    return `<tr><th style="text-align:left;white-space:nowrap">${n.label} <span class="muted small">${n.unit}</span></th>${cells}<td class="num"><b>${tot ? num(tot.value, 1) : '—'}</b></td><td class="num muted">${refCell}</td></tr>`;
  }).join('');

  app.innerHTML = `
    <div class="flex-between"><h1>栄養素 × 食材 行列 <span class="muted small">(${date})</span></h1><a href="#/history" class="pill">← チェックへ戻る</a></div>
    <div class="card">
      <div class="flex-between"><h2>栄養素の内訳（行列）</h2><a href="#/history/${date}/" class="pill">内訳チェック →</a></div>
      ${cols.length ? `<div class="table-wrap"><table>
        <thead><tr><th style="text-align:left">栄養素</th>${headCols}<th class="num">合計</th><th class="num">目安/日</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table></div>
      <p class="small muted">各セルは、その食材・サプリが実際の摂取量に対して寄与した栄養量です。行（横方向）を見ると、どの食材がその栄養素にどれだけ効いているか一望できます。「?」は栄養データ未登録で寄与量が不明なことを示します。合計はサプリを含む1日の摂取量、「目安/日」は成人のおおよその1日の摂取目安量（固定値・食塩は上限）です。</p>`
      : '<div class="empty">この日の記録はありません。</div>'}
    </div>`;
}

// 食事記録の編集モーダル。食材名を変えると食材マスタと突き合わせ直す（PUT側で解決）。
function openMealEditor(meal, onSaved) {
  if (!meal) return;
  let newPhoto = null; // 差し替え用に選んだ data URL（未選択なら null）
  const node = el(`<div class="modal">
    <div class="flex-between"><h2>食事を編集</h2><button class="ghost sm" id="me-close">✕</button></div>
    <div class="row">
      <div><label>日付</label><input type="date" id="me-date" value="${esc(meal.date)}"></div>
      <div><label>時刻</label><input type="time" id="me-time" value="${esc(meal.time || '')}"></div>
    </div>
    <div class="row">
      <div style="flex:2"><label>食材名</label><input type="text" id="me-food" value="${esc(meal.foodName)}"></div>
      <div><label>グラム数 (g)</label><input type="number" id="me-grams" min="0" step="1" value="${esc(meal.grams)}"></div>
    </div>
    <label>メモ</label><input type="text" id="me-memo" value="${esc(meal.memo || '')}">
    <label>写真</label>
    <div>
      ${meal.hasPhoto ? `<img src="/api/meals/${meal.id}/photo" alt="写真" style="max-height:120px;border-radius:8px;display:block">
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px"><input type="checkbox" id="me-photo-del" style="width:auto"> 写真を削除する</label>` : ''}
      <input type="file" id="me-photo-file" accept="image/*" capture="environment" style="margin-top:6px">
      <div id="me-photo-preview"></div>
      <p class="small muted" style="margin-top:4px">${meal.hasPhoto ? '新しい写真を選ぶと差し替わります。' : '写真を追加できます。'}写真がある場合、食材名は空欄でも「名称未設定」で保存されます。</p>
    </div>
    <p class="small muted" style="margin-top:8px">食材名を変更すると食材マスタと突き合わせ直します（マスタに無い名前にすると未登録扱いになります）。</p>
    <div class="row" style="margin-top:16px"><button id="me-save">更新</button><button class="ghost" id="me-cancel">キャンセル</button></div>
  </div>`);
  node.querySelector('#me-close').onclick = closeModal;
  node.querySelector('#me-cancel').onclick = closeModal;
  node.querySelector('#me-photo-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) { newPhoto = null; node.querySelector('#me-photo-preview').innerHTML = ''; return; }
    try {
      newPhoto = await downscaleImage(file);
      node.querySelector('#me-photo-preview').innerHTML = `<img src="${newPhoto}" style="max-height:100px;border-radius:8px;margin-top:6px;display:block">`;
      const del = node.querySelector('#me-photo-del'); if (del) del.checked = false;
    } catch (err) { toast(err.message || '画像の読み込みに失敗しました', true); }
  });
  node.querySelector('#me-save').onclick = async () => {
    const grams = node.querySelector('#me-grams').value;
    const delPhoto = !!node.querySelector('#me-photo-del')?.checked;
    const willHavePhoto = !delPhoto && (meal.hasPhoto || !!newPhoto);
    const foodName = node.querySelector('#me-food').value.trim() || (willHavePhoto ? '名称未設定' : '');
    if (grams === '') { toast('グラム数を入力してください', true); return; }
    if (!foodName) { toast('食材名を入力するか写真を残してください', true); return; }
    const payload = {
      date: node.querySelector('#me-date').value,
      time: node.querySelector('#me-time').value,
      foodId: null, foodName, grams, memo: node.querySelector('#me-memo').value,
    };
    if (delPhoto) payload.removePhoto = true;
    else if (newPhoto) payload.photo = newPhoto;
    try {
      await api.put(`/api/meals/${meal.id}`, payload);
      closeModal(); toast('更新しました'); onSaved && onSaved();
    } catch (e) { toast(e.message, true); }
  };
  openModal(node);
}

// サプリ記録の編集モーダル。サプリはマスタから選び直せる。
async function openSupplementLogEditor(log, onSaved) {
  if (!log) return;
  const supps = await api.get('/api/supplements');
  const options = supps.map((s) => `<option value="${s.id}" ${s.id === log.supplementId ? 'selected' : ''}>${esc(s.name)}${s.brand ? ` (${esc(s.brand)})` : ''}</option>`).join('');
  const node = el(`<div class="modal">
    <div class="flex-between"><h2>サプリ記録を編集</h2><button class="ghost sm" id="sle-close">✕</button></div>
    <div class="row">
      <div><label>日付</label><input type="date" id="sle-date" value="${esc(log.date)}"></div>
      <div><label>時刻</label><input type="time" id="sle-time" value="${esc(log.time || '')}"></div>
    </div>
    <div class="row">
      <div style="flex:2"><label>サプリ</label><select id="sle-supp">${options}</select></div>
      <div><label>個数</label><input type="number" id="sle-units" min="0" step="1" value="${esc(log.units)}"></div>
    </div>
    <label>メモ</label><input type="text" id="sle-memo" value="${esc(log.memo || '')}">
    <div class="row" style="margin-top:16px"><button id="sle-save">更新</button><button class="ghost" id="sle-cancel">キャンセル</button></div>
  </div>`);
  node.querySelector('#sle-close').onclick = closeModal;
  node.querySelector('#sle-cancel').onclick = closeModal;
  node.querySelector('#sle-save').onclick = async () => {
    const units = node.querySelector('#sle-units').value;
    if (units === '' || Number(units) < 0) { toast('個数を入力してください', true); return; }
    try {
      await api.put(`/api/supplement-logs/${log.id}`, {
        date: node.querySelector('#sle-date').value,
        time: node.querySelector('#sle-time').value,
        supplementId: node.querySelector('#sle-supp').value,
        units, memo: node.querySelector('#sle-memo').value,
      });
      closeModal(); toast('更新しました'); onSaved && onSaved();
    } catch (e) { toast(e.message, true); }
  };
  openModal(node);
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
// name を渡すと「特定の未登録食材に紐づける」モード: 食材名行なしの栄養データだけを
// 貼り付けて、その名前で登録する（スマホで分量のみ記録→後でPCでマスタ更新する動線）。
function openBulkFoodEditor(name = '') {
  const single = !!name;
  const example = single
    ? `カロリー\n約230 kcal\nタンパク質\n約15.5 g\n脂質\n約16.5 g\n…`
    : `食材名：ハンバーグ\nカロリー\n約230 kcal\nタンパク質\n約15.5 g\n脂質\n約16.5 g\n…`;
  const heading = single ? `「${esc(name)}」を貼り付けで登録` : 'まとめて貼り付け登録';
  const desc = single
    ? `未登録食材「<b>${esc(name)}</b>」の栄養データを貼り付けて登録します。<b>食材名の行は不要</b>です（栄養素名と数値の行だけ＝2行目以降を貼り付けてください）。数値は<b>100gあたり</b>として扱われ、登録すると過去の記録にも自動で反映されます。`
    : `AI等で生成した栄養データを、下の欄に貼り付けて登録します。<b>「食材名：○○」</b>で始まる区切りごとに1食材として登録され、複数食材をまとめて貼り付けできます。数値は<b>100gあたり</b>として扱われます。同名の食材は栄養素が上書き更新されます。`;
  const node = el(`<div class="modal">
    <div class="flex-between"><h2>${heading}</h2><button class="ghost sm" id="bf-close">✕</button></div>
    <p class="small muted">${desc}</p>
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
      const r = await api.post('/api/foods/bulk', single ? { name, text } : { text });
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
  app.innerHTML = `<h1>未登録食材の確認</h1>
    <div class="card">
      <p class="muted">食材マスタに存在しない食材です。登録すると過去の記録にも栄養素が反映されます。スマホ等では分量だけ記録しておき、後でこの画面から「まとめて貼り付け」（AI生成データを食材名なしで貼り付け）や「推定して登録」で栄養データを埋められます。</p>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>食材名</th><th class="num">記録回数</th><th>最終記録日</th><th></th></tr></thead><tbody>
        ${rows.map((r) => `<tr><td>${esc(r.foodName)}</td><td class="num">${r.count}</td><td>${esc(r.lastDate)}</td>
          <td><button class="sm" data-bulk="${esc(r.foodName)}">📋貼り付け</button> <button class="sm" data-llm="${esc(r.foodName)}">🤖推定して登録</button> <button class="ghost sm" data-manual="${esc(r.foodName)}">手動登録</button></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="empty">未登録食材はありません 🎉</div>'}
    </div>`;
  app.querySelectorAll('[data-bulk]').forEach((b) => b.onclick = () => openBulkFoodEditor(b.dataset.bulk));
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
  // 同じ画面のナビをタップした場合（hashchange が発火しない）でも再描画する。
  // これにより食事入力を開き直すたびに時刻が現在時刻へリセットされる。
  document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => {
    if (location.hash === a.getAttribute('href')) router();
  }));
  if (!location.hash) location.hash = '#/dashboard';
  router();
})();
