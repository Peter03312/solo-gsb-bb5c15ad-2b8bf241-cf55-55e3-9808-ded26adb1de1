'use strict';

const { simulate } = require('./simulate');

/**
 * 仅在数据库全新（bottles 表为空）时注入演示数据。
 * 通过纯函数模拟引擎校验后在单事务内写入，保证自带数据本身满足体积守恒。
 */
function seedDemoData(db) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM bottles').get().n;
  if (count > 0) return false;

  const bottles = [
    { code: 'RAW-001', sampled_at: '2026-10-01T01:00:00.000Z', initial_ml: 1000 },
    { code: 'RAW-002', sampled_at: '2026-10-01T02:00:00.000Z', initial_ml: 800 },
    { code: 'RAW-003', sampled_at: '2026-10-01T03:00:00.000Z', initial_ml: 500 },
  ];
  const ops = [
    {
      op_no: 'OP-20261001-01',
      target_code: 'MIX-A',
      operated_at: '2026-10-01T05:00:00.000Z',
      sources: [
        { source_code: 'RAW-001', amount_ml: 300 },
        { source_code: 'RAW-002', amount_ml: 200 },
      ],
    },
    {
      op_no: 'OP-20261001-02',
      target_code: 'ALI-B',
      operated_at: '2026-10-01T06:00:00.000Z',
      sources: [
        { source_code: 'RAW-001', amount_ml: 150 },
        { source_code: 'MIX-A', amount_ml: 100 },
      ],
    },
    {
      op_no: 'OP-20261001-03',
      target_code: 'MIX-C',
      operated_at: '2026-10-01T08:00:00.000Z',
      sources: [
        { source_code: 'MIX-A', amount_ml: 250 },
        { source_code: 'RAW-003', amount_ml: 120 },
        { source_code: 'ALI-B', amount_ml: 50 },
      ],
    },
  ];

  const { errors, births, initialVol } = simulate(bottles, ops);
  if (errors.length) throw new Error(`演示数据自校验失败: ${JSON.stringify(errors)}`);

  const txn = db.transaction(() => {
    const insB = db.prepare(`INSERT INTO bottles (code, sampled_at, initial_ml, is_derived)
                             VALUES (?, ?, ?, 0)`);
    for (const b of bottles) insB.run(b.code, b.sampled_at, b.initial_ml);

    const insOp = db.prepare(`INSERT INTO operations (op_no, target_code, operated_at)
                              VALUES (?, ?, ?)`);
    const insS = db.prepare(`INSERT INTO op_sources (op_id, source_code, amount_ml, seq)
                             VALUES (?, ?, ?, ?)`);
    const insD = db.prepare(`INSERT INTO bottles (code, sampled_at, initial_ml, is_derived, created_by_op)
                             VALUES (?, ?, ?, 1, ?)`);
    for (const op of ops) {
      const info = insOp.run(op.op_no, op.target_code, op.operated_at);
      op.sources.forEach((s, i) => insS.run(info.lastInsertRowid, s.source_code, s.amount_ml, i));
      insD.run(op.target_code, births[op.target_code], initialVol[op.target_code], op.op_no);
    }
  });
  txn();
  console.log('已初始化演示数据：3 个原始瓶、3 次示例操作（可通过 SEED_DEMO=false 关闭）');
  return true;
}

module.exports = { seedDemoData };
