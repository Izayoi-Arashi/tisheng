(function () {
  var mq = matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    var m = localStorage.getItem("ts_theme");
    var dark = m === "dark" || (m !== "light" && mq.matches);
    var el = document.documentElement;
    el.classList.toggle("dark", dark);
    el.classList.toggle("light", m === "light");
    el.style.colorScheme = dark ? "dark" : "light";
    var tc = document.querySelector('meta[name="theme-color"]');
    if (tc) tc.content = dark ? "#000000" : "#ffffff";
  }
  mq.addEventListener("change", apply);
  window.setThemeMode = function (m) {
    if (m === "light" || m === "dark") localStorage.setItem("ts_theme", m);
    else localStorage.removeItem("ts_theme");
    apply();
  };
  apply();
})();
