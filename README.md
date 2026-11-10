# Class T-Shirt Registration System

A simple registration application built with HTML, CSS, vanilla JavaScript, Node.js, Express, and SQLite. Students can register at `/`; the class representative can sign in at `/admin` to view the roster, size counts, and download the complete Excel list.

## Requirements

- Node.js 20 or later
- Internet access for the initial dependency installation

## Windows PowerShell setup

From the project folder, install dependencies:

```powershell
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

In `.env` beside `server.js`, set `ADMIN_PASSWORD` to a private password of at least 6 characters, then save and close Notepad. The application loads this file from the project directory regardless of the terminal's current directory and generates a cryptographically secure session secret automatically when `SESSION_SECRET` is not set; you do not need to configure one. Keep `.env` private; it is ignored by Git and its values are never sent to the browser.

Start the application:

```powershell
npm start
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) for student registration; use its **Admin Login** link or visit [http://127.0.0.1:8000/admin](http://127.0.0.1:8000/admin) for the class representative login. Successful sign-in opens the protected dashboard. Press **Ctrl+C** in PowerShell to stop the server.

The app automatically creates `students.db` in the project folder. Registrations and login sessions are stored in SQLite. Keep `students.db` to preserve registrations.

For HTTPS deployments, set `NODE_ENV=production` so admin session cookies use the `Secure` attribute. Do not use production mode over plain HTTP.

## Deploy to Render

1. Push this project to a GitHub repository. `.env` and `students.db` (including SQLite WAL files) are ignored and are not served from the public directory.
2. In Render, choose **New + → Blueprint**, connect the repository, and apply the included `render.yaml`.
3. Set the prompted `ADMIN_PASSWORD` environment variable to a private password of at least 6 characters. Render generates `SESSION_SECRET` for the service; keep both values private.
4. The blueprint creates a paid Starter web service and mounts a 1 GB persistent disk at `/var/data`. The app uses `/var/data/students.db`; student registrations and admin sessions therefore survive deploys and restarts. Render supplies `PORT`; the server binds to `0.0.0.0` and uses HTTPS secure session cookies behind Render's proxy.
5. Open the deployed service URL, submit a test registration, log in at `/admin`, and verify the roster, size counts, delete action, and Excel export.

The Render database is separate from the local `students.db`; deploying does not copy, reset, or overwrite the local file. If you need existing registrations in Render, migrate them separately after taking a backup. Keep the service to one instance because SQLite and a Render persistent disk are intended for a single running instance.

## Tests

```powershell
npm test
```
