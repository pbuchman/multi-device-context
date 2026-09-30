document.getElementById('retry').addEventListener('click', async () => {
  const button = document.getElementById('retry');
  button.disabled = true;
  document.getElementById('status').textContent = 'Connecting…';
  try { await window.contextRecovery.retry(); }
  catch { document.getElementById('status').textContent = 'Still unavailable. Please try again shortly.'; }
  finally { button.disabled = false; }
});
