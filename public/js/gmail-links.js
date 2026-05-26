(function(){
function waitForApp() {
  if (!window.cardHTML || !window.esc || !window.applyFilters) {
    setTimeout(waitForApp, 100);
    return;
  }
  var orig = window.cardHTML;
  window.cardHTML = function(g) {
    var s = g.best;
    var result = orig(g);
    if (!s || !s.thread_id) return result;
    var acct = (s.account_email && s.account_email.indexOf('mjfllc') >= 0) ? '1' : '0';
    var url = 'https://mail.google.com/mail/u/' + acct + '/#all/' + s.thread_id;
    var desc = window.esc(s.description);
    return result.replace(
      'class="card-desc">' + desc + '</div>',
      'class="card-desc"><a href="' + url + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" onmouseover="this.style.color=\'#0078d4\';this.style.textDecoration=\'underline\'" onmouseout="this.style.color=\'inherit\';this.style.textDecoration=\'none\'" title="View email in Gmail">' + desc + '</a></div>'
    );
  };
  window.applyFilters();
}
waitForApp();
})();
