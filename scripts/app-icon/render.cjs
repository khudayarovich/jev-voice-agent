/**
 * Renders icon.html to build/icon.png (1024 x 1024, transparent), which
 * electron-builder turns into the app's .icns.
 *
 *   npx electron scripts/app-icon/render.cjs
 */
const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const path = require("node:path");

const out = path.resolve(__dirname, "../../build/icon.png");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    webPreferences: { offscreen: true },
  });
  await win.loadFile(path.join(__dirname, "icon.html"));
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage();
  writeFileSync(out, image.toPNG());
  console.log(`[icon] wrote ${out} (${image.getSize().width}x${image.getSize().height})`);
  app.exit(0);
});
