#!/usr/bin/env node
// reset-password.js — 命令行重置 DMChat 用户密码
// 服务器兜底：忘记密码 + 恢复码也丢了时，在服务器上直接重置任意账号。
// 用法: node reset-password.js <用户名> <新密码>
// 例:   node reset-password.js duan 123456
// 改完需重启 DMChat 生效: supervisorctl restart dm-DMChat
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

const [, , name, newPassword] = process.argv;
if (!name || !newPassword) {
  console.error('用法: node reset-password.js <用户名> <新密码>');
  console.error('例:   node reset-password.js duan 123456');
  process.exit(1);
}
if (newPassword.length < 4) { console.error('新密码至少4位'); process.exit(1); }

let users;
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
catch (e) { console.error('读 users.json 失败:', e.message); process.exit(1); }

const entry = Object.entries(users).find(([id, u]) => u.name === name);
if (!entry) {
  console.error('用户不存在: ' + name);
  console.error('现有用户: ' + Object.values(users).map(u => u.name).join(', ') || '(无)');
  process.exit(1);
}

entry[1].password = sha256(newPassword);
fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
console.log('✅ 已重置密码: ' + name + ' (userId=' + entry[0] + ')');
console.log('   请重启 DMChat 使生效: supervisorctl restart dm-DMChat');
