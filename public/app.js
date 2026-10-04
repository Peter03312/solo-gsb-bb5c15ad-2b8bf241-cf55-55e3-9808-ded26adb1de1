'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- 工具 ----------

function localDateTimeInput(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return Number.isNaN(d) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(message, ok = true) {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${ok ? 'toast-success' : 'toast-error'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ok ? 3500 : 12000);
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败 (${res.status})`);
    err.payload = data.error;
    throw err;
  }
  return data;
}

function formatError(err) {
  const p = err.payload;
  if (!p) return err.message;
  if (Array.isArray(p.conflicts) && p.conflicts.length) {
    const lines = p.conflicts.map((c) => {
      let detail = '';
      if (c.code === 'OVERDRAFT' && c.conflict) {
        detail = ` — 需 ${c.conflict.requestedMl} ml，该时点仅余 ${c.conflict.availableMl} ml，缺口 ${c.conflict.shortfallMl} ml`;
      }
      if (c.code === 'OP_BEFORE_BIRTH' && c.conflict) {
        detail = ` — 操作时间 ${fmtTime(c.conflict.operatedAt)} 早于来源创建时间 ${fmtTime(c.conflict.sourceBornAt)}`;
      }
      const op = c.opNo ? `[${c.opNo}] ` : '';
      return `• ${op}${c.message}${detail}`;
    });
    return `${p.message}\n${lines.join('\n')}`;
  }
  return p.message || err.message;
}

// ---------- 标签页 ----------

$$('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.classList.remove('active'));
    $$('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ---------- 数据加载 ----------

let bottleCache = [];

async function loadBottles() {
  const { bottles } = await api('GET', '/api/bottles');
  bottleCache = bottles;
  const tbody = $('#bottlesTable tbody');
  tbody.innerHTML = bottles.map((b) => `
    <tr>
      <td><strong>${esc(b.code)}</strong></td>
      <td><span class="tag ${b.kind === 'original' ? 'tag-original' : 'tag-derived'}">
        ${b.kind === 'original' ? '原始瓶' : '派生瓶'}</span></td>
      <td>${fmtTime(b.sampledAt)}</td>
      <td class="num">${b.initialMl}</td>
      <td class="num">${b.outMl}</td>
      <td class="num ${b.currentMl <= 0 ? 'low' : ''}">${b.currentMl}</td>
      <td class="op-meta">${b.createdByOp ? esc(b.createdByOp) : '—'}</td>
      <td><button class="btn btn-mini" data-lineage="${esc(b.code)}">谱系</button></td>
    </tr>`).join('');

  $('#lineageCode').innerHTML = bottles.map((b) => `<option value="${esc(b.code)}">${esc(b.code)}</option>`).join('');
  return bottles;
}

async function loadOperations() {
  const { operations } = await api('GET', '/api/operations');
  $('#opsList').innerHTML = operations.map((op) => `
    <div class="op-card" data-op='${esc(JSON.stringify(op))}'>
      <div class="op-head">
        <span class="op-no">${esc(op.opNo)}</span>
        <span class="muted">${fmtTime(op.operatedAt)}</span>
        <button class="btn btn-mini js-edit">更正</button>
      </div>
      <div class="op-flow">
        ${op.sources.map((s) => `<span class="chip">${esc(s.source)} −${s.amountMl}ml</span>`).join('')}
        <span class="flow-arrow">➜</span>
        <strong>${esc(op.target)}</strong>（${op.targetMl} ml）
      </div>
      <div class="op-meta">目标体积由取用量自动求和；记录创建于 ${fmtTime(op.createdAt)}</div>
    </div>`).join('') || '<p class="muted">暂无操作记录</p>';
}

async function refreshAll() {
  try {
    await Promise.all([loadBottles(), loadOperations()]);
    $('#health').textContent = '已连接';
    $('#health').className = 'badge badge-ok';
  } catch (err) {
    $('#health').textContent = '连接失败';
    $('#health').className = 'badge badge-err';
    toast(formatError(err), false);
  }
}

// ---------- 谱系 ----------

function renderTree(node) {
  const kindTag = node.kind === 'original'
    ? '<span class="tag tag-original">原始瓶</span>'
    : '<span class="tag tag-derived">派生瓶</span>';
  const parentEdges = node.parents.map((p) => `
    <li>
      <div class="node">
        ${renderTree(p)}
      </div>
      <div class="edge">└ 经操作 ${esc(p.viaOp)}（${fmtTime(p.operatedAt)}）取用 ${p.amountMl} ml ↑</div>
    </li>`).join('');
  return `<div class="node-inner"><strong>${esc(node.bottle)}</strong> ${kindTag}
      <span class="muted">${node.kind === 'original' ? '采样于' : '生成于'} ${fmtTime(node.sampledAt)}</span></div>
    ${node.parents.length ? `<ul>${parentEdges}</ul>` : ''}`;
}

async function showLineage(code) {
  if (!code) return;
  const { lineage } = await api('GET', `/api/bottles/${encodeURIComponent(code)}/lineage`);
  $('#lineageTitle').textContent = `— ${code}`;
  const box = $('#lineageTree');
  box.innerHTML = `<div class="tree"><div class="root">${renderTree(lineage)}</div></div>`;
  $('#lineageBox').classList.remove('hidden');
}

$('#showLineage').addEventListener('click', () => showLineage($('#lineageCode').value));
$('#bottlesTable').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lineage]');
  if (btn) {
    $('#lineageCode').value = btn.dataset.lineage;
    showLineage(btn.dataset.lineage);
  }
});

// ---------- 登记原始瓶 ----------

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await api('POST', '/api/bottles', {
      code: f.code.value,
      sampledAt: f.sampledAt.value,
      initialMl: Number(f.initialMl.value),
    });
    toast(`原始瓶 ${f.code.value.trim()} 登记成功`);
    f.reset();
    f.sampledAt.value = localDateTimeInput();
    await refreshAll();
  } catch (err) {
    toast(formatError(err), false);
  }
});

// ---------- 操作表单：动态来源行 ----------

function sourceRow(container, code = '', amount = '') {
  const row = document.createElement('div');
  row.className = 'source-row';
  row.innerHTML = `
    <input list="bottleDatalist" class="src-code" placeholder="来源瓶编号" required value="${esc(code)}" />
    <input class="src-amount" type="number" min="1" step="1" placeholder="取用量 ml" required value="${amount}" />
    <button type="button" class="btn-danger-mini js-del">删</button>`;
  container.appendChild(row);
  return row;
}
function ensureDatalist() {
  if (!$('#bottleDatalist')) {
    document.body.insertAdjacentHTML('beforeend', '<datalist id="bottleDatalist"></datalist>');
  }
  $('#bottleDatalist').innerHTML = bottleCache.map((b) => `<option value="${esc(b.code)}">`).join('');
}
function readSources(container) {
  return $$('.source-row', container).map((row) => ({
    source: $('.src-code', row).value.trim(),
    amountMl: Number($('.src-amount', row).value),
  })).filter((s) => s.source);
}
function bindSourceRows(rowsContainer, addBtn, preview) {
  addBtn.addEventListener('click', () => sourceRow(rowsContainer));
  rowsContainer.addEventListener('click', (e) => {
    if (e.target.classList.contains('js-del')) {
      if ($$('.source-row', rowsContainer).length > 1) e.target.closest('.source-row').remove();
      update();
    }
  });
  rowsContainer.addEventListener('input', update);
  function update() {
    const total = readSources(rowsContainer).reduce((s, x) => s + (Number.isInteger(x.amountMl) && x.amountMl > 0 ? x.amountMl : 0), 0);
    preview.textContent = `${total} ml`;
  }
  return update;
}

const updateOpPreview = bindSourceRows($('#sourceRows'), $('#addSource'), $('#targetPreview'));

$('#opForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    opNo: f.opNo.value,
    target: f.target.value,
    operatedAt: f.operatedAt.value,
    sources: readSources($('#sourceRows')),
  };
  try {
    const data = await api('POST', '/api/operations', body);
    toast(data.idempotent
      ? `操作号 ${body.opNo.trim()} 为重复提交（内容一致），未重复扣量`
      : `操作 ${body.opNo.trim()} 提交成功，生成目标瓶 ${body.target.trim()}（${data.operation.targetMl} ml）`);
    f.reset();
    $('#sourceRows').innerHTML = '';
    sourceRow($('#sourceRows'));
    updateOpPreview();
    await refreshAll();
  } catch (err) {
    toast(formatError(err), false);
  }
});

// ---------- 更正 ----------

const modal = $('#editModal');
let editUpdate = null;

$('#opsList').addEventListener('click', (e) => {
  const btn = e.target.closest('.js-edit');
  if (!btn) return;
  const op = JSON.parse(btn.closest('.op-card').dataset.op);
  openEdit(op);
});

function openEdit(op) {
  $('#editOpNo').textContent = op.opNo;
  const f = $('#editForm');
  f.target.value = op.target;
  f.operatedAt.value = localDateTimeInput(new Date(op.operatedAt));
  const rows = $('#editSourceRows');
  rows.innerHTML = '';
  op.sources.forEach((s) => sourceRow(rows, s.source, s.amountMl));
  editUpdate();
  modal.classList.remove('hidden');
}
editUpdate = bindSourceRows($('#editSourceRows'), $('#editAddSource'), $('#editPreview'));

$('#editCancel').addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

$('#editForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const opNo = $('#editOpNo').textContent;
  const body = {
    target: f.target.value,
    operatedAt: f.operatedAt.value,
    sources: readSources($('#editSourceRows')),
  };
  try {
    const data = await api('PUT', `/api/operations/${encodeURIComponent(opNo)}`, body);
    toast(data.notice || '更正成功');
    modal.classList.add('hidden');
    await refreshAll();
    $('#lineageBox').classList.add('hidden');
  } catch (err) {
    toast(formatError(err), false);
  }
});

// ---------- 初始化 ----------

$('#refreshAll').addEventListener('click', refreshAll);
$('#tab-operate').addEventListener('click', ensureDatalist);
document.addEventListener('click', (e) => {
  if (e.target.closest('#tab-operate') || e.target.closest('#tab-register')) ensureDatalist();
});

(function init() {
  $('#registerForm').elements.sampledAt.value = localDateTimeInput();
  $('#opForm').elements.operatedAt.value = localDateTimeInput();
  sourceRow($('#sourceRows'));
  updateOpPreview();
  refreshAll();
})();
