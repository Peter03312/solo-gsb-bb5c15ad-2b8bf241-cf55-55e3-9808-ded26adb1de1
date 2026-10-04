'use strict';

const path = require('path');
const express = require('express');
const { getDb } = require('./db');
const svc = require('./service');
const { seedDemoData } = require('./seed');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'lab.db');

const db = getDb(DB_PATH);
if (process.env.SEED_DEMO !== 'false') seedDemoData(db);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => {
  try {
    fn(req, res, next);
  } catch (err) {
    next(err);
  }
};

// ---------- API ----------

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// 瓶列表与当前余量
app.get('/api/bottles', wrap((_req, res) => {
  res.json({ bottles: svc.listBottles(db) });
}));

// 登记原始瓶
app.post('/api/bottles', wrap((req, res) => {
  const bottle = svc.registerBottle(db, req.body || {});
  res.status(201).json({ bottle });
}));

// 操作列表（按操作时间排序）
app.get('/api/operations', wrap((_req, res) => {
  res.json({ operations: svc.listOperations(db) });
}));

// 提交一次分装/混样操作
app.post('/api/operations', wrap((req, res) => {
  const result = svc.submitOperation(db, req.body || {});
  res.status(result.idempotent ? 200 : 201).json({
    operation: result,
    idempotent: result.idempotent,
    notice: result.idempotent ? '相同操作号与内容的重复提交，未重复扣量' : undefined,
  });
}));

// 更正历史操作（整体重算；冲突则整次拒绝，原数据不变）
app.put('/api/operations/:opNo', wrap((req, res) => {
  const operation = svc.correctOperation(db, req.params.opNo, req.body || {});
  res.json({ operation, notice: '更正已应用，相关瓶余量已按操作顺序重算' });
}));

// 单瓶 + 完整来源谱系
app.get('/api/bottles/:code/lineage', wrap((req, res) => {
  const lineage = svc.getLineage(db, req.params.code);
  if (!lineage) {
    return res.status(404).json({ error: { code: 'BOTTLE_NOT_FOUND', message: `瓶 ${req.params.code} 不存在` } });
  }
  res.json({ lineage });
}));

// ---------- 错误处理 ----------

app.use((err, _req, res, _next) => {
  if (err instanceof svc.ApiError) {
    return res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.conflict ? { conflict: err.conflict } : {}),
        ...(err.conflicts ? { conflicts: err.conflicts } : {}),
      },
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } });
  }
  // SQLite 唯一约束等兜底
  if (err && /SQLITE_CONSTRAINT/.test(err.code || err.message || '')) {
    return res.status(409).json({ error: { code: 'CONSTRAINT', message: String(err.message).split('\n')[0] } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
});

app.listen(PORT, () => {
  console.log(`水质实验室溯源工作台已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${DB_PATH}`);
});
