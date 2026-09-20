// Visible visitor count, served by the visitor-counter Cloudflare Worker.
//
// The sites are static, so the number has to come from somewhere else. This
// asks once per page load; the Worker counts a visitor at most once per day.
//
// The element starts hidden and is only revealed on a good response, so if the
// Worker is down, the visitor is offline, or a privacy extension blocks the
// request, nothing appears rather than a broken or zeroed count.
(function () {
  var el = document.querySelector('.visitors[data-site]');
  if (!el) return;

  var site = el.getAttribute('data-site');

  fetch('https://visitor-counter.nishankdebasis4.workers.dev/?site=' + encodeURIComponent(site), {
    method: 'GET',
    cache: 'no-store',
  })
    .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error(r.status)); })
    .then(function (d) {
      // A count of zero reads worse than no count at all — stay hidden.
      if (typeof d.count !== 'number' || d.count < 1) return;
      el.textContent = d.count.toLocaleString('en-US') + (d.count === 1 ? ' visitor' : ' visitors');
      el.removeAttribute('hidden');
    })
    .catch(function () { /* leave it hidden */ });
})();
