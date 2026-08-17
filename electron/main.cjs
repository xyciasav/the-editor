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
  const base = await sharp(input).png().toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width || 1,
    height = metadata.height || 1;
  const composites = [];
  for (const operation of operations.slice(0, 80)) {
    const radius = Math.max(
      3,
      Math.round(operation.radius * Math.min(width, height)),
    );
    const cx = Math.round(operation.x * width),
      cy = Math.round(operation.y * height);
    const size = radius * 2;
    const left = Math.max(0, Math.min(width - size, cx - radius));
    const top = Math.max(0, Math.min(height - size, cy - radius));
    const targetStats = await sharp(base)
      .extract({ left, top, width: size, height: size })
      .stats();
    const offsets = [
      [-2, 0],
      [2, 0],
      [0, -2],
      [0, 2],
      [-1.5, -1.5],
      [1.5, -1.5],
      [-1.5, 1.5],
      [1.5, 1.5],
    ];
    let best = null;
    for (const [ox, oy] of offsets) {
      const candidateLeft = Math.max(
        0,
        Math.min(width - size, Math.round(left + ox * radius)),
      );
      const candidateTop = Math.max(
        0,
        Math.min(height - size, Math.round(top + oy * radius)),
      );
      if (
        Math.abs(candidateLeft - left) < radius &&
        Math.abs(candidateTop - top) < radius
      )
        continue;
      const stats = await sharp(base)
        .extract({
          left: candidateLeft,
          top: candidateTop,
          width: size,
          height: size,
        })
        .stats();
      const distance = [0, 1, 2].reduce(
        (sum, channel) =>
          sum +
          Math.pow(
            (stats.channels[channel]?.mean || 0) -
              (targetStats.channels[channel]?.mean || 0),
            2,
          ),
        0,
      );
      if (!best || distance < best.distance)
        best = { left: candidateLeft, top: candidateTop, distance };
    }
    const suggested = operation.mode === "suggested";
    const donorLeft = best?.left ?? left;
    const donorTop = best?.top ?? top;
    const patchSource = sharp(base).extract({
      left: suggested ? left : donorLeft,
      top: suggested ? top : donorTop,
      width: size,
      height: size,
    });
    const patch = await (suggested ? patchSource.median(3) : patchSource)
      .png()
      .toBuffer();
    const centerOpacity = suggested
      ? Math.max(0.3, Math.min(0.82, Number(operation.opacity) || 0.42))
      : 1;
    const mask = Buffer.from(
      `<svg width="${size}" height="${size}"><defs><radialGradient id="m"><stop offset="45%" stop-color="white" stop-opacity="${centerOpacity}"/><stop offset="100%" stop-color="white" stop-opacity="0"/></radialGradient></defs><circle cx="${radius}" cy="${radius}" r="${radius}" fill="url(#m)"/></svg>`,
    );
    const healedPatch = await sharp(patch)
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
    composites.push({ input: healedPatch, left, top, blend: "over" });
  }
  if (!composites.length) return base;
  return sharp(base).composite(composites).png().toBuffer();
}

async function applyLocalAdjustments(input, operations = []) {
  if (!operations.length) return sharp(input).toBuffer();
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const minimum = Math.min(info.width, info.height);
  for (const operation of operations.slice(0, 80)) {
    const radius = Math.max(3, Math.round(operation.radius * minimum));
    const cx = Math.round(operation.x * info.width);
    const cy = Math.round(operation.y * info.height);
    const amount = Math.max(
      -0.12,
      Math.min(0.12, Number(operation.amount) || 0),
    );
    const left = Math.max(0, cx - radius),
      right = Math.min(info.width - 1, cx + radius),
      top = Math.max(0, cy - radius),
      bottom = Math.min(info.height - 1, cy + radius);
    for (let y = top; y <= bottom; y++)
      for (let x = left; x <= right; x++) {
        const distance = Math.hypot(x - cx, y - cy) / radius;
        if (distance >= 1) continue;
        const feather = distance <= 0.55 ? 1 : (1 - distance) / 0.45;
        const scale = 1 + amount * feather;
        const index = (y * info.width + x) * info.channels;
        for (let channel = 0; channel < 3; channel++)
          data[index + channel] = Math.round(
            Math.max(0, Math.min(255, data[index + channel] * scale)),
          );
      }
  }
  return sharp(data, { raw: info }).png().toBuffer();
}

async function analyzeBlemishes(input) {
  const { data, info } = await sharp(input)
    .resize({
      width: 520,
      height: 520,
      fit: "inside",
      withoutEnlargement: true,
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const candidates = [];
  const pixel = (x, y, channel) => data[(y * width + x) * channels + channel];
  const isSkin = (r, g, b) => {
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    return (
      luminance > 75 &&
      luminance < 225 &&
      r > 92 &&
      g > 50 &&
      b > 35 &&
      r > g * 1.06 &&
      r > b * 1.12 &&
      r - Math.min(g, b) > 15 &&
      Math.max(r, g, b) - Math.min(r, g, b) < 125
    );
  };
  for (let y = 13; y < height - 13; y += 2)
    for (let x = 13; x < width - 13; x += 2) {
      const r = pixel(x, y, 0),
        g = pixel(x, y, 1),
        b = pixel(x, y, 2);
      if (!isSkin(r, g, b)) continue;
      let rr = 0,
        gg = 0,
        bb = 0,
        count = 0;
      const surrounding = [
        [-12, 0],
        [12, 0],
        [0, -12],
        [0, 12],
        [-9, -9],
        [9, -9],
        [-9, 9],
        [9, 9],
      ];
      let skinNeighbors = 0,
        minLum = 255,
        maxLum = 0;
      for (const [dx, dy] of surrounding) {
        const nr = pixel(x + dx, y + dy, 0),
          ng = pixel(x + dx, y + dy, 1),
          nb = pixel(x + dx, y + dy, 2);
        rr += nr;
        gg += ng;
        bb += nb;
        if (isSkin(nr, ng, nb)) skinNeighbors++;
        const lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
        minLum = Math.min(minLum, lum);
        maxLum = Math.max(maxLum, lum);
        count++;
      }
      if (skinNeighbors < 6 || maxLum - minLum > 64) continue;
      const redExcess =
        r - rr / count - 0.45 * (g - gg / count + (b - bb / count));
      const darkness = ((rr + gg + bb) / count - (r + g + b)) / 3;
      const rednessScore = redExcess * 1.1;
      const score = Math.max(rednessScore, darkness);
      if (score > 16)
        candidates.push({
          x: x / width,
          y: y / height,
          score,
          kind: rednessScore >= darkness ? "Localized redness" : "Dark spot",
        });
    }
  candidates.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const candidate of candidates) {
    if (
      selected.some(
        (item) =>
          Math.hypot(item.x - candidate.x, item.y - candidate.y) < 0.035,
      )
    )
      continue;
    selected.push({
      ...candidate,
      confidence: Math.round(
        Math.max(52, Math.min(91, 52 + (candidate.score - 16) * 1.15)),
      ),
      radius: candidate.score > 28 ? 0.014 : 0.018,
    });
    if (selected.length >= 10) break;
  }
  return selected;
}

async function applyAutomaticBlemishes(input, operations) {
  const level = operationLevel(operations, "temporary", 0);
  if (!level) return sharp(input).toBuffer();
  const thresholds = [100, 88, 82, 76, 70];
  const limits = [0, 2, 4, 7, 10];
  const opacity = [0, 0.38, 0.52, 0.66, 0.78][level];
  const suggestions = (await analyzeBlemishes(input))
    .filter((item) => item.confidence >= thresholds[level])
    .slice(0, limits[level])
    .map(({ x, y, radius, kind }) => ({
      x,
      y,
      radius: Math.min(radius, 0.014 + level * 0.001),
      kind,
      mode: "suggested",
      opacity,
    }));
  return applyHealOperations(input, suggestions);
}

async function applyFlyawayCleanup(input, operations) {
  const level = operationLevel(operations, "flyaway", 0);
  if (!level) return sharp(input).toBuffer();
  const source = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const median = await sharp(input)
    .median(level >= 3 ? 5 : 3)
    .ensureAlpha()
    .raw()
    .toBuffer();
  const amount = [0, 0.35, 0.55, 0.78, 1][level];
  for (let index = 0; index < source.data.length; index += source.info.channels) {
    const r = source.data[index], g = source.data[index + 1], b = source.data[index + 2];
    const mr = median[index], mg = median[index + 1], mb = median[index + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const medianLuminance = 0.299 * mr + 0.587 * mg + 0.114 * mb;
    const simpleBackground =
      medianLuminance > 90 && Math.max(mr, mg, mb) - Math.min(mr, mg, mb) < 70;
    if (!simpleBackground || medianLuminance - luminance < 12) continue;
    source.data[index] = Math.round(r + (mr - r) * amount);
    source.data[index + 1] = Math.round(g + (mg - g) * amount);
    source.data[index + 2] = Math.round(b + (mb - b) * amount);
  }
  return sharp(source.data, { raw: source.info }).png().toBuffer();
}

async function applyAutomaticOperations(input, operations) {
  const blemished = await applyAutomaticBlemishes(input, operations);
  return applyFlyawayCleanup(blemished, operations);
}

function operationEnabled(operations, id, defaultValue = true) {
  if (!Array.isArray(operations)) return defaultValue;
  const operation = operations.find((item) => item?.id === id);
  return operation ? operation.enabled !== false : defaultValue;
}

function operationLevel(operations, id, defaultValue = 0) {
  if (!Array.isArray(operations)) return defaultValue;
  const operation = operations.find((item) => item?.id === id);
  if (!operation || operation.enabled === false) return 0;
  return Math.max(0, Math.min(4, Number(operation.level ?? defaultValue)));
}

async function applyDreamySoften(input, operations) {
  const level = operationLevel(operations, "soften", 0);
  if (!level) return sharp(input).toBuffer();
  const opacity = [0, 0.07, 0.12, 0.19, 0.27][level];
  const sigma = [0, 2.2, 3.2, 4.5, 6][level];
  const glow = await sharp(input)
    .blur(sigma)
    .modulate({ brightness: 1.035 + level * 0.008, saturation: 0.98 })
    .ensureAlpha()
    .linear([1, 1, 1, opacity], [0, 0, 0, 0])
    .png()
    .toBuffer();
  return sharp(input)
    .composite([{ input: glow, blend: "over" }])
    .png()
    .toBuffer();
}

async function applyPortraitTone(input, strength = 0, operations) {
  const level = Math.max(0, Math.min(4, Number(strength || 0)));
  const toneLevel = operationLevel(operations, "tone", level);
  const underEyeLevel = operationLevel(operations, "under-eye", 0);
  const teethLevel = operationLevel(operations, "teeth", 0);
  if (level < 2 && !toneLevel && !underEyeLevel && !teethLevel)
    return sharp(input).toBuffer();
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const amount = [0, 0.07, 0.12, 0.22, 0.38][toneLevel];
  const subjectMask = Buffer.alloc(info.width * info.height);
  let subjectPixels = 0;
  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index],
      g = data[index + 1],
      b = data[index + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const skin =
      luminance > 55 &&
      luminance < 235 &&
      r > 75 &&
      g > 35 &&
      b > 20 &&
      r > g * 1.04 &&
      r > b * 1.08 &&
      r - Math.min(g, b) > 10 &&
      Math.max(r, g, b) - Math.min(r, g, b) < 145;
    if (!skin) continue;
    subjectMask[index / info.channels] = 255;
    subjectPixels++;
    if (!toneLevel) continue;
    const excess = Math.max(0, r - (g * 1.18 + b * 0.18));
    const correction = Math.min(18, excess * amount);
    data[index] = Math.round(Math.max(0, r - correction));
    data[index + 1] = Math.round(Math.min(255, g + correction * 0.18));
    data[index + 2] = Math.round(Math.min(255, b + correction * 0.1));
  }

  const coverage = subjectPixels / (info.width * info.height);
  if (underEyeLevel) {
    const blurred = await sharp(input)
      .blur(Math.max(4, Math.min(info.width, info.height) / 95))
      .ensureAlpha()
      .raw()
      .toBuffer();
    const recovery = [0, 0.18, 0.3, 0.45, 0.62][underEyeLevel];
    for (let index = 0; index < data.length; index += info.channels) {
      if (!subjectMask[index / info.channels]) continue;
      const luminance = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      const local = 0.299 * blurred[index] + 0.587 * blurred[index + 1] + 0.114 * blurred[index + 2];
      const shadowGap = local - luminance;
      if (shadowGap < 4) continue;
      const lift = Math.min(20, (shadowGap - 4) * recovery);
      for (let channel = 0; channel < 3; channel++)
        data[index + channel] = Math.round(Math.min(255, data[index + channel] + lift));
    }
  }
  if (teethLevel) {
    const brighten = [0, 0.06, 0.1, 0.16, 0.23][teethLevel];
    const width = info.width;
    for (let index = 0; index < data.length; index += info.channels) {
      const r = data[index], g = data[index + 1], b = data[index + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance < 85 || luminance > 242 || Math.max(r, g, b) - Math.min(r, g, b) > 85 || r < b + 1)
        continue;
      const pixel = index / info.channels;
      const x = pixel % width, y = Math.floor(pixel / width);
      const nearSkin = [[-8,0],[8,0],[0,-8],[0,8],[-12,0],[12,0]].some(([dx,dy]) => {
        const nx = x + dx, ny = y + dy;
        return nx >= 0 && nx < width && ny >= 0 && ny < info.height && subjectMask[ny * width + nx] > 0;
      });
      if (!nearSkin) continue;
      data[index] = Math.round(Math.min(255, r * (1 + brighten * 0.45)));
      data[index + 1] = Math.round(Math.min(255, g * (1 + brighten * 0.55)));
      data[index + 2] = Math.round(Math.min(255, b * (1 + brighten)));
    }
  }
  const coreMidtoneLift = [0, 0, 2, 3, 4][level];
  const coreHighlightControl = [0, 0, 0.008, 0.018, 0.04][level];
  for (let index = 0; index < data.length; index += info.channels) {
    const r = data[index],
      g = data[index + 1],
      b = data[index + 2];
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
    const midtoneWeight = Math.sin((Math.PI * luminance) / 255);
    const highlightWeight = Math.pow(Math.max(0, (luminance - 170) / 85), 1.4);
    const offset = coreMidtoneLift * midtoneWeight;
    const scale = 1 - coreHighlightControl * highlightWeight;
    data[index] = Math.round(Math.max(0, Math.min(255, (r + offset) * scale)));
    data[index + 1] = Math.round(
      Math.max(0, Math.min(255, (g + offset) * scale)),
    );
    data[index + 2] = Math.round(
      Math.max(0, Math.min(255, (b + offset) * scale)),
    );
  }
  if (level >= 3 && coverage > 0.004 && coverage < 0.48) {
    const { data: featheredMask, info: maskInfo } = await sharp(subjectMask, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .blur(Math.max(3, Math.min(info.width, info.height) / 85))
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (
      maskInfo.width !== info.width ||
      maskInfo.height !== info.height ||
      !maskInfo.channels
    )
      throw new Error("Subject mask dimensions do not match the photograph.");
    const maskWeight = (pixelIndex) =>
      featheredMask[pixelIndex * maskInfo.channels] / 255;
    let subjectLuminance = 0,
      subjectWeightTotal = 0,
      surroundLuminance = 0,
      surroundWeightTotal = 0;
    for (let index = 0; index < data.length; index += info.channels) {
      const pixelIndex = index / info.channels;
      const subjectWeight = maskWeight(pixelIndex);
      const luminance =
        0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
      subjectLuminance += luminance * subjectWeight;
      subjectWeightTotal += subjectWeight;
      const visualWeight =
        (1 - subjectWeight) * (0.2 + 0.8 * Math.pow(luminance / 255, 1.5));
      surroundLuminance += luminance * visualWeight;
      surroundWeightTotal += visualWeight;
    }
    const subjectMean = subjectLuminance / Math.max(1, subjectWeightTotal);
    const surroundMean = surroundLuminance / Math.max(1, surroundWeightTotal);
    const brightnessGap = surroundMean - subjectMean;
    const sceneNeed = Math.max(
      level === 4 ? 0.34 : 0.28,
      Math.min(1.05, (brightnessGap + 18) / 72),
    );
    const exposureHeadroom = Math.max(
      0.18,
      Math.min(1, (190 - subjectMean) / 78),
    );
    const adaptiveNeed = sceneNeed * exposureHeadroom;
    const faceLift = (level === 3 ? 0.18 : 0.23) * adaptiveNeed;
    const brightSuppression = (level === 3 ? 0.075 : 0.105) * sceneNeed;
    for (let index = 0; index < data.length; index += info.channels) {
      const pixelIndex = index / info.channels;
      const subjectWeight = maskWeight(pixelIndex);
      const r = data[index],
        g = data[index + 1],
        b = data[index + 2];
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      const midtonePriority = Math.max(
        0.35,
        1 - Math.abs(luminance - 105) / 175,
      );
      const highlightWeight = Math.pow(
        Math.max(0, (luminance - 118) / 137),
        1.15,
      );
      const scale =
        1 +
        faceLift * subjectWeight * midtonePriority -
        brightSuppression * (1 - subjectWeight) * highlightWeight;
      data[index] = Math.round(Math.max(0, Math.min(255, r * scale)));
      data[index + 1] = Math.round(Math.max(0, Math.min(255, g * scale)));
      data[index + 2] = Math.round(Math.max(0, Math.min(255, b * scale)));
    }
  }
  return sharp(data, { raw: info }).png().toBuffer();
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
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process stopped:", details.reason);
    if (details.reason !== "clean-exit" && !win.isDestroyed()) win.reload();
  });
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
    localAdjustments: payload.localAdjustments || {},
  };
  fs.writeFileSync(retouchFile, JSON.stringify(plan, null, 2));
  return { path: retouchFile, updatedAt: plan.updatedAt };
});

ipcMain.handle("retouch:heal-preview", async (_event, payload) => {
  const encoded = String(payload.preview || "").split(",")[1];
  if (!encoded) throw new Error("Preview image is unavailable.");
  const toned = await applyPortraitTone(
    Buffer.from(encoded, "base64"),
    payload.strength || 0,
    payload.retouchOperations,
  );
  const automatic = await applyAutomaticOperations(
    toned,
    payload.retouchOperations,
  );
  const softened = await applyDreamySoften(automatic, payload.retouchOperations);
  const adjusted = await applyLocalAdjustments(
    softened,
    payload.localAdjustments || [],
  );
  const healed = await applyHealOperations(adjusted, payload.operations || []);
  return `data:image/jpeg;base64,${(await sharp(healed).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`;
});

ipcMain.handle("retouch:analyze-blemishes", async (_event, preview) => {
  const encoded = String(preview || "").split(",")[1];
  if (!encoded) throw new Error("Preview image is unavailable.");
  return analyzeBlemishes(Buffer.from(encoded, "base64"));
});

ipcMain.handle("retouch:render-level", async (_event, payload) => {
  const encoded = String(payload.preview || "").split(",")[1];
  if (!encoded) throw new Error("Preview image is unavailable.");
  const toned = await applyPortraitTone(
    Buffer.from(encoded, "base64"),
    payload.strength,
    payload.retouchOperations,
  );
  const automatic = await applyAutomaticOperations(
    toned,
    payload.retouchOperations,
  );
  const softened = await applyDreamySoften(automatic, payload.retouchOperations);
  return `data:image/jpeg;base64,${(await sharp(softened).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer()).toString("base64")}`;
});

function watermarkLibrary() {
  const directory = path.join(app.getPath("userData"), "watermarks");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function savedWatermarks() {
  return fs
    .readdirSync(watermarkLibrary(), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() && [".png", ".svg"].includes(path.extname(entry.name)),
    )
    .map((entry) => {
      const watermarkPath = path.join(watermarkLibrary(), entry.name);
      const extension = path.extname(watermarkPath).toLowerCase();
      const mime = extension === ".svg" ? "image/svg+xml" : "image/png";
      return {
        name: path.basename(entry.name, extension).replace(/-[a-f0-9]{8}$/, ""),
        path: watermarkPath,
        preview: `data:${mime};base64,${fs.readFileSync(watermarkPath).toString("base64")}`,
      };
    });
}

ipcMain.handle("watermark:list", () => savedWatermarks());

ipcMain.handle("watermark:choose-photos", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose photographs to watermark",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "Photographs", extensions: ["jpg", "jpeg", "png", "tif", "tiff", "webp"] },
    ],
  });
  if (result.canceled) return [];
  return result.filePaths.map((filePath) => ({
    name: path.basename(filePath),
    path: filePath,
    type: path.extname(filePath).slice(1).toUpperCase(),
  }));
});

ipcMain.handle("watermark:choose", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a watermark",
    properties: ["openFile"],
    filters: [{ name: "Watermark", extensions: ["png", "svg"] }],
  });
  if (result.canceled) return null;
  const sourcePath = result.filePaths[0];
  const extension = path.extname(sourcePath).toLowerCase();
  const safeName =
    path
      .basename(sourcePath, extension)
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "") || "watermark";
  const hash = crypto
    .createHash("sha256")
    .update(fs.readFileSync(sourcePath))
    .digest("hex")
    .slice(0, 8);
  const savedPath = path.join(
    watermarkLibrary(),
    `${safeName}-${hash}${extension}`,
  );
  if (!fs.existsSync(savedPath)) fs.copyFileSync(sourcePath, savedPath);
  return savedWatermarks().find((item) => item.path === savedPath);
});

ipcMain.handle("watermark:quick-export", async (event, payload) => {
  if (!payload?.files?.length || !payload.outputFolder || !payload.watermark)
    throw new Error("Photographs, output folder, and watermark are required.");
  const failures = [];
  for (const [index, photo] of payload.files.entries()) {
    try {
      event.sender.send("job:progress", {
        kind: "watermark",
        current: index + 1,
        total: payload.files.length,
        message: `Watermarking ${photo.name}`,
      });
      const source = sharp(photo.path).rotate();
      const metadata = await source.metadata();
      const longEdge = Math.max(metadata.width || 0, metadata.height || 0);
      const scale = longEdge > 2048 ? 2048 / longEdge : 1;
      const outputWidth = Math.max(1, Math.round((metadata.width || 2048) * scale));
      const outputHeight = Math.max(1, Math.round((metadata.height || 2048) * scale));
      const markWidth = Math.max(100, Math.round(outputWidth * 0.22));
      const opacity = Math.max(0.05, Math.min(0.5, Number(payload.watermarkOpacity || 18) / 100));
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
        const stepY = Math.max((markMeta.height || 80) + 55, Math.round(outputHeight * 0.27));
        for (let row = 0, top = 35; top < outputHeight; row++, top += stepY) {
          const offset = row % 2 ? Math.round(stepX / 2) : 0;
          for (let left = 25 - offset; left < outputWidth; left += stepX)
            if (left >= 0) overlays.push({ input: mark, left, top, blend: "over" });
        }
      } else overlays.push({ input: mark, gravity: "southeast", blend: "over" });
      const base = path.parse(photo.name).name;
      await sharp(photo.path)
        .rotate()
        .resize({ width: outputWidth, height: outputHeight, fit: "inside", withoutEnlargement: true })
        .composite(overlays)
        .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
        .toFile(path.join(payload.outputFolder, `${base}-watermarked.jpg`));
    } catch (error) {
      failures.push({ name: photo.name, message: error.message });
    }
  }
  const completed = payload.files.length - failures.length;
  event.sender.send("job:progress", {
    kind: "complete",
    current: completed,
    total: payload.files.length,
    message: `Watermark complete: ${completed} photographs`,
  });
  return { completed, failures, outputFolder: payload.outputFolder };
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
  const neutralMasterDir = path.join(payload.outputFolder, "masters-color");
  const watermarkedDir = path.join(payload.outputFolder, "watermarked");
  const workDir = path.join(payload.projectDir, "export-work");
  const cacheDir = path.join(payload.projectDir, "darktable-cache");
  const configDir = path.join(payload.projectDir, "darktable-config");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.mkdirSync(neutralMasterDir, { recursive: true });
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
      const tonedBuffer = await applyPortraitTone(
        developed,
        payload.retouchStrength || 0,
        payload.operations,
      );
      const automaticBuffer = await applyAutomaticOperations(
        tonedBuffer,
        payload.operations,
      );
      const softenedBuffer = await applyDreamySoften(
        automaticBuffer,
        payload.operations,
      );
      const adjustedBuffer = await applyLocalAdjustments(
        softenedBuffer,
        payload.localAdjustments?.[photo.path] || [],
      );
      const healedBuffer = await applyHealOperations(
        adjustedBuffer,
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
      const neutralBuffer = await master
        .jpeg({ quality: 95, chromaSubsampling: "4:4:4" })
        .toBuffer();
      fs.writeFileSync(path.join(neutralMasterDir, `${base}.jpg`), neutralBuffer);
      master = sharp(neutralBuffer);
      if (creativeEdit.style === "Black & White")
        master = master.grayscale().linear(1.18, -18);
      if (creativeEdit.style === "Sepia")
        master = master.grayscale().tint({ r: 112, g: 84, b: 54 });
      if (creativeEdit.style === "Studio Punch")
        master = master.linear(1.1, -8).modulate({ saturation: 1.04 });
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
  const recipePath = path.join(payload.outputFolder, "the-editor-recipe.json");
  fs.writeFileSync(
    recipePath,
    JSON.stringify(
      {
        version: 1,
        exportedAt: new Date().toISOString(),
        sourceFolder: payload.shoot.folder,
        projectDir: payload.projectDir,
        files: payload.shoot.files,
        retouchStrength: payload.retouchStrength || 0,
        operations: payload.operations || [],
        healOperations: payload.healOperations || {},
        localAdjustments: payload.localAdjustments || {},
        creativeEdits: payload.creativeEdits || {},
        outputs: { neutralMasterDir, finalDir, watermarkedDir },
      },
      null,
      2,
    ),
  );
  const result = {
    finalDir,
    neutralMasterDir,
    watermarkedDir,
    recipePath,
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
