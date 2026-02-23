(() => {
  const sendAction = (action) => {
    if (window.api && typeof window.api.trayAction === "function") {
      window.api.trayAction(action);
    }
  };
  const resumeStartupBtn = document.getElementById("trayMenuResumeStartup");

  const setResumeStartupVisible = (visible) => {
    if (!resumeStartupBtn) return;
    resumeStartupBtn.classList.toggle("hidden", !visible);
    resumeStartupBtn.disabled = !visible;
  };

  const refreshResumeStartupState = async () => {
    if (!resumeStartupBtn) return;
    if (!window.api || typeof window.api.getBootStatus !== "function") {
      setResumeStartupVisible(false);
      return;
    }
    try {
      const status = await window.api.getBootStatus();
      const pending =
        status?.bootOnboardingGateOpen === false ||
        status?.bootOnboardingRequired === true;
      setResumeStartupVisible(pending);
    } catch {
      setResumeStartupVisible(false);
    }
  };

  // Setup button click actions
  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      sendAction(button.dataset.action);
    });
  });

  // Escape key to hide tray menu
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      sendAction("hide");
    }
  });

  // Listen for language changes from main process
  if (window.api && typeof window.api.on === "function") {
    window.api.on("tray:language-changed", (data) => {
      if (data?.language && window.i18nUi?.setUiLanguage) {
        window.i18nUi.setUiLanguage(data.language);
      }
    });
  }

  refreshResumeStartupState().catch(() => {});
  const refreshTimer = setInterval(() => {
    refreshResumeStartupState().catch(() => {});
  }, 3000);
  window.addEventListener("beforeunload", () => {
    clearInterval(refreshTimer);
  });
})();
