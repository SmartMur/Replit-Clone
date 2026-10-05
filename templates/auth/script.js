// Front-end only validation. Replace the demo message with a real request to your backend.
(function () {
  var root = document.documentElement;
  var stored = null;
  try { stored = localStorage.getItem('bm-ds-theme'); } catch (e) {}
  if (stored === 'dark') root.classList.add('dark');

  var form = document.querySelector('[data-auth-form]');
  var status = document.getElementById('form-status');
  if (!form || !status) return;
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var bad = Array.prototype.slice.call(form.elements).filter(function (el) {
      return el.willValidate && !el.checkValidity();
    })[0];
    status.className = 'mt-4 text-center text-sm';
    if (bad) {
      status.classList.add('text-danger-display');
      status.textContent = bad.validationMessage || 'Please check the highlighted field.';
      bad.focus();
      return;
    }
    status.classList.add('text-ink-muted');
    status.textContent = 'Demo only: no account was created. Connect this form to a backend.';
  });
})();
