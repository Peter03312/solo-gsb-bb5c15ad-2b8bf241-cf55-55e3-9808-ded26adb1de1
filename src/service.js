'use strict';

const { simulate } = require('./simulate');

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function toIsoUtc(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, 'INVALID_TIME', `${field} 必须为 ISO8601 时间字符串或浏览器本地时间`, { field });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError(400, 'INVALID_TIME', `${field} 无法解析为有效时间：${value}`, { field, value });
  }
  return d.toISOString();
}

function normalizeSources(raw, opNo) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiError(400, 'INVALID_SOURCE', '每次操作至少需要一个来源瓶');
  }
  return raw.map((s, i) => {
    const code = s && typeof s.source === 'string' ? s.source.trim() : '';
    if (!code) {
      throw new ApiError(400, 'INVALID_SOURCE', `操作 ${opNo} 第 ${i + 1} 个来源瓶编号为空`);
    }
    const amount = Number(s && s.amountMl);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new ApiError(400, 'INVALID_AMOUNT', `操作 ${opNo} 从 ${code} 的取用量必须为正整数毫升`, {
        opNo,
        source: code,
      });
    }
    return { source_code: code, amount_ml: amount };
  });
}

function canonicalPayload(operatedAt, sources) {
  return JSON.stringify({
    operated_at: operatedAt,
    sources: sources
      .map((s) => ({ source: s.source_code, amountMl: s.amount_ml }))
      .sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0)),
  });
}

// ---------- 快照读取 ----------

function loadBottles(db) {
  return db.prepare(`SELECT code, sampled_at, initial_ml, is_derived, created_by_op
                     FROM bottles ORDER BY id`).all();
}

function loadOps(db) {
  const ops = db.prepare(`SELECT id, op_no, target_code, operated_at
                          FROM operations ORDER BY id`).all();
  const srcStmt = db.prepare(`SELECT source_code, amount_ml FROM op_sources
                              WHERE op_id = ? ORDER BY seq, id`);
  return ops.map((op) => ({ ...op, sources: srcStmt.all(op.id) }));
}

// ---------- 写操作 ----------

function registerBottle(db, input) {
  const code = typeof input.code === 'string' ? input.code.trim() : '';
  if (!code) throw new ApiError(400, 'INVALID_CODE', '瓶编号不能为空');
  const initialMl = Number(input.initialMl);
  if (!Number.isInteger(initialMl) || initialMl <= 0) {
    throw new ApiError(400, 'INVALID_AMOUNT', '初始体积必须为正整数毫升', { code });
  }
  const sampledAt = toIsoUtc(input.sampledAt, '采样时间');

  const txn = db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM bottles WHERE code = ?').get(code);
    if (exists) throw new ApiError(409, 'BOTTLE_EXISTS', `瓶编号 ${code} 已存在`, { conflict: { code } });
    db.prepare(`INSERT INTO bottles (code, sampled_at, initial_ml, is_derived)
                VALUES (?, ?, ?, 0)`).run(code, sampledAt, initialMl);
  });
  txn();
  return getBottle(db, code);
}

function submitOperation(db, input) {
  const opNo = typeof input.opNo === 'string' ? input.opNo.trim() : '';
  if (!opNo) throw new ApiError(400, 'INVALID_CODE', '操作号不能为空');
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  if (!target) throw new ApiError(400, 'INVALID_CODE', '目标瓶编号不能为空');
  const operatedAt = toIsoUtc(input.operatedAt, '操作时间');
  const sources = normalizeSources(input.sources, opNo);
  const targetMl = sources.reduce((s, x) => s + x.amount_ml, 0);
  const payload = canonicalPayload(operatedAt, sources);

  const txn = db.transaction(() => {
    // 重复操作号：绝不重复扣量。同载荷视为重复提交（幂等返回）；异载荷拒绝
    const dup = db.prepare(`SELECT id, target_code, operated_at FROM operations WHERE op_no = ?`).get(opNo);
    if (dup) {
      const existingSrc = db.prepare(`SELECT source_code, amount_ml FROM op_sources
                                      WHERE op_id = ? ORDER BY seq, id`).all(dup.id);
      if (dup.target_code !== target || canonicalPayload(dup.operated_at, existingSrc) !== payload) {
        throw new ApiError(409, 'OP_NO_CONFLICT', `操作号 ${opNo} 已被使用，提交内容与原记录不一致`, {
          conflict: { opNo },
        });
      }
      return { idempotent: true };
    }

    // 重放期初状态只含原始瓶；派生瓶全部由历史操作在重放中生成
    const bottles = loadBottles(db).filter((b) => !b.is_derived);
    const ops = loadOps(db);
    // 候选排在数组末尾：同时刻时稳定排序使历史操作优先（created_at 顺序）
    const candidate = {
      op_no: opNo,
      target_code: target,
      operated_at: operatedAt,
      sources,
    };
    const { errors } = simulate(bottles, [...ops, candidate]);
    if (errors.length) {
      throw new ApiError(422, 'OP_REJECTED', `操作 ${opNo} 校验未通过：${errors.length} 处冲突`, {
        conflicts: errors,
      });
    }

    const info = db.prepare(`INSERT INTO operations (op_no, target_code, operated_at)
                             VALUES (?, ?, ?)`).run(opNo, target, operatedAt);
    const insSrc = db.prepare(`INSERT INTO op_sources (op_id, source_code, amount_ml, seq)
                               VALUES (?, ?, ?, ?)`);
    sources.forEach((s, i) => insSrc.run(info.lastInsertRowid, s.source_code, s.amount_ml, i));
    db.prepare(`INSERT INTO bottles (code, sampled_at, initial_ml, is_derived, created_by_op)
                VALUES (?, ?, ?, 1, ?)`)
      .run(target, operatedAt, targetMl, opNo);
    return { idempotent: false };
  });

  const result = txn();
  return { ...getOperation(db, opNo), idempotent: result.idempotent };
}

function correctOperation(db, opNo, input) {
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  if (!target) throw new ApiError(400, 'INVALID_CODE', '目标瓶编号不能为空');
  const operatedAt = toIsoUtc(input.operatedAt, '操作时间');
  const sources = normalizeSources(input.sources, opNo);
  const targetMl = sources.reduce((s, x) => s + x.amount_ml, 0);

  const txn = db.transaction(() => {
    const row = db.prepare(`SELECT id, target_code FROM operations WHERE op_no = ?`).get(opNo);
    if (!row) throw new ApiError(404, 'OP_NOT_FOUND', `操作号 ${opNo} 不存在`);

    // 目标瓶只允许更改为“未被其他瓶占用”的编号
    if (target !== row.target_code) {
      const taken = db.prepare(`SELECT 1 FROM bottles WHERE code = ?
                                AND created_by_op IS NOT ?`).get(target, opNo);
      if (taken) throw new ApiError(409, 'TARGET_EXISTS', `目标瓶编号 ${target} 已被占用`, {
        conflict: { target },
      });
    }

    // 以原始瓶为基准，替换该笔操作后按操作顺序全量重算（稳定排序：同时刻按行插入顺序）
    const bottles = loadBottles(db).filter((b) => !b.is_derived);
    const ops = loadOps(db).filter((o) => o.op_no !== opNo);
    ops.push({ op_no: opNo, target_code: target, operated_at: operatedAt, sources });
    const { errors, births, initialVol } = simulate(bottles, ops);
    if (errors.length) {
      throw new ApiError(422, 'CORRECTION_REJECTED',
        `更正被拒绝：按操作顺序重算时发现 ${errors.length} 处冲突，原数据保持不变`,
        { conflicts: errors });
    }

    // 校验通过，落库（否则事务回滚，原数据分毫不动）
    db.prepare(`UPDATE operations SET target_code = ?, operated_at = ? WHERE id = ?`)
      .run(target, operatedAt, row.id);
    db.prepare('DELETE FROM op_sources WHERE op_id = ?').run(row.id);
    const insSrc = db.prepare(`INSERT INTO op_sources (op_id, source_code, amount_ml, seq)
                               VALUES (?, ?, ?, ?)`);
    sources.forEach((s, i) => insSrc.run(row.id, s.source_code, s.amount_ml, i));

    // 目标瓶换号：旧派生瓶改名
    if (target !== row.target_code) {
      db.prepare(`UPDATE bottles SET code = ? WHERE code = ? AND created_by_op = ?`)
        .run(target, row.target_code, opNo);
    }
    // 派生瓶出生时间与初始体积随更正更新；其余派生瓶体积由重放账本推导后同步
    db.prepare(`UPDATE bottles SET sampled_at = ?, initial_ml = ? WHERE created_by_op = ?`)
      .run(births[target], targetMl, opNo);
    syncDerivedVolumes(db);
  });
  txn();
  return getOperation(db, opNo);
}

// 重放全量操作，以重放结果为准同步所有派生瓶的出生体积（原始瓶始终不变）
function syncDerivedVolumes(db) {
  const bottles = loadBottles(db).filter((b) => !b.is_derived);
  const ops = loadOps(db);
  const { births, initialVol } = simulate(bottles, ops);
  const upd = db.prepare(`UPDATE bottles SET initial_ml = ?, sampled_at = ?
                          WHERE code = ? AND is_derived = 1`);
  for (const op of ops) {
    upd.run(initialVol[op.target_code] ?? 0, births[op.target_code], op.target_code);
  }
}

// ---------- 查询 ----------

function getBottle(db, code) {
  const b = db.prepare(`SELECT code, sampled_at, initial_ml, is_derived, created_by_op
                        FROM bottles WHERE code = ?`).get(code);
  if (!b) return null;
  const agg = db.prepare(`SELECT COALESCE(SUM(amount_ml), 0) AS out_ml
                          FROM op_sources WHERE source_code = ?`).get(code);
  return {
    code: b.code,
    sampledAt: b.sampled_at,
    kind: b.is_derived ? 'derived' : 'original',
    createdByOp: b.created_by_op,
    // 初始体积：原始瓶为登记体积，派生瓶为出生时汇入量
    initialMl: b.initial_ml,
    outMl: agg.out_ml,
    // 余量 = 出生体积 − 累计取用量（汇入量已计入派生瓶 initialMl）
    currentMl: b.initial_ml - agg.out_ml,
  };
}

function listBottles(db) {
  const rows = db.prepare(`
    SELECT b.code, b.sampled_at, b.initial_ml, b.is_derived, b.created_by_op,
      COALESCE((SELECT SUM(amount_ml) FROM op_sources WHERE source_code = b.code), 0) AS out_ml
    FROM bottles b ORDER BY b.is_derived, b.id`).all();
  return rows.map((r) => ({
    code: r.code,
    sampledAt: r.sampled_at,
    kind: r.is_derived ? 'derived' : 'original',
    createdByOp: r.created_by_op,
    initialMl: r.initial_ml,
    outMl: r.out_ml,
    currentMl: r.initial_ml - r.out_ml,
  }));
}

function getOperation(db, opNo) {
  const op = db.prepare(`SELECT id, op_no, target_code, operated_at, created_at
                         FROM operations WHERE op_no = ?`).get(opNo);
  if (!op) return null;
  const sources = db.prepare(`SELECT source_code AS source, amount_ml AS amountMl
                              FROM op_sources WHERE op_id = ? ORDER BY seq, id`).all(op.id);
  return {
    opNo: op.op_no,
    target: op.target_code,
    operatedAt: op.operated_at,
    createdAt: op.created_at,
    targetMl: sources.reduce((s, x) => s + x.amountMl, 0),
    sources,
  };
}

function listOperations(db) {
  return db.prepare(`SELECT op_no FROM operations ORDER BY operated_at, id`).all()
    .map((r) => getOperation(db, r.op_no));
}

/**
 * 完整来源谱系：沿 op_sources 递归向上追溯一个瓶的全部祖先
 * 返回树 { bottle, children: [...] }（祖先跨路径重复出现时仍在各路径下展示）
 */
function getLineage(db, code) {
  const bottle = getBottle(db, code);
  if (!bottle) return null;

  const parentStmt = db.prepare(`
    SELECT s.source_code AS source, s.amount_ml AS amountMl, o.op_no, o.operated_at
    FROM op_sources s JOIN operations o ON o.id = s.op_id
    WHERE o.target_code = ? ORDER BY s.seq, s.id`);
  const bottleStmt = db.prepare(`SELECT sampled_at, initial_ml, is_derived FROM bottles WHERE code = ?`);

  const build = (bcode, trail) => {
    const info = bottleStmt.get(bcode);
    const parents = parentStmt.all(bcode);
    return {
      bottle: bcode,
      sampledAt: info ? info.sampled_at : null,
      kind: info && info.is_derived ? 'derived' : 'original',
      cycle: trail.includes(bcode),
      parents: trail.includes(bcode)
        ? []
        : parents.map((p) => ({
            viaOp: p.op_no,
            operatedAt: p.operated_at,
            amountMl: p.amountMl,
            ...build(p.source, [...trail, bcode]),
          })),
    };
  };
  return build(code, []);
}

module.exports = {
  ApiError,
  registerBottle,
  submitOperation,
  correctOperation,
  listBottles,
  getBottle,
  listOperations,
  getOperation,
  getLineage,
};
