const form = document.querySelector('#registration-form');
const formMessage = document.querySelector('#form-message');
const submitButton = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  formMessage.textContent = '';
  formMessage.className = 'form-message';
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/students', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        full_name: form.elements.full_name.value,
        shirt_size: form.elements.shirt_size.value,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Registration could not be saved.');

    formMessage.textContent = 'You’re on the list! Your registration was saved.';
    formMessage.classList.add('success');
    form.reset();
  } catch (error) {
    formMessage.textContent = error.message || 'Something went wrong. Please try again.';
    formMessage.classList.add('error');
  } finally {
    submitButton.disabled = false;
  }
});
