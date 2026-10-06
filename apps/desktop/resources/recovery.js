async function showDiagnostic() {
  try {
    const diagnostic =
      await window.contextRecovery.getConnectionDiagnostic?.();
    if (
      !diagnostic ||
      typeof diagnostic.message !== "string" ||
      typeof diagnostic.code !== "string"
    ) return;
    document.getElementById("diagnostic-message").textContent =
      diagnostic.message;
    document.getElementById("diagnostic-code").textContent = diagnostic.code;
    document.getElementById("diagnostic").hidden = false;
  } catch {
    // The generic recovery instructions remain useful if diagnostics are unavailable.
  }
}

void showDiagnostic();

document.getElementById("retry").addEventListener("click", async () => {
  const button = document.getElementById("retry");
  button.disabled = true;
  document.getElementById("status").textContent = "Connecting…";
  try {
    await window.contextRecovery.retry();
  } catch {
    document.getElementById("status").textContent =
      "Still unavailable. Please try again shortly.";
    await showDiagnostic();
  } finally {
    button.disabled = false;
  }
});
