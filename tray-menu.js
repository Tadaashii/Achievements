(() => {
  const sendAction = (action) => {
    if (window.api && typeof window.api.trayAction === "function") {
      window.api.trayAction(action);
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
})();
