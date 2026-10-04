'use strict';

const BASE = process.env.BASE || 'http://localhost:3999';
let passed = 0;
const failures = [];

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failures.push(name); console.log(`  ✗ ${name} ${detail ?? ''}`); }
}

const iso = (s) => new Date(s).toISOString();

(async () => {
  console.log('— 登记原始瓶 —');
  let r = await call('POST', '/api/bottles', { code: 'T-RAW1', sampledAt: '2026-10-02T08:00', initialMl: 100 });
  check('登记原始瓶 201', r.status === 201, JSON.stringify(r.json));

  r = await call('POST', '/api/bottles', { code: 'T-RAW1', sampledAt: '2026-10-02T08:00', initialMl: 100 });
  check('编号冲突报 409 BOTTLE_EXISTS', r.status === 409 && r.json.error.code === 'BOTTLE_EXISTS', JSON.stringify(r.json));

  r = await call('POST', '/api/bottles', { code: 'T-RAW2', sampledAt: 'not-a-time', initialMl: 10 });
  check('非法时间报 400', r.status === 400 && r.json.error.code === 'INVALID_TIME');

  r = await call('POST', '/api/bottles', { code: 'T-RAW3', sampledAt: '2026-10-02T08:00', initialMl: 0 });
  check('体积非正整数报 400', r.status === 400);

  console.log('— 提交操作 —');
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP1', target: 'T-MIX1', operatedAt: iso('2026-10-02T10:00'),
    sources: [{ source: 'T-RAW1', amountMl: 30 }, { source: 'MIX-C', amountMl: 20 }],
  });
  check('正常混样 201，目标体积=50', r.status === 201 && r.json.operation.targetMl === 50, JSON.stringify(r.json));

  // 同一操作号相同载荷重复提交 → 幂等，不重复扣量
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP1', target: 'T-MIX1', operatedAt: iso('2026-10-02T10:00'),
    sources: [{ source: 'MIX-C', amountMl: 20 }, { source: 'T-RAW1', amountMl: 30 }],
  });
  check('重复操作号同载荷 → 200 幂等', r.status === 200 && r.json.idempotent === true, JSON.stringify(r.json));

  r = await call('GET', '/api/bottles/T-RAW1/lineage');
  check('幂等后未重复扣量(T-RAW1=70)', r.status === 200);
  const b1 = (await call('GET', '/api/bottles')).json.bottles.find((x) => x.code === 'T-RAW1');
  check('T-RAW1 余量 70', b1.currentMl === 70, `got ${b1.currentMl}`);

  // 同一操作号不同载荷 → 拒绝
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP1', target: 'T-MIX1', operatedAt: iso('2026-10-02T10:00'),
    sources: [{ source: 'T-RAW1', amountMl: 99 }],
  });
  check('重复操作号异载荷 → 409 OP_NO_CONFLICT', r.status === 409 && r.json.error.code === 'OP_NO_CONFLICT', JSON.stringify(r.json));

  // 来源不存在
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP2', target: 'T-MIX2', operatedAt: iso('2026-10-02T11:00'),
    sources: [{ source: 'GHOST', amountMl: 5 }],
  });
  check('来源不存在 → 422 SOURCE_NOT_FOUND', r.status === 422 && r.json.error.conflicts.some((c) => c.code === 'SOURCE_NOT_FOUND'), JSON.stringify(r.json));

  // 来源重复
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP3', target: 'T-MIX3', operatedAt: iso('2026-10-02T11:00'),
    sources: [{ source: 'T-RAW1', amountMl: 5 }, { source: 'T-RAW1', amountMl: 3 }],
  });
  check('来源重复 → 422 DUPLICATE_SOURCE', r.status === 422 && r.json.error.conflicts.some((c) => c.code === 'DUPLICATE_SOURCE'));

  // 超用
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP4', target: 'T-MIX4', operatedAt: iso('2026-10-02T11:30'),
    sources: [{ source: 'T-RAW1', amountMl: 1000 }],
  });
  check('超用 → 422 OVERDRAFT 且指出缺口', r.status === 422 &&
    r.json.error.conflicts.some((c) => c.code === 'OVERDRAFT' && c.conflict.availableMl === 70 && c.conflict.shortfallMl === 930),
    JSON.stringify(r.json));

  // 操作时间早于来源采样时间
  r = await call('POST', '/api/bottles', { code: 'T-LATE', sampledAt: '2026-10-03T08:00', initialMl: 50 });
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP5', target: 'T-MIX5', operatedAt: iso('2026-10-02T09:00'),
    sources: [{ source: 'T-LATE', amountMl: 5 }],
  });
  check('操作时间早于来源采样时间 → 422 OP_BEFORE_BIRTH',
    r.status === 422 && r.json.error.conflicts.some((c) => c.code === 'OP_BEFORE_BIRTH'), JSON.stringify(r.json));

  // 目标编号冲突
  r = await call('POST', '/api/operations', {
    opNo: 'T-OP6', target: 'T-RAW1', operatedAt: iso('2026-10-02T12:00'),
    sources: [{ source: 'T-LATE', amountMl: 5 }],
  });
  check('目标瓶编号冲突 → 422 TARGET_EXISTS',
    r.status === 422 && r.json.error.conflicts.some((c) => c.code === 'TARGET_EXISTS'));

  console.log('— 更正历史操作 —');
  // 准备链条：T-LATE(50) --T-C1 10--> T-D1；T-D1 --T-C2 10--> T-D2
  r = await call('POST', '/api/operations', {
    opNo: 'T-C1', target: 'T-D1', operatedAt: iso('2026-10-03T10:00'),
    sources: [{ source: 'T-LATE', amountMl: 10 }],
  });
  check('建链 T-C1', r.status === 201, JSON.stringify(r.json));
  r = await call('POST', '/api/operations', {
    opNo: 'T-C2', target: 'T-D2', operatedAt: iso('2026-10-03T11:00'),
    sources: [{ source: 'T-D1', amountMl: 10 }],
  });
  check('建链 T-C2', r.status === 201, JSON.stringify(r.json));

  // 把 T-C1 从 10 改为 5：T-D1=5，但 T-C2 仍取 10 → 超用，整次拒绝
  r = await call('PUT', '/api/operations/T-C1', {
    target: 'T-D1', operatedAt: iso('2026-10-03T10:00'),
    sources: [{ source: 'T-LATE', amountMl: 5 }],
  });
  check('更正致后续超用 → 422 CORRECTION_REJECTED', r.status === 422 && r.json.error.code === 'CORRECTION_REJECTED', JSON.stringify(r.json));
  const conflictOps = (r.json.error.conflicts || []).map((c) => c.opNo);
  check('指出冲突记录 T-C2 与来源 T-D1',
    r.json.error.conflicts?.some((c) => c.code === 'OVERDRAFT' && c.opNo === 'T-C2' && c.source === 'T-D1' && c.conflict.availableMl === 5),
    JSON.stringify(r.json.error.conflicts));

  // 原数据保持不变
  const unchanged = (await call('GET', '/api/operations')).json.operations.find((o) => o.opNo === 'T-C1');
  check('拒绝后原数据不变(T-C1 仍取 10)', unchanged.sources[0].amountMl === 10);

  // 合法更正：先把 T-C2 改为 5，再把 T-C1 改为 5
  r = await call('PUT', '/api/operations/T-C2', {
    target: 'T-D2', operatedAt: iso('2026-10-03T11:00'),
    sources: [{ source: 'T-D1', amountMl: 5 }],
  });
  check('先更正 T-C2 为 5', r.status === 200, JSON.stringify(r.json));
  r = await call('PUT', '/api/operations/T-C1', {
    target: 'T-D1', operatedAt: iso('2026-10-03T10:00'),
    sources: [{ source: 'T-LATE', amountMl: 5 }],
  });
  check('再更正 T-C1 为 5 成功并重算', r.status === 200, JSON.stringify(r.json));
  const bs = Object.fromEntries((await call('GET', '/api/bottles')).json.bottles.map((b) => [b.code, b]));
  check('重算后 T-LATE=45, T-D1=0, T-D2=5（体积守恒 50）',
    bs['T-LATE'].currentMl === 45 && bs['T-D1'].currentMl === 0 && bs['T-D2'].currentMl === 5,
    JSON.stringify({ l: bs['T-LATE']?.currentMl, d1: bs['T-D1']?.currentMl, d2: bs['T-D2']?.currentMl }));

  console.log('— 谱系 —');
  r = await call('GET', '/api/bottles/T-D2/lineage');
  const flat = JSON.stringify(r.json.lineage);
  check('谱系含 T-D1 与 T-LATE', flat.includes('T-D1') && flat.includes('T-LATE'));
  check('谱系标注经由的操作号 T-C1/T-C2', flat.includes('T-C1') && flat.includes('T-C2'));
  r = await call('GET', '/api/bottles/NOPE/lineage');
  check('未知瓶谱系 404', r.status === 404);

  console.log(`\n结果: ${passed} 通过, ${failures.length} 失败`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
