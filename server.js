const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const session = require('express-session');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 8000);
const VALID_SIZES = new Set(['S', 'M', 'L', 'XL', 'XXL']);
const SESSION_COOKIE_NAME = 'class_threads.sid';

class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.database = database;
    this.readSession = database.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
    this.writeSession = database.prepare(`
      INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET expires = excluded.expires, data = excluded.data
    `);
    this.deleteSession = database.prepare('DELETE FROM sessions WHERE sid = ?');
    this.updateExpiry = database.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
  }

  get(sessionId, callback) {
    try {
      const row = this.readSession.get(sessionId);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.deleteSession.run(sessionId);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.data));
    } catch (error) {
      callback(error);
    }
  }

  set(sessionId, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (value.cookie?.maxAge || 8 * 60 * 60 * 1000);
      this.writeSession.run(sessionId, expires, JSON.stringify(value));
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sessionId, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires
        ? new Date(value.cookie.expires).getTime()
        : Date.now() + (value.cookie?.maxAge || 8 * 60 * 60 * 1000);
      this.updateExpiry.run(expires, sessionId);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sessionId, callback = () => {}) {
    try {
      this.deleteSession.run(sessionId);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }
}

class PostgresSessionStore extends session.Store {
  constructor(pool) {
    super();
    this.pool = pool;
  }
  async get(sessionId, callback) {
    try {
      const { rows } = await this.pool.query('SELECT data, expires FROM sessions WHERE sid = $1', [sessionId]);
      const row = rows[0];
      if (!row) return callback(null, null);
      if (Number(row.expires) <= Date.now()) {
        await this.pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]);
        return callback(null, null);
      }
      callback(null, typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
    } catch (error) { callback(error); }
  }
  async set(sessionId, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + (value.cookie?.maxAge || 8 * 60 * 60 * 1000);
      await this.pool.query('INSERT INTO sessions (sid, expires, data) VALUES ($1, $2, $3) ON CONFLICT (sid) DO UPDATE SET expires = EXCLUDED.expires, data = EXCLUDED.data', [sessionId, expires, JSON.stringify(value)]);
      callback(null);
    } catch (error) { callback(error); }
  }
  async touch(sessionId, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + (value.cookie?.maxAge || 8 * 60 * 60 * 1000);
      await this.pool.query('UPDATE sessions SET expires = $1 WHERE sid = $2', [expires, sessionId]);
      callback(null);
    } catch (error) { callback(error); }
  }
  async destroy(sessionId, callback = () => {}) {
    try { await this.pool.query('DELETE FROM sessions WHERE sid = $1', [sessionId]); callback(null); } catch (error) { callback(error); }
  }
}

async function initializePostgresDatabase(environment = process.env) {
  if (!environment.DATABASE_URL) throw new Error('DATABASE_URL is required for production database access.');
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS students (id BIGSERIAL PRIMARY KEY, full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0), shirt_size TEXT NOT NULL CHECK (shirt_size IN ('S','M','L','XL','XXL')), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, expires BIGINT NOT NULL, data JSONB NOT NULL)`);
  await pool.query('DELETE FROM sessions WHERE expires <= $1', [Date.now()]);
  return { isPostgres: true, pool };
}

function getDatabasePath(environment = process.env) {
  return environment.DB_PATH
    ? path.resolve(environment.DB_PATH)
    : path.join(__dirname, 'students.db');
}

function initializeDatabase(databasePath = getDatabasePath()) {
  const resolvedDatabasePath = databasePath === ':memory:'
    ? databasePath
    : path.resolve(databasePath);
  if (resolvedDatabasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedDatabasePath), { recursive: true });
  }
  const database = new Database(resolvedDatabasePath);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL CHECK (length(trim(full_name)) > 0),
      shirt_size TEXT NOT NULL CHECK (shirt_size IN ('S', 'M', 'L', 'XL', 'XXL')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  database.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      expires INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires);
    DELETE FROM sessions WHERE expires <= ${Date.now()};
  `);
  return database;
}

async function insertStudent(database, fullName, shirtSize) {
  if (database.isPostgres) return database.pool.query('INSERT INTO students (full_name, shirt_size) VALUES ($1, $2)', [fullName, shirtSize]);
  return database.prepare('INSERT INTO students (full_name, shirt_size) VALUES (?, ?)').run(fullName, shirtSize);
}

async function listStudents(database) {
  if (database.isPostgres) return (await database.pool.query('SELECT id, full_name, shirt_size FROM students ORDER BY id')).rows;
  return database.prepare('SELECT id, full_name, shirt_size FROM students ORDER BY id').all();
}

async function deleteStudent(database, studentId) {
  if (database.isPostgres) return (await database.pool.query('DELETE FROM students WHERE id = $1', [studentId])).rowCount;
  return database.prepare('DELETE FROM students WHERE id = ?').run(studentId).changes;
}

async function exportStudents(database) {
  if (database.isPostgres) return (await database.pool.query('SELECT full_name, shirt_size FROM students ORDER BY id')).rows;
  return database.prepare('SELECT full_name, shirt_size FROM students ORDER BY id').all();
}

function createApp(students, { adminPassword, sessionSecret, secureCookies = false } = {}) {
  validateAdminConfig(adminPassword, sessionSecret);

  const app = express();
  if (secureCookies) app.set('trust proxy', 1);
  app.use(express.json({ limit: '10kb' }));
  app.use(session({
    name: SESSION_COOKIE_NAME,
    secret: sessionSecret,
    store: students.isPostgres ? new PostgresSessionStore(students.pool) : new SQLiteSessionStore(students),
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: secureCookies,
      sameSite: 'strict',
      maxAge: 8 * 60 * 60 * 1000,
    },
  }));
  app.use('/api/admin', (request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  app.get('/admin', (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.sendFile(path.join(__dirname, 'private', 'admin.html'));
  });
  app.get('/admin/dashboard', (request, response) => {
    if (request.session?.adminAuthenticated !== true) {
      return response.redirect('/admin');
    }
    response.set('Cache-Control', 'no-store');
    response.sendFile(path.join(__dirname, 'private', 'admin.html'));
  });
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/students', (request, response) => {
    response.status(404).json({ error: 'Not found.' });
  });

  app.post('/api/students', async (request, response, next) => {
    try {
      const { full_name: fullName, shirt_size: shirtSize } = request.body || {};
      if (typeof fullName !== 'string' || !fullName.trim()) {
        return response.status(400).json({ error: 'Please enter your full name.' });
      }
      if (fullName.trim().length > 120) {
        return response.status(400).json({ error: 'Full name must be 120 characters or fewer.' });
      }
      if (typeof shirtSize !== 'string' || !VALID_SIZES.has(shirtSize)) {
        return response.status(400).json({ error: 'Please choose a valid T-shirt size.' });
      }

      await insertStudent(students, fullName.trim(), shirtSize);
      response.status(201).json({ message: 'Registration successful.' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/login', async (request, response, next) => {
    try {
      const password = request.body?.password;
      if (typeof password !== 'string' || !safeStringEqual(password, adminPassword)) {
        return response.status(401).json({ error: 'Incorrect password.' });
      }

      await new Promise((resolve, reject) => {
        request.session.regenerate((error) => error ? reject(error) : resolve());
      });
      request.session.adminAuthenticated = true;
      await new Promise((resolve, reject) => {
        request.session.save((error) => error ? reject(error) : resolve());
      });
      response.json({ message: 'Login successful.' });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/admin/logout', requireAdmin, (request, response, next) => {
    request.session.destroy((error) => {
      if (error) return next(error);
      response.clearCookie(SESSION_COOKIE_NAME, {
        httpOnly: true,
        secure: secureCookies,
        sameSite: 'strict',
      });
      response.status(204).end();
    });
  });

  app.get('/api/admin/students', requireAdmin, async (request, response, next) => {
    try {
      const registrations = await listStudents(students);
      response.json({ students: registrations });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/admin/students/:id', requireAdmin, async (request, response, next) => {
    const studentId = Number(request.params.id);
    if (!Number.isSafeInteger(studentId) || studentId < 1) {
      return response.status(400).json({ error: 'Invalid student registration ID.' });
    }

    try {
      const changes = await deleteStudent(students, studentId);
      if (changes === 0) {
        return response.status(404).json({ error: 'Student registration not found.' });
      }
      response.json({ message: 'Student registration deleted.' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/admin/export', requireAdmin, async (request, response, next) => {
    try {
      const registrations = await exportStudents(students);
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Student List', {
        views: [{ state: 'frozen', ySplit: 1 }],
      });
      worksheet.columns = [
        { header: 'Full Name', key: 'full_name', width: 32 },
        { header: 'T-Shirt Size', key: 'shirt_size', width: 18 },
      ];
      worksheet.addRows(registrations);
      worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF193A5A' },
      };
      worksheet.autoFilter = 'A1:B1';

      const file = await workbook.xlsx.writeBuffer();
      response
        .status(200)
        .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .attachment('class-t-shirt-student-list.xlsx')
        .send(Buffer.from(file));
    } catch (error) {
      next(error);
    }
  });

  app.use('/api/admin', (request, response) => {
    response.status(404).json({ error: 'Admin API endpoint not found.' });
  });

  app.use((error, request, response, next) => {
    if (response.headersSent) return next(error);
    console.error('Request failed:', error);
    response.status(500).json({ error: 'The request could not be completed. Please try again.' });
  });

  return app;
}

function safeStringEqual(candidate, expected) {
  const candidateHash = crypto.createHash('sha256').update(candidate).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(candidateHash, expectedHash);
}

function requireAdmin(request, response, next) {
  if (request.session?.adminAuthenticated !== true) {
    return response.status(401).json({ error: 'Admin login required.' });
  }
  next();
}

function validateAdminConfig(adminPassword, sessionSecret) {
  if (typeof adminPassword !== 'string' || adminPassword.length < 6) {
    throw new Error(
      'ADMIN_PASSWORD is required and must be at least 6 characters. Set it in .env (copy .env.example and enter a private password) or in your environment before running npm start.',
    );
  }
  if (typeof sessionSecret !== 'string' || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set to a random value of at least 32 characters.');
  }
}

function getAdminConfig(environment = process.env) {
  return {
    adminPassword: environment.ADMIN_PASSWORD,
    sessionSecret: environment.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    secureCookies: environment.NODE_ENV === 'production',
  };
}

function start() {
  const adminConfig = getAdminConfig();
  validateAdminConfig(adminConfig.adminPassword, adminConfig.sessionSecret);
  const databasePath = getDatabasePath();
  const students = initializeDatabase(databasePath);
  const app = createApp(students, adminConfig);
  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Class T-Shirt Registration System listening on port ${PORT}`);
    console.log(`SQLite database: ${databasePath}`);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(async (error) => {
      if (error) {
        console.error('Could not close the web server cleanly.');
        process.exitCode = 1;
      }
      students.close();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return { server, students };
}

function createVercelHandler() {
  let appPromise;
  return async (request, response) => {
    if (!appPromise) {
      appPromise = (async () => {
        const adminConfig = getAdminConfig();
        const database = process.env.DATABASE_URL
          ? await initializePostgresDatabase()
          : initializeDatabase(path.join('/tmp', 'class-threads.sqlite'));
        return createApp(database, adminConfig);
      })();
    }
    try {
      return (await appPromise)(request, response);
    } catch (error) {
      console.error('Could not initialize the production database:', error);
      response.status(500).json({ error: 'The application database is unavailable.' });
    }
  };
}

if (require.main === module) {
  try {
    start();
  } catch (error) {
    console.error(`Could not start the application (${error.message}).`);
    process.exitCode = 1;
  }
}

const vercelHandler = createVercelHandler();
Object.assign(vercelHandler, {
  createApp,
  getAdminConfig,
  getDatabasePath,
  initializeDatabase,
  start,
});

module.exports = vercelHandler;
