(() => {
  const root = document.documentElement;
  const system = matchMedia("(prefers-color-scheme: dark)");
  const key = "rundeck-theme";
  let preference;
  try { preference = localStorage.getItem(key); } catch {}
  let control;

  function apply() {
    const dark = preference === "dark" || (preference !== "light" && system.matches);
    root.dataset.theme = dark ? "dark" : "light";
    document.querySelector('meta[name="theme-color"]').content = dark ? "#111714" : "#f7f8f6";
    if (control) control.setAttribute("aria-pressed", String(dark));
    document.dispatchEvent(new Event("rundeck-theme-change"));
  }

  apply();
  system.addEventListener("change", apply);
  document.addEventListener("DOMContentLoaded", () => {
    control = document.querySelector("#theme-toggle");
    apply();
    control.addEventListener("click", () => {
      preference = root.dataset.theme === "dark" ? "light" : "dark";
      try { localStorage.setItem(key, preference); } catch {}
      apply();
    });
  });
})();
