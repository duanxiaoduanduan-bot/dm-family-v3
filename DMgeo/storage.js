// storage.js — DMgeo 存储/数据库配置统一读取（对齐 DMmedia 的 storage-config.json 思路）
// 数据目录（geodata/边界）+ PostGIS 连接（host/port/账号/库名）都从这里取，
// 改路径/换库只改 storage-config.json，不用动代码。
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

const DEFAULTS = {
  paths: {
    data:       { dir: './data' },
    boundaries: { dir: './data/boundaries' },
    database:   { dir: './data/database' }
  },
  database: {
    host: 'localhost',
    port: 5432,
    user: 'dmuser',
    password: 'dmpageo123',
    featureDb: 'trip',
    basemapDb: 'Basemap',
    adminDb: 'postgres'
  }
};

function loadStorageConfig() {
  const cfgPath = path.join(ROOT, 'storage-config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      paths:    { ...DEFAULTS.paths, ...(raw.paths || {}) },
      database: { ...DEFAULTS.database, ...(raw.database || {}) }
    };
  } catch (e) {
    return { paths: { ...DEFAULTS.paths }, database: { ...DEFAULTS.database } };
  }
}

// 解析配置里的 dir → 绝对路径（相对 ROOT；绝对路径原样用）
function resolveDir(cfgEntry) {
  if (!cfgEntry || !cfgEntry.dir) return ROOT;
  const d = cfgEntry.dir;
  if (path.isAbsolute(d)) return d;
  return path.resolve(ROOT, d);
}

module.exports = { loadStorageConfig, resolveDir, DEFAULTS, ROOT };
