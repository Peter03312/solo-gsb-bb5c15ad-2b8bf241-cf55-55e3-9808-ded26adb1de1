'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 样本瓶：原始瓶由登记接口创建；派生瓶在分装/混样操作提交时自动创建
CREATE TABLE IF NOT EXISTS bottles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL UNIQUE,           -- 瓶编号（唯一）
  sampled_at    TEXT NOT NULL,                  -- 采样时间 / 派生瓶出生时间（ISO8601 UTC）
  initial_ml    INTEGER NOT NULL CHECK (initial_ml > 0),
  is_derived    INTEGER NOT NULL DEFAULT 0,     -- 0 原始瓶, 1 派生瓶
  created_by_op TEXT,                           -- 派生瓶由哪个操作号产生
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (created_by_op) REFERENCES operations(op_no) ON DELETE SET NULL
);

-- 操作（分装/混样）：一次操作把若干来源瓶的液体汇入一个新的目标瓶
CREATE TABLE IF NOT EXISTS operations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  op_no       TEXT NOT NULL UNIQUE,             -- 唯一操作号
  target_code TEXT NOT NULL UNIQUE,             -- 目标瓶编号（每次操作产生一个新瓶）
  operated_at TEXT NOT NULL,                    -- 操作时间（ISO8601 UTC）
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 操作来源明细：每个来源瓶一行，取用量为正整数毫升
CREATE TABLE IF NOT EXISTS op_sources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id       INTEGER NOT NULL,
  source_code TEXT NOT NULL,
  amount_ml   INTEGER NOT NULL CHECK (amount_ml > 0),
  seq         INTEGER NOT NULL DEFAULT 0,
  UNIQUE (op_id, source_code),
  FOREIGN KEY (op_id) REFERENCES operations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_op_sources_source ON op_sources(source_code);
CREATE INDEX IF NOT EXISTS idx_operations_time   ON operations(operated_at, id);
`;

function getDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

module.exports = { getDb };
