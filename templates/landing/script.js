// Light/dark theme toggle (same storage key as the design system boot script).
(function () {
  var root = document.documentElement;
  document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var dark = !root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      try { localStorage.setItem('bm-ds-theme', dark ? 'dark' : 'light'); } catch (e) {}
    });
  });
})();
