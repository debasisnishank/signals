// Theme toggle.
//
// The initial data-theme is set by the inline <head> script in BaseLayout.astro
// (blocking, before first paint) so dark-mode visitors don't see a light flash.
// This file only syncs the checkbox and handles changes from here on.
const toggler = document.getElementById("checkbox_t");

if (toggler) {
  const readTheme = () => {
    try {
      return localStorage.getItem("theme");
    } catch (e) {
      return null;
    }
  };

  const currentTheme =
    document.documentElement.getAttribute("data-theme") ||
    readTheme() ||
    (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

  document.documentElement.setAttribute("data-theme", currentTheme);
  toggler.checked = currentTheme === "dark";

  toggler.addEventListener("change", () => {
    const targetTheme = toggler.checked ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", targetTheme);
    try {
      localStorage.setItem("theme", targetTheme);
    } catch (e) {
      /* private mode / storage blocked — the toggle still works for this page */
    }
  });

  // Enter should toggle the checkbox. Space already does natively; Enter does
  // not, so flip `checked` ourselves and fire the change event by hand.
  toggler.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      toggler.checked = !toggler.checked;
      toggler.dispatchEvent(new Event("change"));
    }
  });
}
