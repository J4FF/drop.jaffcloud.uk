const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const error = document.querySelector('#login-error');
const button = document.querySelector('#login-button');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  error.textContent = '';
  button.disabled = true;

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: password.value })
    });

    if (!response.ok) {
      error.textContent = 'Invalid password.';
      password.select();
      return;
    }

    window.location.replace('/admin');
  } catch {
    error.textContent = 'Login failed.';
  } finally {
    button.disabled = false;
  }
});
