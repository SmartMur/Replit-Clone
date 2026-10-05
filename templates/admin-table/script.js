// Theme toggle (same storage key as the design system) and mobile menu.
(function () {
  var root = document.documentElement;
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dark = !root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      try { localStorage.setItem('bm-ds-theme', dark ? 'dark' : 'light'); } catch (e) {}
    });
  });
  var menuBtn = document.querySelector('[data-menu-toggle]');
  var menu = document.getElementById('mobile-nav');
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () {
      var open = menu.hasAttribute('hidden');
      if (open) menu.removeAttribute('hidden'); else menu.setAttribute('hidden', '');
      menuBtn.setAttribute('aria-expanded', String(open));
    });
  }
})();

// Live filter over the rows. Replace with real data and server-side search.
(function () {
  var input = document.getElementById('search');
  var rows = Array.prototype.slice.call(document.querySelectorAll('[data-row]'));
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  function update() {
    var q = (input.value || '').trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (row) {
      var match = !q || row.textContent.toLowerCase().indexOf(q) !== -1;
      row.hidden = !match;
      if (match) shown += 1;
    });
    empty.hidden = shown !== 0;
    count.textContent = shown + (shown === 1 ? ' result' : ' results');
  }
  if (input) { input.addEventListener('input', update); update(); }
})();
