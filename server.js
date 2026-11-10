const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const ExcelJS = require('exceljs');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8000);
const VALID_SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL']);
const SESSION_COOKIE_NAME = 'class_threads.sid';

class SQLiteSessionStore extends session.Store {
  constructor(database) { super(); this.database = database; this.readSession = database.prepare('SELECT data, expires FROM sessions WHERE sid = ?'); this.writeSession = database.prepare('INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data'); this.deleteSession = database.prepare('DELETE FROM sessions WHERE sid = ?'); this.updateExpiry = database.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'); }
  get(id, cb) { try { const row = this.readSession.get(id); if (!row) return cb(null, null); if (row.expires <= Date.now()) { this.deleteSession.run(id); return cb(null, null); } cb(null, JSON.parse(row.data)); } catch (e) { cb(e); } }
  set(id, value, cb = () => {}) { try { this.writeSession.run(id, sessionExpiry(value), JSON.stringify(value)); cb(null); } catch (e) { cb(e); } }
  touch(id, value, cb = () => {}) { try { this.updateExpiry.run(sessionExpiry(value), id); cb(null); } catch (e) { cb(e); } }
  destroy(id, cb = () => {}) { try { this.deleteSession.run(id); cb(null); } catch (e) { cb(e); } }
}

class PostgresSessionStore extends session.Store {
  constructor(pool) { super(); this.pool = pool; }
  get(id, cb) { this.pool.query('SELECT data, expires FROM sessions WHERE sid = $1', [id]).then(({ rows }) => { const row = rows[0]; if (!row) return cb(null, null); if (Number(row.expires) <= Date.now()) return this.destroy(id, () => cb(null, null)); cb(null, row.data); }).catch(cb); }
  set(id, value, cb = () => {}) { this.pool.query('INSERT INTO sessions (sid, expires, data) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET expires = EXCLUDED.expires, data = EXCLUDED.data', [id, sessionExpiry(value), value]).then(() => cb(null)).catch(cb); }
  touch(id, value, cb = () => {}) { this.pool.query('UPDATE sessions SET expires = $1 WHERE sid = $2', [sessionExpiry(value), id]).then(() => cb(null)).catch(cb); }
  destroy(id, cb = () => {}) { this.pool.query('DELETE FROM sessions WHERE sid = $1', [id]).then(() => cb(null)).catch(cb); }
}

function sessionExpiry(value) { return value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + (value.cookie?.maxAge || 8 * 60 * 60 * 1000); }
function getDatabasePath(environment = process.env) { return environment.DB_PATH ? path.resolve(environment.DB_PATH) : path.join(__dirname, 'students.db'); }
function initializeDatabase(databasePath = getDatabasePath()) { const Database = require('better-sqlite3'); const resolved = databasePath === ':memory:' ? databasePath : path.resolve(databasePath); if (resolved !== ':memory:') fs.mkdirSync(path.dirname(resolved), { recursive: true }); const db = new Database(resolved); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON'); db.exec("CREATE TABLE IF NOT EXISTS students (id INTEGER PRIMARY KEY AUTOINCREMENT, full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0), shirt_size TEXT NOT NULL CHECK (shirt_size IN ('S', 'M', 'L', 'XL', 'XXL')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);"); db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now()); return db; }

async function initializePostgres(pool) { await pool.query("CREATE TABLE IF NOT EXISTS students (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0), shirt_size TEXT NOT NULL CHECK (shirt_size IN ('S', 'M', 'L', 'XL', 'XXL')), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"); await pool.query('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expires BIGINT NOT NULL, data JSONB NOT NULL)'); await pool.query('CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires)'); await pool.query('DELETE FROM sessions WHERE expires <= $1', [Date.now()]); await pool.query('SELECT 1'); return pool; }
function validateAdminConfig(adminPassword, sessionSecret) { if (typeof adminPassword !== 'string' || adminPassword.length < 6) throw new Error('ADMIN_PASSWORD is required and must be at least 6 characters.'); if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.'); }
function getAdminConfig(environment = process.env) { return { adminPassword: environment.ADMIN_PASSWORD, sessionSecret: environment.SESSION_SECRET || (environment.NODE_ENV === 'production' ? undefined : crypto.randomBytes(32).toString('hex')), secureCookies: environment.NODE_ENV === 'production' }; }
function safeStringEqual(a, b) { return crypto.timingSafeEqual(crypto.createHash('sha256').update(a).digest(), crypto.createHash('sha256').update(b).digest()); }
function requireAdmin(req, res, next) { if (req.session?.adminAuthenticated !== true) return res.status(401).json({ error: 'Admin login required.' }); next(); }

function createApp(database, { adminPassword, sessionSecret, secureCookies = false } = {}) {
  validateAdminConfig(adminPassword, sessionSecret); const postgres = database instanceof Pool; const query = (sql, params) => postgres ? database.query(sql, params) : Promise.resolve({ rows: database.prepare(sql).all(...(params || [])) });
  const app = express(); if (secureCookies) app.set('trust proxy', 1); app.use(express.json({ limit: '10kb' })); app.use(session({ name: SESSION_COOKIE_NAME, secret: sessionSecret, store: postgres ? new PostgresSessionStore(database) : new SQLiteSessionStore(database), resave: false, saveUninitialized: false, cookie: { httpOnly: true, secure: secureCookies, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 } }));
  app.use('/api/admin', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }); app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'private', 'admin.html')); }); app.get('/admin/dashboard', (req, res) => { if (req.session?.adminAuthenticated !== true) return res.redirect('/admin'); res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'private', 'admin.html')); }); app.use(express.static(path.join(__dirname, 'public'))); app.get('/api/students', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.post('/api/students', async (req, res, next) => { try { const { full_name: fullName, shirt_size: shirtSize } = req.body || {}; if (typeof fullName !== 'string' || !fullName.trim()) return res.status(400).json({ error: 'Please enter your full name.' }); if (fullName.trim().length > 120) return res.status(400).json({ error: 'Full name must be 120 characters or fewer.' }); if (typeof shirtSize !== 'string' || !VALID_SIZES.has(shirtSize)) return res.status(400).json({ error: 'Please choose a valid T-shirt size.' }); if (postgres) await database.query('INSERT INTO students (full_name, shirt_size) VALUES ($1, $2)', [fullName.trim(), shirtSize]); else database.prepare('INSERT INTO students (full_name, shirt_size) VALUES (?, ?)').run(fullName.trim(), shirtSize); res.status(201).json({ message: 'Registration successful.' }); } catch (e) { next(e); } });
  app.post('/api/admin/login', async (req, res, next) => { try { if (typeof req.body?.password !== 'string' || !safeStringEqual(req.body.password, adminPassword)) return res.status(401).json({ error: 'Incorrect password.' }); await new Promise((resolve, reject) => req.session.regenerate(e => e ? reject(e) : resolve())); req.session.adminAuthenticated = true; await new Promise((resolve, reject) => req.session.save(e => e ? reject(e) : resolve())); res.json({ message: 'Login successful.' }); } catch (e) { next(e); } });
  app.post('/api/admin/logout', requireAdmin, (req, res, next) => req.session.destroy(e => e ? next(e) : res.clearCookie(SESSION_COOKIE_NAME, { httpOnly: true, secure: secureCookies, sameSite: 'strict' }).status(204).end()));
  app.get('/api/admin/students', requireAdmin, async (req, res, next) => { try { const rows = postgres ? (await database.query('SELECT id, full_name, shirt_size FROM students ORDER BY id')).rows : database.prepare('SELECT id, full_name, shirt_size FROM students ORDER BY id').all(); res.json({ students: rows }); } catch (e) { next(e); } });
  app.delete('/api/admin/students/:id', requireAdmin, async (req, res, next) => { const id = Number(req.params.id); if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student registration ID.' }); try { const result = postgres ? await database.query('DELETE FROM students WHERE id = $1', [id]) : database.prepare('DELETE FROM students WHERE id = ?').run(id); if ((postgres ? result.rowCount : result.changes) === 0) return res.status(404).json({ error: 'Student registration not found.' }); res.json({ message: 'Student registration deleted.' }); } catch (e) { next(e); } });
  app.get('/api/admin/export', requireAdmin, async (req, res, next) => { try { const registrations = postgres ? (await database.query('SELECT full_name, shirt_size FROM students ORDER BY id')).rows : database.prepare('SELECT full_name, shirt_size FROM students ORDER BY id').all(); const workbook = new ExcelJS.Workbook(); const worksheet = workbook.addWorksheet('Student List', { views: [{ state: 'frozen', ySplit: 1 }] }); worksheet.columns = [{ header: 'Full Name', key: 'full_name', width: 32 }, { header: 'T-Shirt Size', key: 'shirt_size', width: 18 }]; worksheet.addRows(registrations); worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }; worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF193A5A' } }; worksheet.autoFilter = 'A1:B1'; res.status(200).type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('class-t-shirt-student-list.xlsx').send(Buffer.from(await workbook.xlsx.writeBuffer())); } catch (e) { next(e); } });
  app.use('/api/admin', (req, res) => res.status(404).json({ error: 'Admin API endpoint not found.' })); app.use((error, req, res, next) => { if (res.headersSent) return next(error); console.error('[class-threads] request failed', { method: req.method, url: req.originalUrl, error: error.message }); res.status(500).json({ error: 'The request could not be completed. Please try again.' }); }); return app;
}

async function createProductionApp() { if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production; Neon is not configured.'); const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined }); await initializePostgres(pool); return createApp(pool, getAdminConfig()); }
function start() { const config = getAdminConfig(); validateAdminConfig(config.adminPassword, config.sessionSecret); const students = initializeDatabase(); const app = createApp(students, config); return { server: app.listen(PORT, '0.0.0.0', () => console.log(`Class T-Shirt Registration System listening on port ${PORT}`)), students }; }
let productionAppPromise;
const vercelHandler = (req, res) => {
  productionAppPromise ||= createProductionApp();
  productionAppPromise
    .then((app) => app(req, res))
    .catch((error) => {
      productionAppPromise = undefined;
      console.error('[class-threads] production startup failed', error);
      if (!res.headersSent) res.status(500).json({ error: 'The application could not start. Please try again later.' });
    });
};
Object.assign(vercelHandler, { createApp, getAdminConfig, getDatabasePath, initializeDatabase, initializePostgres, start });
if (require.main === module) { try { start(); } catch (e) { console.error(`Could not start the application (${e.message}).`); process.exitCode = 1; } }
module.exports = vercelHandler;
