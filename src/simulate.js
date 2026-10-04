'use strict';

/**
 * 纯函数模拟引擎：给定全量瓶与全量操作（候选操作可混入其中），
 * 按“操作时间升序，同时间按行插入顺序升序”逐笔重放，计算每个瓶的实时余量，
 * 校验来源存在、来源不重复、操作时间不早于来源创建时间、任一时点不超用、
 * 目标编号不冲突。
 *
 * 返回 { errors, balances, births, initialVol }
 *  - errors:     [{ code, opNo?, source?, conflict?: {...}, message }]
 *  - balances:   { [bottleCode]: 重放结束时余量(ml) }
 *  - births:     { [bottleCode]: 创建时间 }
 *  - initialVol: { [targetCode]: 目标瓶出生时的汇入体积(ml) }
 */
function simulate(bottles, ops) {
  const errors = [];
  // 余量账本：原始瓶初始体积
  const balance = Object.create(null);
  // 瓶创建时间：原始瓶取采样时间
  const bornAt = Object.create(null);
  // 派生瓶出生体积：创建目标瓶时汇入的总量
  const initialVol = Object.create(null);
  for (const b of bottles) {
    balance[b.code] = b.initial_ml;
    bornAt[b.code] = b.sampled_at;
  }

  const addError = (e) => errors.push(e);

  // 按操作时间排序；同时间时保持数组原顺序（稳定排序：插入顺序/序号更小者先发生）
  const order = ops
    .map((op, idx) => ({ op, idx }))
    .sort((a, b) => {
      if (a.op.operated_at < b.op.operated_at) return -1;
      if (a.op.operated_at > b.op.operated_at) return 1;
      return a.idx - b.idx;
    });

  for (const { op } of order) {
    // 1) 目标瓶冲突：编号已被原始瓶占用，或被更早的操作生成过
    if (op.target_code in balance) {
      addError({
        code: 'TARGET_EXISTS',
        opNo: op.op_no,
        conflict: { target: op.target_code, bornAt: bornAt[op.target_code] },
        message: `目标瓶编号 ${op.target_code} 已存在（瓶编号不可重复）`,
      });
    }

    // 2) 来源结构校验：重复来源、正整数体积
    const seen = new Set();
    for (const s of op.sources) {
      if (seen.has(s.source_code)) {
        addError({
          code: 'DUPLICATE_SOURCE',
          opNo: op.op_no,
          source: s.source_code,
          conflict: { opNo: op.op_no, source: s.source_code },
          message: `操作 ${op.op_no} 中来源瓶 ${s.source_code} 重复出现`,
        });
      }
      seen.add(s.source_code);

      if (!Number.isInteger(s.amount_ml) || s.amount_ml <= 0) {
        addError({
          code: 'INVALID_AMOUNT',
          opNo: op.op_no,
          source: s.source_code,
          conflict: { opNo: op.op_no, source: s.source_code, amount: s.amount_ml },
          message: `操作 ${op.op_no} 从 ${s.source_code} 的取用量必须为正整数（收到 ${s.amount_ml}）`,
        });
      }
    }

    // 3) 逐来源扣减：来源必须存在、操作时间不早于来源创建时间、余量充足
    for (const s of op.sources) {
      if (!(s.source_code in balance)) {
        addError({
          code: 'SOURCE_NOT_FOUND',
          opNo: op.op_no,
          source: s.source_code,
          conflict: { opNo: op.op_no, source: s.source_code },
          message: `操作 ${op.op_no} 引用的来源瓶 ${s.source_code} 不存在`,
        });
        continue;
      }
      if (op.operated_at < bornAt[s.source_code]) {
        addError({
          code: 'OP_BEFORE_BIRTH',
          opNo: op.op_no,
          source: s.source_code,
          conflict: {
            opNo: op.op_no,
            source: s.source_code,
            operatedAt: op.operated_at,
            sourceBornAt: bornAt[s.source_code],
          },
          message:
            `操作 ${op.op_no} 的时间（${op.operated_at}）早于来源瓶 ` +
            `${s.source_code} 的创建/采样时间（${bornAt[s.source_code]}）`,
        });
      }
      const amount = Number.isInteger(s.amount_ml) && s.amount_ml > 0 ? s.amount_ml : 0;
      const have = balance[s.source_code];
      if (amount > have) {
        addError({
          code: 'OVERDRAFT',
          opNo: op.op_no,
          source: s.source_code,
          conflict: {
            opNo: op.op_no,
            source: s.source_code,
            requestedMl: amount,
            availableMl: have,
            shortfallMl: amount - have,
          },
          message:
            `操作 ${op.op_no} 从 ${s.source_code} 取用 ${amount} ml，` +
            `超过该时点可用余量 ${have} ml（缺口 ${amount - have} ml）`,
        });
      }
      // 即使报错也按账面继续扣减，便于暴露后续连锁冲突
      balance[s.source_code] = have - amount;
    }

    // 4) 生成目标瓶：目标体积 = 各来源取用量之和（体积守恒）
    if (!(op.target_code in balance)) {
      const total = op.sources.reduce(
        (sum, s) => sum + (Number.isInteger(s.amount_ml) && s.amount_ml > 0 ? s.amount_ml : 0),
        0,
      );
      balance[op.target_code] = total;
      bornAt[op.target_code] = op.operated_at;
      initialVol[op.target_code] = total;
    }
  }

  return { errors, balances: balance, births: bornAt, initialVol };
}

module.exports = { simulate };
