// The extension's own settings page — same card as the in-page pop-up.
const host = document.getElementById("host");
function look(s) {
  host.setAttribute("data-theme", s.theme || "light");
  document.body.style.background = s.theme === "dark" ? "#101413" : "#EEF3F1";
}
QRUI.loadSettings().then(async (s) => {
  look(s);
  host.append(await QRUI.buildSettings({ onSaved: look }));
});
