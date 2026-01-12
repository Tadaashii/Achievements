(() => {
  const sendAction = (action) => {
    if (window.api && typeof window.api.trayAction === "function") {
      window.api.trayAction(action);
    }
  };

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      sendAction(button.dataset.action);
    });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      sendAction("hide");
    }
  });
})();
