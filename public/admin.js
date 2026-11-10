const loginPanel = document.querySelector('#login-panel');
const dashboardPanel = document.querySelector('#dashboard-panel');
const loginForm = document.querySelector('#login-form');
const loginMessage = document.querySelector('#login-message');
const dashboardMessage = document.querySelector('#dashboard-message');
const studentList = document.querySelector('#student-list');
const sizeKeys = ['S', 'M', 'L', 'XL', 'XXL'];

function showDashboard(authenticated) {
  loginPanel.hidden = authenticated;
  dashboardPanel.hidden = !authenticated;
}

function showMessage(element, message, type) {
  element.textContent = message;
  element.className = `form-message ${type}`;
}

async function readAdminResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    await response.text();
    const message = response.status === 404
      ? 'The admin API endpoint was not found. Restart the application and try again.'
      : `The server returned an unexpected response (${response.status}). Restart the application and try again.`;
    throw new Error(message);
  }

  try {
    return await response.json();
  } catch {
    throw new Error('The server returned an invalid response. Please try again.');
  }
}

function renderStudents(students) {
  const counts = Object.fromEntries(sizeKeys.map((size) => [size, 0]));
  students.forEach((student) => { counts[student.shirt_size] += 1; });

  document.querySelector('#student-total').textContent = String(students.length);
  sizeKeys.forEach((size) => {
    document.querySelector(`#count-${size.toLowerCase()}`).textContent = String(counts[size]);
  });

  studentList.replaceChildren();
  if (students.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'empty-state';
    cell.textContent = 'No registrations yet.';
    row.append(cell);
    studentList.append(row);
    return;
  }

  students.forEach((student) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const sizeCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const deleteButton = document.createElement('button');
    nameCell.textContent = student.full_name;
    sizeCell.textContent = student.shirt_size;
    deleteButton.className = 'button button-danger';
    deleteButton.type = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.setAttribute('aria-label', `Delete registration for ${student.full_name}`);
    deleteButton.addEventListener('click', () => deleteStudent(student.id));
    actionCell.append(deleteButton);
    row.append(nameCell, sizeCell, actionCell);
    studentList.append(row);
  });
}

async function deleteStudent(studentId) {
  if (!window.confirm("Are you sure you want to delete this student's registration?")) return;

  dashboardMessage.textContent = '';
  dashboardMessage.className = 'form-message';
  try {
    const response = await fetch(`/api/admin/students/${encodeURIComponent(studentId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    const result = await readAdminResponse(response);
    if (response.status === 401) {
      window.location.replace('/admin');
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Could not delete registration.');

    await loadStudents();
    showMessage(dashboardMessage, 'Student registration deleted successfully.', 'success');
  } catch (error) {
    showMessage(dashboardMessage, error.message || 'Could not delete registration.', 'error');
  }
}

async function loadStudents() {
  const response = await fetch('/api/admin/students', { credentials: 'same-origin' });
  if (response.status === 401) {
    if (window.location.pathname === '/admin/dashboard') {
      window.location.replace('/admin');
      return;
    }
    showDashboard(false);
    return;
  }
  const result = await readAdminResponse(response);
  if (!response.ok) throw new Error(result.error || 'Could not load registrations.');
  renderStudents(result.students);
  showDashboard(true);
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  loginMessage.textContent = '';
  loginMessage.className = 'form-message';

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: loginForm.elements.password.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Sign in failed.');
    loginForm.reset();
    window.location.assign('/admin/dashboard');
  } catch (error) {
    showMessage(loginMessage, error.message || 'Sign in failed. Please try again.', 'error');
  } finally {
    button.disabled = false;
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/admin/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not sign out. Please try again.');
    window.location.replace('/admin');
  } catch (error) {
    showMessage(dashboardMessage, error.message, 'error');
  }
});

if (window.location.pathname === '/admin/dashboard') {
  loadStudents().catch((error) => {
    showDashboard(false);
    showMessage(loginMessage, error.message || 'Could not load the admin dashboard.', 'error');
  });
} else {
  showDashboard(false);
}
