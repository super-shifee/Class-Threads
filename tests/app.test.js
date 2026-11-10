const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { after, before, beforeEach, test } = require('node:test');
const ExcelJS = require('exceljs');
const { createApp, getAdminConfig, getDatabasePath, initializeDatabase } = require('../server');

let tempDirectory;
let databasePath;
let students;
let server;
let baseUrl;
const adminPassword = 'correct-horse-battery-staple';
const sessionSecret = 'test-session-secret-with-at-least-thirty-two-characters';

test('development startup generates local-only credentials when missing', () => {
  const config = getAdminConfig({ NODE_ENV: 'development' });

  assert.match(config.adminPassword, /^[a-f0-9]{64}$/);
  assert.match(config.sessionSecret, /^[a-f0-9]{64}$/);
});

test('startup generates a session secret when missing without changing environment values', () => {
  const environment = { ADMIN_PASSWORD: adminPassword };
  const config = getAdminConfig(environment);

  assert.match(config.sessionSecret, /^[a-f0-9]{64}$/);
  assert.equal(environment.SESSION_SECRET, undefined);
  assert.equal(config.adminPassword, adminPassword);
});

test('startup preserves a configured session secret', () => {
  const configuredSecret = 'existing-session-secret-with-at-least-thirty-two-characters';
  const config = getAdminConfig({
    ADMIN_PASSWORD: adminPassword,
    SESSION_SECRET: configuredSecret,
  });

  assert.equal(config.sessionSecret, configuredSecret);
});

test('DB_PATH selects a persistent database path without changing the local default', () => {
  const configuredPath = path.join(tempDirectory, 'render-data', 'students.db');

  assert.equal(getDatabasePath({ DB_PATH: configuredPath }), path.resolve(configuredPath));
  assert.equal(getDatabasePath({}), path.join(__dirname, '..', 'students.db'));

  const database = initializeDatabase(getDatabasePath({ DB_PATH: configuredPath }));
  try {
    assert.equal(fs.existsSync(configuredPath), true);
    database.prepare('INSERT INTO students (full_name, shirt_size) VALUES (?, ?)').run('Morgan Reed', 'L');
    assert.deepEqual(database.prepare('SELECT full_name, shirt_size FROM students').get(), {
      full_name: 'Morgan Reed',
      shirt_size: 'L',
    });
  } finally {
    database.close();
  }
});

test('admin password validation accepts six characters and rejects fewer', () => {
  assert.doesNotThrow(() => createApp(students, { adminPassword: '123456', sessionSecret }));
  assert.throws(
    () => createApp(students, { adminPassword: '12345', sessionSecret }),
    /ADMIN_PASSWORD is required and must be at least 6 characters/,
  );
});

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'class-threads-'));
  databasePath = path.join(tempDirectory, 'students.db');
  students = initializeDatabase(databasePath);
  server = createApp(students, { adminPassword, sessionSecret }).listen(0);
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
  students.prepare('DELETE FROM students').run();
  students.prepare('DELETE FROM sessions').run();
});

after(async () => {
  if (server) {
    server.close();
    await once(server, 'close');
  }
  if (students && students.open) students.close();
  if (tempDirectory) fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('SQLite database file and students table are created automatically', () => {
  assert.equal(fs.existsSync(databasePath), true);
  const tables = students
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'students'")
    .all();
  assert.equal(tables.length, 1);
});

test('public registration is validated and saved without exposing roster records', async () => {
  const invalid = await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: '  ', shirt_size: 'M' }),
  });
  assert.equal(invalid.status, 400);

  const invalidSize = await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Jordan Lee', shirt_size: 'XXXL' }),
  });
  assert.equal(invalidSize.status, 400);

  const saved = await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: ' Jordan Lee ', shirt_size: 'M' }),
  });
  assert.equal(saved.status, 201);
  assert.equal(students.prepare('SELECT COUNT(*) AS count FROM students').get().count, 1);

  const publicRoster = await fetch(`${baseUrl}/api/students`);
  assert.notEqual(publicRoster.status, 200);
  assert.equal(students.prepare('SELECT COUNT(*) AS count FROM students').get().count, 1);
});

test('registrations persist after the SQLite database is closed and reopened', async () => {
  const persistentPath = path.join(tempDirectory, 'persistent-students.db');
  let database = initializeDatabase(persistentPath);
  database.prepare('INSERT INTO students (full_name, shirt_size) VALUES (?, ?)').run('Taylor Chen', 'XXL');
  database.close();

  database = initializeDatabase(persistentPath);
  try {
    assert.deepEqual(
      database.prepare('SELECT full_name, shirt_size FROM students ORDER BY id').all(),
      [{ full_name: 'Taylor Chen', shirt_size: 'XXL' }],
    );
  } finally {
    database.close();
  }
});

test('student page only serves the registration experience; admin URL serves login page', async () => {
  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="registration-form"/);
  assert.match(html, /href="\/admin"[^>]*>\s*Admin Login/);
  assert.match(html, /id="admin-login-hint" class="visually-hidden"/);
  assert.match(html, /class="admin-access-link" href="\/admin">Class representative\? Admin access/);
  assert.match(html, /<h1 id="page-title" class="hero-title">What's Up, <span>Classmates\? 😎<\/span><\/h1>/);
  assert.match(html, /<p class="hero-subtitle">Designed by Unity\. Defined by Style\.<\/p>/);
  assert.doesNotMatch(html, /One class\.|One great tee\.|Add your name and size to the class order|THE CLASS OF/);
  assert.doesNotMatch(html, /student-total|student-list|count-xxl|Download Student List/);

  const frontend = await fetch(`${baseUrl}/app.js`);
  assert.equal(frontend.status, 200);
  const frontendSource = await frontend.text();
  assert.match(frontendSource, /registration was saved/);
  assert.doesNotMatch(frontendSource, /api\/admin|student-list|student-total|Download Student List/);
  const adminDodgeScript = await fetch(`${baseUrl}/admin-login-dodge.js`);
  assert.equal(adminDodgeScript.status, 200);
  const adminDodgeSource = await adminDodgeScript.text();
  assert.match(adminDodgeSource, /pointerType !== 'mouse'/);
  assert.match(adminDodgeSource, /matchMedia\('\(hover: hover\) and \(pointer: fine\) and \(min-width: 760px\)'\)/);
  assert.match(adminDodgeSource, /showLaugh\(\)/);
  assert.match(adminDodgeSource, /link\.style\.top = `\$\{choice\.top\}px`/);
  assert.match(adminDodgeSource, /link\.style\.left = `\$\{choice\.left\}px`/);

  await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Private Roster Name', shirt_size: 'S' }),
  });

  const adminPage = await fetch(`${baseUrl}/admin`);
  assert.equal(adminPage.status, 200);
  assert.equal(adminPage.headers.get('cache-control'), 'no-store');
  const adminHtml = await adminPage.text();
  assert.match(adminHtml, /<title>Admin Login \| Class Threads<\/title>/);
  assert.match(adminHtml, /<h1 id="admin-title">Admin Login<\/h1>/);
  assert.doesNotMatch(adminHtml, /class representative/i);
  assert.match(adminHtml, /id="login-form"/);
  assert.match(adminHtml, /id="admin-password"/);
  assert.match(adminHtml, /id="student-total"/);
  assert.match(adminHtml, /id="count-xxl"/);
  assert.match(adminHtml, /<th scope="col">ACTION<\/th>/);
  assert.match(adminHtml, /Download Student List/);
  assert.doesNotMatch(adminHtml, /Private Roster Name/);

  const protectedDashboard = await fetch(`${baseUrl}/admin/dashboard`, { redirect: 'manual' });
  assert.equal(protectedDashboard.status, 302);
  assert.equal(protectedDashboard.headers.get('location'), '/admin');
});

test('admin APIs reject anonymous access, require login, and support sign out', async () => {
  const anonymousList = await fetch(`${baseUrl}/api/admin/students`);
  assert.equal(anonymousList.status, 401);
  const anonymousExport = await fetch(`${baseUrl}/api/admin/export`);
  assert.equal(anonymousExport.status, 401);
  const anonymousLogout = await fetch(`${baseUrl}/api/admin/logout`, { method: 'POST' });
  assert.equal(anonymousLogout.status, 401);

  const wrongPassword = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(wrongPassword.status, 401);

  const login = await fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: adminPassword }),
  });
  assert.equal(login.status, 200);
  const dashboardNavigation = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { Cookie: login.headers.get('set-cookie').split(';', 1)[0] },
    redirect: 'manual',
  });
  assert.equal(dashboardNavigation.status, 200);
  assert.match(await dashboardNavigation.text(), /id="dashboard-panel"/);
  const adminFrontend = await fetch(`${baseUrl}/admin.js`);
  const adminFrontendSource = await adminFrontend.text();
  assert.match(adminFrontendSource, /window\.location\.assign\('\/admin\/dashboard'\)/);
  assert.match(adminFrontendSource, /Are you sure you want to delete this student's registration\?/);
  assert.match(adminFrontendSource, /if \(window\.location\.pathname === '\/admin\/dashboard'\) \{\s+loadStudents\(\)/);
  assert.match(adminFrontendSource, /else \{\s+showDashboard\(false\)/);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const sessionCookie = cookie.split(';', 1)[0];
  assert.equal(students.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);
  const loginPageWithExistingSession = await fetch(`${baseUrl}/admin`, {
    headers: { Cookie: sessionCookie },
    redirect: 'manual',
  });
  assert.equal(loginPageWithExistingSession.status, 200);
  assert.match(await loginPageWithExistingSession.text(), /id="login-panel"/);
  assert.equal(loginPageWithExistingSession.headers.get('cache-control'), 'no-store');
  const anonymousDelete = await fetch(`${baseUrl}/api/admin/students/1`, { method: 'DELETE' });
  assert.equal(anonymousDelete.status, 401);
  assert.match(anonymousDelete.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await anonymousDelete.json(), { error: 'Admin login required.' });

  await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Jordan Lee', shirt_size: 'M' }),
  });
  await fetch(`${baseUrl}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full_name: 'Taylor Chen', shirt_size: 'XXL' }),
  });

  const authorizedList = await fetch(`${baseUrl}/api/admin/students`, {
    headers: { Cookie: sessionCookie },
  });
  const initialRoster = await authorizedList.json();
  assert.deepEqual(initialRoster.students.map(({ full_name, shirt_size }) => ({ full_name, shirt_size })), [
    { full_name: 'Jordan Lee', shirt_size: 'M' },
    { full_name: 'Taylor Chen', shirt_size: 'XXL' },
  ]);
  assert.ok(initialRoster.students.every(({ id }) => Number.isInteger(id)));
  assert.equal(students.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1);

  const deleteResponse = await fetch(`${baseUrl}/api/admin/students/${initialRoster.students[0].id}`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(deleteResponse.status, 200);
  assert.match(deleteResponse.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await deleteResponse.json(), { message: 'Student registration deleted.' });
  assert.equal(students.prepare('SELECT COUNT(*) AS count FROM students').get().count, 1);
  assert.equal(
    students.prepare('SELECT full_name FROM students').get().full_name,
    'Taylor Chen',
  );
  const updatedRoster = await fetch(`${baseUrl}/api/admin/students`, {
    headers: { Cookie: sessionCookie },
  });
  assert.deepEqual((await updatedRoster.json()).students, [
    { id: initialRoster.students[1].id, full_name: 'Taylor Chen', shirt_size: 'XXL' },
  ]);
  const invalidDelete = await fetch(`${baseUrl}/api/admin/students/not-an-id`, {
    method: 'DELETE',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(invalidDelete.status, 400);
  assert.match(invalidDelete.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await invalidDelete.json(), { error: 'Invalid student registration ID.' });
  const missingEndpoint = await fetch(`${baseUrl}/api/admin/missing-endpoint`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(missingEndpoint.status, 404);
  assert.match(missingEndpoint.headers.get('content-type'), /application\/json/);
  assert.deepEqual(await missingEndpoint.json(), { error: 'Admin API endpoint not found.' });

  const response = await fetch(`${baseUrl}/api/admin/export`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /spreadsheetml\.sheet/);
  assert.match(response.headers.get('content-disposition'), /class-t-shirt-student-list\.xlsx/);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const worksheet = workbook.getWorksheet('Student List');
  assert.deepEqual(worksheet.getRow(1).values.slice(1), ['Full Name', 'T-Shirt Size']);
  assert.deepEqual(worksheet.getRow(2).values.slice(1), ['Taylor Chen', 'XXL']);

  const logout = await fetch(`${baseUrl}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: sessionCookie },
  });
  assert.equal(logout.status, 204);
  const afterLogout = await fetch(`${baseUrl}/api/admin/students`, {
    headers: { Cookie: sessionCookie },
  });
  assert.equal(afterLogout.status, 401);
  const dashboardAfterLogout = await fetch(`${baseUrl}/admin/dashboard`, {
    headers: { Cookie: sessionCookie },
    redirect: 'manual',
  });
  assert.equal(dashboardAfterLogout.status, 302);
  assert.equal(dashboardAfterLogout.headers.get('location'), '/admin');
});
