// Visible visitor count, served by the visitor-counter Cloudflare Worker.
//
// The sites are static, so the number has to come from somewhere else. This
// asks once per page load; the Worker counts a visitor at most once per day.
// Anything goes wrong — offline, Worker down, blocked by a privacy extension —
// and the element simply stays hidden rather than showing a broken count.
(function () {
  var el = document.getElementById('visitor-count');
  if (!el) return;

  var site = el.getAttribute('data-site');
  var wrap = el.closest('.visitors') || el.parentNode;

  fetch('https://visitor-counter.nishankdebasis4.workers.dev/?site=' + encodeURIComponent(site), {
    method: 'GET',
    cache: 'no-store',
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
    .then(function (d) {
      if (typeof d.count !== 'number') return;
      el.textContent = d.count.toLocaleString('en-US');
      if (wrap) wrap.removeAttribute('hidden');
    })
    .catch(function () { /* leave it hidden */ });
})();
