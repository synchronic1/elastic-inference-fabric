// Apply the device preference before styles render. Never store authentication here.
(function () {
  var saved;
  try { saved = localStorage.getItem('eif-theme'); } catch (_) {}
  var theme = saved === 'light' || saved === 'dark' ? saved
    : typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f4f6f9' : '#071016');
})();
