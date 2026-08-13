const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeImage,
} = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const sharp = require("sharp");

const DARKTABLE = "C:\\Program Files\\darktable\\bin\\darktable-cli.exe";
const PHOTO_EXTENSIONS = new Set([
  ".arw",
  ".cr2",
  ".cr3",
  ".dng",
  ".nef",
  ".orf",
  ".raf",
  ".rw2",
  ".jpg",
  ".jpeg",
  ".png",
  ".tif",
  ".tiff",
]);

function runDarktable(args) {
  return new Promise((resolve, reject) => {
    execFile(
      DARKTABLE,
      args,
      { windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error((stderr || stdout || error.message).trim()));
        else resolve({ stdout, stderr });
      },
    );
  });
}

function darktablePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

async function applyHealOperations(input, operations = []) {
  let image = sharp(input);
  const metadata = await image.metadata();
  const width = metadata.width || 1,
    height = metadata.height || 1;
  for (const operation of operations) {
    const radius = Math.max(
      3,
      Math.round(operation.radius * Math.min(width, height)),
    );
    const cx = Math.round(operation.x * width),
      cy = Math.round(operation.y * height);
    const size = radius * 2;
    const left = Math.max(0, Math.min(width - size, cx - radius));
    const top = Math.max(0, Math.min(height - size, cy - radius));
    const donorLeft = Math.max(
      0,
      Math.min(width - size, left + (left + size * 2 < width ? size : -size)),
    );
    const donorTop = Math.max(
      0,
      Math.min(
        height - size,
        top +
          (top + size * 2 < height
            ? Math.round(radius * 0.45)
            : -Math.round(radius * 0.45)),
      ),
    );
    const base = await image.toBuffer();
    const patch = await sharp(base)
      .extract({ left: donorLeft, top: donorTop, width: size, height: size })
      .png()
      .toBuffer();
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><defs><radialGradient id="m"><stop offset="62%" stop-color="white"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs><circle cx="${radius}" cy="${radius}" r="${radius}" fill="url(#m)"/></svg>`,
    );
    const healedPatch = await sharp(patch)
      .joinChannel(await sharp(mask).extractChannel("alpha").toBuffer())
      .png()
      .toBuffer();
    image = sharp(base).composite([
      { input: healedPatch, left, top, blend: "over" },
    ]);
  }
  return image.toBuffer();
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1040,
    minHeight: 700,
    backgroundColor: "#11110f",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (!app.isPackaged) win.loadURL("http://localhost:5173");
  else win.loadFile(path.join(__dirname, "../dist/index.html"));
}

ipcMain.handle(
  "darktable:status",
  () =>
    new Promise((resolve) => {
      if (!fs.existsSync(DARKTABLE))
        return resolve({ available: false, path: DARKTABLE });
      execFile(
        DARKTABLE,
        ["--version"],
        { windowsHide: true },
        (error, stdout, stderr) => {
          const text = `${stdout || ""} ${stderr || ""}`;
          resolve({
            available: !error,
            path: DARKTABLE,
            version: text.match(/darktable\s+([\d.]+)/i)?.[1] || "Installed",
          });
        },
      );
    }),
);

ipcMain.handle("shoot:choose", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Choose the folder containing this shoot",
  });
  if (result.canceled) return null;
  const folder = result.filePaths[0];
  const files = fs
    .readdirSync(folder, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        PHOTO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()),
    )
    .map((entry) => ({
      name: entry.name,
      path: path.join(folder, entry.name),
      type: path.extname(entry.name).slice(1).toUpperCase(),
    }));
  return { folder, files };
});

ipcMain.handle("thumbnail:get", async (_event, filePath) => {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const thumb = await nativeImage.createThumbnailFromPath(filePath, {
      width: 360,
      height: 270,
    });
    return thumb.isEmpty() ? null : thumb.toDataURL();
  } catch {
    return null;
  }
});

ipcMain.handle("shoot:create", async (event, shoot) => {
  if (!fs.existsSync(DARKTABLE))
    throw new Error("Darktable CLI was not found.");
  if (!shoot?.folder || !Array.isArray(shoot.files))
    throw new Error("The selected shoot is invalid.");
  const normalizedSource = path.resolve(shoot.folder).toLowerCase();
  const projectKey = crypto
    .createHash("sha256")
    .update(normalizedSource)
    .digest("hex")
    .slice(0, 32);
  const projectDir = path.join(app.getPath("userData"), "shoots", projectKey);
  const previewDir = path.join(projectDir, "previews");
  const stagingDir = path.join(projectDir, "staging");
  const cacheDir = path.join(projectDir, "darktable-cache");
  const configDir = path.join(projectDir, "darktable-config");
  fs.mkdirSync(previewDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const previews = [];
  const failures = [];

  for (const [index, photo] of shoot.files.slice(0, 40).entries()) {
    event.sender.send("job:progress", {
      kind: "preview",
      current: index + 1,
      total: Math.min(shoot.files.length, 40),
      message: `Creating preview ${index + 1} of ${Math.min(shoot.files.length, 40)}`,
    });
    const photoKey = crypto
      .createHash("sha256")
      .update(path.resolve(photo.path).toLowerCase())
      .digest("hex")
      .slice(0, 20);
    const outputStem = path.join(previewDir, photoKey);
    const output = `${outputStem}.jpg`;
    const stagedInput = path.join(
      stagingDir,
      `${photoKey}${path.extname(photo.name).toLowerCase()}`,
    );
    try {
      if (
        !fs.existsSync(output) ||
        fs.statSync(output).mtimeMs < fs.statSync(photo.path).mtimeMs
      ) {
        fs.copyFileSync(photo.path, stagedInput);
        const result = await runDarktable([
          darktablePath(stagedInput),
          darktablePath(outputStem),
          "--width",
          "1600",
          "--height",
          "1600",
          "--hq",
          "true",
          "--out-ext",
          "jpg",
          "--apply-custom-presets",
          "false",
          "--core",
          "--cachedir",
          darktablePath(cacheDir),
          "--configdir",
          darktablePath(configDir),
        ]);
        if (!fs.existsSync(output)) {
          const diagnostic =
            `${result.stderr || ""}\n${result.stdout || ""}`.trim();
          throw new Error(
            diagnostic || "Darktable finished without creating an output file.",
          );
        }
      }
      const data = fs.readFileSync(output).toString("base64");
      previews.push({ ...photo, preview: `data:image/jpeg;base64,${data}` });
    } catch (error) {
      failures.push({ name: photo.name, message: error.message });
    } finally {
      try {
        if (fs.existsSync(stagedInput)) fs.unlinkSync(stagedInput);
      } catch {}
    }
  }
  const manifest = {
    sourceFolder: shoot.folder,
    createdAt: new Date().toISOString(),
    photoCount: shoot.files.length,
  };
  fs.writeFileSync(
    path.join(projectDir, "shoot.json"),
    JSON.stringify(manifest, null, 2),
  );
  event.sender.send("job:progress", {
    kind: "complete",
    current: previews.length,
    total: previews.length,
    message: `${previews.length} previews ready`,
  });
  return { projectDir, previews, failures, total: shoot.files.length };
});

ipcMain.handle("retouch:save", async (_event, payload) => {
  if (
    !payload?.projectDir ||
    !payload.projectDir.startsWith(app.getPath("userData"))
  )
    throw new Error("Invalid project location.");
  const retouchFile = path.join(payload.projectDir, "retouch-plan.json");
  const plan = {
    version: 2,
    updatedAt: new Date().toISOString(),
    strength: payload.strength,
    operations: payload.operations,
    healOperations: payload.healOperations || {},
  };
  fs.writeFileSync(retouchFile, JSON.stringify(plan, null, 2));
  return { path: retouchFile, updatedAt: plan.updatedAt };
});

ipcMain.handle("retouch:heal-preview", async (_event, payload) => {
  const encoded = String(payload.preview || "").split(",")[1];
  if (!encoded) throw new Error("Preview image is unavailable.");
  const healed = await applyHealOperations(
    Buffer.from(encoded, "base64"),
    payload.operations || [],
  );
  return `data:image/jpeg;base64,${(await sharp(healed).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`;
});

ipcMain.handle("watermark:choose", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a watermark",
    properties: ["openFile"],
    filters: [{ name: "Watermark", extensions: ["png", "svg"] }],
  });
  if (result.canceled) return null;
  const watermarkPath = result.filePaths[0];
  const extension = path.extname(watermarkPath).toLowerCase();
  const mime = extension === ".svg" ? "image/svg+xml" : "image/png";
  return {
    path: watermarkPath,
    preview: `data:${mime};base64,${fs.readFileSync(watermarkPath).toString("base64")}`,
  };
});

ipcMain.handle("export:choose-folder", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose export folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("export:start", async (event, payload) => {
  if (
    !payload?.shoot?.files?.length ||
    !payload.outputFolder ||
    !payload.watermark
  )
    throw new Error("Shoot, output folder, and watermark are required.");
  const finalDir = path.join(payload.outputFolder, "final");
  const watermarkedDir = path.join(payload.outputFolder, "watermarked");
  const workDir = path.join(payload.projectDir, "export-work");
  const cacheDir = path.join(payload.projectDir, "darktable-cache");
  const configDir = path.join(payload.projectDir, "darktable-config");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.mkdirSync(watermarkedDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const failures = [];
  for (const [index, photo] of payload.shoot.files.entries()) {
    const creativeEdit = payload.creativeEdits?.[photo.path] || {
      style: "Natural",
      crop: "Original",
      vignette: 0,
    };
    const base = path.parse(photo.name).name;
    const staged = path.join(
      workDir,
      `${String(index).padStart(5, "0")}${path.extname(photo.name).toLowerCase()}`,
    );
    const developedStem = path.join(
      workDir,
      `${String(index).padStart(5, "0")}-developed`,
    );
    const developed = `${developedStem}.jpg`;
    try {
      event.sender.send("job:progress", {
        kind: "export",
        current: index + 1,
        total: payload.shoot.files.length,
        message: `Exporting ${photo.name}`,
      });
      fs.copyFileSync(photo.path, staged);
      const result = await runDarktable([
        darktablePath(staged),
        darktablePath(developedStem),
        "--hq",
        "true",
        "--out-ext",
        "jpg",
        "--apply-custom-presets",
        "false",
        "--core",
        "--cachedir",
        darktablePath(cacheDir),
        "--configdir",
        darktablePath(configDir),
      ]);
      if (!fs.existsSync(developed))
        throw new Error(
          `${result.stderr || result.stdout || "Darktable created no output."}`.trim(),
        );
      const masterPath = path.join(finalDir, `${base}.jpg`);
      const healedBuffer = await applyHealOperations(
        developed,
        payload.healOperations?.[photo.path] || [],
      );
      let master = sharp(healedBuffer);
      const sourceMeta = await master.metadata();
      if (creativeEdit.crop && creativeEdit.crop !== "Original") {
        const [aw, ah] = creativeEdit.crop.split(":").map(Number);
        const target = aw / ah;
        const current = (sourceMeta.width || 1) / (sourceMeta.height || 1);
        if (current > target) {
          const width = Math.round((sourceMeta.height || 1) * target);
          const maxLeft = Math.max(0, (sourceMeta.width || width) - width);
          master = master.extract({
            left: Math.round(
              (maxLeft * Math.max(0, Math.min(100, creativeEdit.cropX ?? 50))) /
                100,
            ),
            top: 0,
            width,
            height: sourceMeta.height,
          });
        } else {
          const height = Math.round((sourceMeta.width || 1) / target);
          const maxTop = Math.max(0, (sourceMeta.height || height) - height);
          master = master.extract({
            left: 0,
            top: Math.round(
              (maxTop * Math.max(0, Math.min(100, creativeEdit.cropY ?? 50))) /
                100,
            ),
            width: sourceMeta.width,
            height,
          });
        }
      }
      if (creativeEdit.style === "Black & White") master = master.grayscale();
      if (creativeEdit.style === "Sepia")
        master = master.grayscale().tint({ r: 112, g: 84, b: 54 });
      if (creativeEdit.style === "High Contrast")
        master = master.linear(1.28, -24).modulate({ saturation: 1.15 });
      await master
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toFile(masterPath);
      const image = sharp(masterPath);
      const metadata = await image.metadata();
      const longEdge = Math.max(metadata.width || 0, metadata.height || 0);
      const scale = longEdge > 2048 ? 2048 / longEdge : 1;
      const outputWidth = Math.round((metadata.width || 2048) * scale);
      const outputHeight = Math.round((metadata.height || 2048) * scale);
      const markWidth = Math.max(100, Math.round(outputWidth * 0.22));
      const opacity = Math.max(
        0.05,
        Math.min(0.5, Number(payload.watermarkOpacity || 18) / 100),
      );
      const mark = await sharp(payload.watermark)
        .resize({ width: markWidth })
        .ensureAlpha()
        .linear([1, 1, 1, opacity], [0, 0, 0, 0])
        .png()
        .toBuffer();
      const markMeta = await sharp(mark).metadata();
      const overlays = [];
      if (payload.tiledWatermark !== false) {
        const stepX = Math.max(markWidth + 40, Math.round(outputWidth * 0.34));
        const stepY = Math.max(
          (markMeta.height || 80) + 55,
          Math.round(outputHeight * 0.27),
        );
        for (let row = 0, top = 35; top < outputHeight; row++, top += stepY) {
          const offset = row % 2 ? Math.round(stepX / 2) : 0;
          for (let left = 25 - offset; left < outputWidth; left += stepX)
            if (left >= 0)
              overlays.push({ input: mark, left, top, blend: "over" });
        }
      } else
        overlays.push({ input: mark, gravity: "southeast", blend: "over" });
      if (Number(creativeEdit.vignette || 0) > 0) {
        const amount = Math.min(0.75, Number(creativeEdit.vignette) / 100);
        const svg = `<svg width="${outputWidth}" height="${outputHeight}"><defs><radialGradient id="v"><stop offset="45%" stop-color="black" stop-opacity="0"/><stop offset="100%" stop-color="black" stop-opacity="${amount}"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#v)"/></svg>`;
        overlays.unshift({
          input: Buffer.from(svg),
          left: 0,
          top: 0,
          blend: "over",
        });
      }
      await sharp(masterPath)
        .resize({
          width: outputWidth,
          height: outputHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .composite(overlays)
        .jpeg({ quality: 88 })
        .toFile(path.join(watermarkedDir, `${base}.jpg`));
    } catch (error) {
      failures.push({ name: photo.name, message: error.message });
    } finally {
      for (const file of [staged, developed]) {
        try {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } catch {}
      }
    }
  }
  const result = {
    finalDir,
    watermarkedDir,
    completed: payload.shoot.files.length - failures.length,
    failures,
  };
  event.sender.send("job:progress", {
    kind: "complete",
    current: result.completed,
    total: payload.shoot.files.length,
    message: `Export complete: ${result.completed} photographs`,
  });
  return result;
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
