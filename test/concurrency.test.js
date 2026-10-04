'use strict';

// 并发争用测试：N 个并发操作同时从同一瓶取用，总量超过容量
const BASE = process.env.BASE || 'http://localhost:3997';

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

(async () => {
  // 准备 1 个 100ml 原始瓶
  await call('POST', '/api/bottles', {
    code: 'CC-SRC', sampledAt: new Date('2026-09-01T00:00Z').toISOString(), initialMl: 100,
  });

  const N = 20;
  const each = 8; // 总需求 160 > 100，只能有部分成功
  const time = new Date('2026-09-02T00:00Z').toISOString();

  // 1) 各有唯一操作号的并发扣量
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call('POST', '/api/operations', {
        opNo: `CC-OP-${String(i).padStart(2, '0')}`,
        target: `CC-T-${String(i).padStart(2, '0')}`,
        operatedAt: time,
        sources: [{ source: 'CC-SRC', amountMl: each }],
      })),
  );
  const accepted = results.filter((r) => r.status === 201).length;
  const rejected = results.filter((r) => r.status === 422).length;

  const { bottles } = (await call('GET', '/api/bottles')).json;
  const src = bottles.find((b) => b.code === 'CC-SRC');
  const derivedTotal = bottles
    .filter((b) => b.kind === 'derived' && b.code.startsWith('CC-T-'))
    .reduce((s, b) => s + b.initialMl, 0);

  console.log(`唯一号并发: 成功 ${accepted}, 拒绝 ${rejected}, 来源余量 ${src.currentMl}, 派生瓶总量 ${derivedTotal}`);
  const ok1 = accepted === 12 && rejected === 8;
  const ok2 = src.currentMl === 100 - accepted * each && src.currentMl >= 0;
  const ok3 = derivedTotal === accepted * each && src.currentMl + derivedTotal === 100;
  console.log(ok1 ? '  ✓ 恰好 12 笔成功 / 8 笔超用拒绝' : '  ✗ 成功/拒绝数量异常');
  console.log(ok2 ? `  ✓ 来源余量精确为 ${src.currentMl}，未超用` : '  ✗ 来源余量异常');
  console.log(ok3 ? '  ✓ 体积守恒：来源余量 + 派生瓶总量 = 100' : '  ✗ 体积不守恒');

  // 2) 同一操作号并发重复提交（相同载荷），只能成功一次且只扣一次
  const before = src.currentMl;
  const dup = await Promise.all(
    Array.from({ length: 6 }, () =>
      call('POST', '/api/operations', {
        opNo: 'CC-DUP', target: 'CC-DUP-T', operatedAt: time,
        sources: [{ source: 'CC-SRC', amountMl: 3 }],
      })),
  );
  const created = dup.filter((r) => r.status === 201).length;
  const idempotent = dup.filter((r) => r.status === 200).length;
  const { bottles: b2 } = (await call('GET', '/api/bottles')).json;
  const after = b2.find((b) => b.code === 'CC-SRC').currentMl;
  console.log(`\n同号并发: 201=${created}, 200幂等=${idempotent}, 余量 ${before} → ${after}`);
  const ok4 = created === 1 && idempotent === 5;
  const ok5 = before - after === 3;
  console.log(ok4 ? '  ✓ 同操作号并发仅 1 笔创建，其余幂等' : '  ✗ 同操作号并发控制异常');
  console.log(ok5 ? '  ✓ 同操作号重复提交未重复扣量（仅扣 3ml）' : '  ✗ 发生重复扣量');

  const ok = ok1 && ok2 && ok3 && ok4 && ok5;
  console.log(ok ? '\n并发测试全部通过' : '\n并发测试存在失败');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
