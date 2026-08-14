import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type DarktableStatus = { available: boolean; path: string; version?: string };
type Photo = {
  name: string;
  path: string;
  type: string;
  thumbnail?: string | null;
};
type CreatedShoot = {
  projectDir: string;
  previews: (Photo & { preview: string })[];
  failures: { name: string; message: string }[];
  total: number;
};
type Operation = {
  id: string;
  label: string;
  detail: string;
  action: "Auto Retouch" | "Suggested" | "Review" | "Preserve";
  enabled: boolean;
  level: number;
};
type CreativeEdit = {
  style: string;
  crop: string;
  vignette: number;
  cropX: number;
  cropY: number;
};
const defaultCreativeEdit: CreativeEdit = {
  style: "Natural",
  crop: "Original",
  vignette: 0,
  cropX: 50,
  cropY: 50,
};
type Progress = {
  kind: string;
  current: number;
  total: number;
  message: string;
};
type HealOperation = {
  x: number;
  y: number;
  radius: number;
  mode?: "manual" | "suggested";
  kind?: string;
};
type LocalAdjustment = HealOperation & { amount: number };
type BlemishSuggestion = HealOperation & {
  confidence: number;
  score: number;
  kind: string;
};
type SavedWatermark = { name: string; path: string; preview: string };
declare global {
  interface Window {
    editor?: {
      darktableStatus(): Promise<DarktableStatus>;
      chooseShoot(): Promise<{ folder: string; files: Photo[] } | null>;
      getThumbnail(filePath: string): Promise<string | null>;
      createShoot(shoot: {
        folder: string;
        files: Photo[];
      }): Promise<CreatedShoot>;
      saveRetouchPlan(plan: unknown): Promise<{ path: string }>;
      healPreview(payload: {
        preview: string;
        operations: HealOperation[];
        localAdjustments?: LocalAdjustment[];
        strength?: number;
        retouchOperations?: Operation[];
      }): Promise<string>;
      analyzeBlemishes(preview: string): Promise<BlemishSuggestion[]>;
      renderRetouchLevel(payload: {
        preview: string;
        strength: number;
        retouchOperations?: Operation[];
      }): Promise<string>;
      chooseWatermark(): Promise<{ path: string; preview: string } | null>;
      listWatermarks(): Promise<SavedWatermark[]>;
      chooseWatermarkPhotos(): Promise<Photo[]>;
      quickWatermark(payload: unknown): Promise<{
        completed: number;
        failures: { name: string; message: string }[];
        outputFolder: string;
      }>;
      chooseExportFolder(): Promise<string | null>;
      startExport(payload: unknown): Promise<{
        completed: number;
        failures: { name: string; message: string }[];
        finalDir: string;
        watermarkedDir: string;
      }>;
      onProgress(callback: (progress: Progress) => void): () => void;
    };
  }
}

const strengthNames = [
  "None",
  "Cleanup",
  "Natural Portrait",
  "Polished Portrait",
  "Editorial / Beauty",
];
const retouchPreviewKey = (
  photoPath: string,
  strength: number,
  operations: Operation[],
) =>
  `${photoPath}:${strength}:${operations.map((item) => `${item.id}-${item.enabled ? item.level : 0}`).join("|")}`;
const baseOperations: Operation[] = [
  {
    id: "temporary",
    label: "Temporary blemish cleanup",
    detail: "Pimples, small scratches, temporary redness and sensor spots",
    action: "Auto Retouch",
    enabled: true,
    level: 2,
  },
  {
    id: "under-eye",
    label: "Under-eye light reduction",
    detail: "Reduce shadows by 25%; retain natural facial structure",
    action: "Suggested",
    enabled: true,
    level: 2,
  },
  {
    id: "tone",
    label: "Subtle skin tone evening",
    detail: "Texture-aware correction; pores and natural texture preserved",
    action: "Suggested",
    enabled: true,
    level: 2,
  },
  {
    id: "flyaway",
    label: "Isolated flyaway cleanup",
    detail: "Only obvious hairs against simple backgrounds",
    action: "Review",
    enabled: false,
    level: 1,
  },
  {
    id: "identity",
    label: "Moles, freckles, scars & birthmarks",
    detail: "Identity-defining and uncertain features remain untouched",
    action: "Preserve",
    enabled: false,
    level: 0,
  },
  {
    id: "teeth",
    label: "Teeth brightness",
    detail: "Optional mild brightness and yellow-cast reduction",
    action: "Review",
    enabled: false,
    level: 1,
  },
  {
    id: "soften",
    label: "Dreamy soften",
    detail: "Feather-soft glow blended over preserved original detail",
    action: "Review",
    enabled: false,
    level: 2,
  },
];

function App() {
  const [darktable, setDarktable] = useState<DarktableStatus | null>(null);
  const [shoot, setShoot] = useState<{ folder: string; files: Photo[] } | null>(
    null,
  );
  const [created, setCreated] = useState<CreatedShoot | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState("");
  const [stage, setStage] = useState<
    "shoots" | "retouch" | "creative" | "watermark" | "export"
  >("shoots");
  const [selected, setSelected] = useState(0);
  const [compare, setCompare] = useState<"Original" | "Edited" | "Retouched">(
    "Retouched",
  );
  const [splitView, setSplitView] = useState(false);
  const [strength, setStrength] = useState(2);
  const [operations, setOperations] = useState(baseOperations);
  const activeRetouchOperations = operations;
  const [saved, setSaved] = useState("");
  const [zoom, setZoom] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [watermark, setWatermark] = useState("");
  const [watermarkPreview, setWatermarkPreview] = useState("");
  const [watermarkLibrary, setWatermarkLibrary] = useState<SavedWatermark[]>(
    [],
  );
  const [outputFolder, setOutputFolder] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState("");
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [gridDensity, setGridDensity] = useState<"small" | "medium" | "large">(
    "small",
  );
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [watermarkOpacity, setWatermarkOpacity] = useState(18);
  const [tiledWatermark, setTiledWatermark] = useState(true);
  const [quickPhotos, setQuickPhotos] = useState<Photo[]>([]);
  const [quickThumbnails, setQuickThumbnails] = useState<Record<string, string>>({});
  const [quickResult, setQuickResult] = useState("");
  const [creativeEdits, setCreativeEdits] = useState<
    Record<string, CreativeEdit>
  >({});
  const [creativeSelection, setCreativeSelection] = useState<Set<string>>(
    new Set(),
  );
  const [copiedEdit, setCopiedEdit] = useState<CreativeEdit | null>(null);
  const [healMode, setHealMode] = useState(false);
  const [localBrushMode, setLocalBrushMode] = useState<"dodge" | "burn" | null>(
    null,
  );
  const [healRadius, setHealRadius] = useState(0.018);
  const [healOperations, setHealOperations] = useState<
    Record<string, HealOperation[]>
  >({});
  const [localAdjustments, setLocalAdjustments] = useState<
    Record<string, LocalAdjustment[]>
  >({});
  const [healedPreviews, setHealedPreviews] = useState<Record<string, string>>(
    {},
  );
  const [levelPreviews, setLevelPreviews] = useState<Record<string, string>>(
    {},
  );
  const [healing, setHealing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [blemishSuggestions, setBlemishSuggestions] = useState<
    Record<string, BlemishSuggestion[]>
  >({});
  const [brushCursor, setBrushCursor] = useState<{
    x: number;
    y: number;
    size: number;
  } | null>(null);
  const healStrokeRef = useRef<{
    operations: HealOperation[];
    lastX: number;
    lastY: number;
  } | null>(null);
  const localStrokeRef = useRef<{
    operations: LocalAdjustment[];
    lastX: number;
    lastY: number;
  } | null>(null);
  const photoViewRef = useRef<HTMLDivElement>(null);
  const healImageRef = useRef<HTMLImageElement>(null);
  const cropViewRef = useRef<HTMLDivElement>(null);
  const cropDragRef = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
  } | null>(null);
  const dragRef = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  useEffect(() => {
    window.editor?.darktableStatus().then(setDarktable);
    window.editor?.listWatermarks().then(setWatermarkLibrary);
  }, []);
  useEffect(() => window.editor?.onProgress(setProgress), []);
  useEffect(() => {
    if (progress?.kind !== "complete") return;
    const timer = setTimeout(() => setProgress(null), 3500);
    return () => clearTimeout(timer);
  }, [progress]);
  useEffect(() => {
    const selectedCurrent = created?.previews[selected];
    if (!selectedCurrent || !window.editor || strength < 2) return;
    const key = retouchPreviewKey(selectedCurrent.path, strength, operations);
    let cancelled = false;
    const timer = setTimeout(
      () =>
        window.editor
          ?.renderRetouchLevel({
            preview: selectedCurrent.preview,
            strength,
            retouchOperations: activeRetouchOperations,
          })
          .then((preview) => {
            if (!cancelled)
              setLevelPreviews((existing) => ({ ...existing, [key]: preview }));
          }),
      120,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [created, selected, strength, operations]);
  useEffect(() => {
    const selectedCurrent = created?.previews[selected];
    if (!selectedCurrent || !window.editor) return;
    const manualHeals = healOperations[selectedCurrent.path] || [];
    const manualAdjustments = localAdjustments[selectedCurrent.path] || [];
    if (!manualHeals.length && !manualAdjustments.length) return;
    let cancelled = false;
    setHealedPreviews((existing) => {
      const next = { ...existing };
      delete next[selectedCurrent.path];
      return next;
    });
    window.editor
      .healPreview({
        preview: selectedCurrent.preview,
        operations: manualHeals,
        localAdjustments: manualAdjustments,
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) => {
        if (!cancelled)
          setHealedPreviews((existing) => ({
            ...existing,
            [selectedCurrent.path]: preview,
          }));
      })
      .catch((previewError) => {
        if (!cancelled)
          setError(
            `Retouch preview failed: ${previewError instanceof Error ? previewError.message : String(previewError)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [created, selected, strength, operations]);
  useEffect(() => {
    if (!shoot || created || !window.editor) return;
    let cancelled = false;
    const queue = [...shoot.files];
    const worker = async () => {
      while (!cancelled) {
        const photo = queue.shift();
        if (!photo) return;
        const thumbnail = await window.editor?.getThumbnail(photo.path);
        if (!cancelled && thumbnail)
          setThumbnails((current) => ({ ...current, [photo.path]: thumbnail }));
      }
    };
    Promise.all([worker(), worker(), worker()]);
    return () => {
      cancelled = true;
    };
  }, [shoot, created]);
  const chooseShoot = async () => {
    const result = await window.editor?.chooseShoot();
    if (result) {
      setShoot(result);
      setThumbnails({});
      setSelectedPaths(new Set(result.files.map((file) => file.path)));
      setCreated(null);
      setSelected(0);
      setZoom(0);
      setSplitView(false);
      setSaved("");
      setCreativeEdits({});
      setCreativeSelection(new Set());
      setHealOperations({});
      setLocalAdjustments({});
      setHealedPreviews({});
      setLevelPreviews({});
      setBlemishSuggestions({});
      setError("");
      setStage("shoots");
    }
  };
  const createShoot = async () => {
    if (!shoot || !window.editor) return;
    const selectedShoot = {
      ...shoot,
      files: shoot.files.filter((file) => selectedPaths.has(file.path)),
    };
    setProcessing(true);
    setError("");
    try {
      setCreated(await window.editor.createShoot(selectedShoot));
      setShoot(selectedShoot);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Preview generation failed.",
      );
    } finally {
      setProcessing(false);
    }
  };
  const toggleOperation = (id: string) => {
    setOperations((items) =>
      items.map((item) =>
        item.id === id && item.action !== "Preserve"
          ? {
              ...item,
              enabled: !item.enabled,
              level: !item.enabled && item.level === 0 ? 2 : item.level,
            }
          : item,
      ),
    );
    if (id === "tone" || id === "soften") setHealedPreviews({});
  };
  const setOperationLevel = (id: string, level: number) => {
    setOperations((items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, level, enabled: level > 0 && item.action !== "Preserve" }
          : item,
      ),
    );
    if (id === "tone" || id === "soften") setHealedPreviews({});
  };
  const savePlan = async () => {
    if (!created || !window.editor) return;
    const result = await window.editor.saveRetouchPlan({
      projectDir: created.projectDir,
      strength,
      operations,
      healOperations,
      localAdjustments,
    });
    setSaved(`Saved locally · ${result.path}`);
  };
  const chooseWatermark = async () => {
    const value = await window.editor?.chooseWatermark();
    if (value) {
      setWatermark(value.path);
      setWatermarkPreview(value.preview);
      setWatermarkLibrary((existing) => [
        value,
        ...existing.filter((item) => item.path !== value.path),
      ]);
    }
  };
  const selectWatermark = (path: string) => {
    const value = watermarkLibrary.find((item) => item.path === path);
    setWatermark(value?.path || "");
    setWatermarkPreview(value?.preview || "");
  };
  const removeCurrentPhoto = () => {
    if (!created || !current || created.previews.length <= 1) return;
    const remaining = created.previews.filter(
      (photo) => photo.path !== current.path,
    );
    setCreated({
      ...created,
      previews: remaining,
      total: remaining.length,
    });
    setShoot((existing) =>
      existing
        ? {
            ...existing,
            files: existing.files.filter(
              (photo) => photo.path !== current.path,
            ),
          }
        : existing,
    );
    setCreativeSelection((existing) => {
      const next = new Set(existing);
      next.delete(current.path);
      return next;
    });
    setSelected((index) => Math.min(index, remaining.length - 1));
    setSaved("");
  };
  const chooseOutput = async () => {
    const value = await window.editor?.chooseExportFolder();
    if (value) setOutputFolder(value);
  };
  const chooseQuickPhotos = async () => {
    const files = (await window.editor?.chooseWatermarkPhotos()) || [];
    if (!files.length) return;
    setQuickPhotos(files);
    setQuickResult("");
    const previews = await Promise.all(
      files.map(async (photo) => [photo.path, await window.editor?.getThumbnail(photo.path)] as const),
    );
    setQuickThumbnails(Object.fromEntries(previews.filter((item) => item[1])) as Record<string, string>);
  };
  const startQuickWatermark = async () => {
    if (!quickPhotos.length || !watermark || !outputFolder || !window.editor) return;
    setExporting(true);
    setQuickResult("");
    try {
      const result = await window.editor.quickWatermark({
        files: quickPhotos,
        watermark,
        outputFolder,
        watermarkOpacity,
        tiledWatermark,
      });
      setQuickResult(
        `${result.completed} watermarked · Saved to ${result.outputFolder}${result.failures.length ? ` · ${result.failures.length} failed` : ""}`,
      );
    } catch (reason) {
      setQuickResult(reason instanceof Error ? reason.message : "Watermark export failed.");
    } finally {
      setExporting(false);
    }
  };
  const startExport = async () => {
    if (!created || !shoot || !watermark || !outputFolder || !window.editor)
      return;
    setExporting(true);
    setExportResult("");
    try {
      const result = await window.editor.startExport({
        created,
        projectDir: created.projectDir,
        shoot,
        watermark,
        outputFolder,
        watermarkOpacity,
        tiledWatermark,
        creativeEdits,
        healOperations,
        localAdjustments,
        retouchStrength: strength,
      });
      setExportResult(
        `${result.completed} exported · Masters: ${result.finalDir} · Watermarked: ${result.watermarkedDir}${result.failures.length ? ` · ${result.failures.length} failed` : ""}`,
      );
    } catch (reason) {
      setExportResult(
        reason instanceof Error ? reason.message : "Export failed.",
      );
    } finally {
      setExporting(false);
    }
  };
  const togglePhoto = (photo: Photo) => {
    if (created) return;
    setSelectedPaths((current) => {
      const next = new Set(current);
      next.has(photo.path) ? next.delete(photo.path) : next.add(photo.path);
      return next;
    });
  };
  const startPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!zoom || !photoViewRef.current) return;
    const view = photoViewRef.current;
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: view.scrollLeft,
      top: view.scrollTop,
    };
    view.setPointerCapture(event.pointerId);
  };
  const movePan = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current,
      view = photoViewRef.current;
    if (!start || !view) return;
    view.scrollLeft = start.left - (event.clientX - start.x);
    view.scrollTop = start.top - (event.clientY - start.y);
  };
  const stopPan = () => {
    dragRef.current = null;
  };
  const pointFromHealEvent = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((!healMode && !localBrushMode) || !current || !healImageRef.current)
      return false;
    const rect = healImageRef.current.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      return false;
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      radius: healRadius,
    };
  };
  const renderHeals = (operations: HealOperation[]) => {
    if (!current) return;
    const photoPath = current.path;
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations,
        localAdjustments: localAdjustments[current.path] || [],
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [photoPath]: preview,
        })),
      )
      .catch((healError) => {
        setError(
          `Heal preview failed: ${healError instanceof Error ? healError.message : String(healError)}`,
        );
      })
      .finally(() => setHealing(false));
  };
  const startHealStroke = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointFromHealEvent(event);
    if (!point || !current) return false;
    const operations = [...(healOperations[current.path] || []), point];
    healStrokeRef.current = {
      operations,
      lastX: point.x,
      lastY: point.y,
    };
    photoViewRef.current?.setPointerCapture(event.pointerId);
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    return true;
  };
  const continueHealStroke = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!healStrokeRef.current || !current) return;
    const point = pointFromHealEvent(event);
    if (!point) return;
    const distance = Math.hypot(
      point.x - healStrokeRef.current.lastX,
      point.y - healStrokeRef.current.lastY,
    );
    if (distance < healRadius * 1.15) return;
    if (healStrokeRef.current.operations.length >= 80) return;
    healStrokeRef.current.operations.push(point);
    healStrokeRef.current.lastX = point.x;
    healStrokeRef.current.lastY = point.y;
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: [...healStrokeRef.current!.operations],
    }));
  };
  const endHealStroke = () => {
    if (!healStrokeRef.current) return;
    const operations = [...healStrokeRef.current.operations];
    healStrokeRef.current = null;
    renderHeals(operations);
  };
  const startLocalStroke = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointFromHealEvent(event);
    if (!point || !current || !localBrushMode || healing) return false;
    const operation = {
      ...point,
      amount: localBrushMode === "dodge" ? 0.055 : -0.055,
    };
    const operations = [...(localAdjustments[current.path] || []), operation];
    localStrokeRef.current = {
      operations,
      lastX: point.x,
      lastY: point.y,
    };
    photoViewRef.current?.setPointerCapture(event.pointerId);
    setLocalAdjustments((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    return true;
  };
  const continueLocalStroke = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!localStrokeRef.current || !current || !localBrushMode) return;
    const point = pointFromHealEvent(event);
    if (!point) return;
    const distance = Math.hypot(
      point.x - localStrokeRef.current.lastX,
      point.y - localStrokeRef.current.lastY,
    );
    if (
      distance < healRadius * 1.55 ||
      localStrokeRef.current.operations.length >= 80
    )
      return;
    localStrokeRef.current.operations.push({
      ...point,
      amount: localBrushMode === "dodge" ? 0.055 : -0.055,
    });
    localStrokeRef.current.lastX = point.x;
    localStrokeRef.current.lastY = point.y;
    setLocalAdjustments((existing) => ({
      ...existing,
      [current.path]: [...localStrokeRef.current!.operations],
    }));
  };
  const endLocalStroke = () => {
    if (!localStrokeRef.current || !current) return;
    const adjustments = [...localStrokeRef.current.operations];
    localStrokeRef.current = null;
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations: healOperations[current.path] || [],
        localAdjustments: adjustments,
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [current.path]: preview,
        })),
      )
      .catch((brushError) =>
        setError(
          `Local brush failed: ${brushError instanceof Error ? brushError.message : String(brushError)}`,
        ),
      )
      .finally(() => setHealing(false));
  };
  const undoLocalAdjustment = () => {
    if (!current) return;
    const adjustments = (localAdjustments[current.path] || []).slice(0, -1);
    setLocalAdjustments((existing) => ({
      ...existing,
      [current.path]: adjustments,
    }));
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations: healOperations[current.path] || [],
        localAdjustments: adjustments,
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [current.path]: preview,
        })),
      )
      .finally(() => setHealing(false));
  };
  const trackBrush = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      (!healMode && !localBrushMode) ||
      !healImageRef.current ||
      !photoViewRef.current
    ) {
      setBrushCursor(null);
      return;
    }
    const imageRect = healImageRef.current.getBoundingClientRect();
    const viewRect = photoViewRef.current.getBoundingClientRect();
    if (
      event.clientX < imageRect.left ||
      event.clientX > imageRect.right ||
      event.clientY < imageRect.top ||
      event.clientY > imageRect.bottom
    ) {
      setBrushCursor(null);
      return;
    }
    setBrushCursor({
      x: event.clientX - viewRect.left + photoViewRef.current.scrollLeft,
      y: event.clientY - viewRect.top + photoViewRef.current.scrollTop,
      size: Math.max(
        8,
        healRadius * Math.min(imageRect.width, imageRect.height) * 2,
      ),
    });
  };
  const undoHeal = () => {
    if (!current) return;
    const operations = (healOperations[current.path] || []).slice(0, -1);
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    if (!operations.length) {
      setHealedPreviews((existing) => {
        const next = { ...existing };
        delete next[current.path];
        return next;
      });
      return;
    }
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations,
        localAdjustments: localAdjustments[current.path] || [],
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [current.path]: preview,
        })),
      )
      .finally(() => setHealing(false));
  };
  const analyzeCurrent = async () => {
    if (!current || !window.editor) return;
    setAnalyzing(true);
    setAnalysisMessage("");
    setHealMode(false);
    setCompare("Retouched");
    setSplitView(false);
    try {
      const suggestions = await window.editor.analyzeBlemishes(current.preview);
      setBlemishSuggestions((existing) => ({
        ...existing,
        [current.path]: suggestions,
      }));
      setAnalysisMessage(
        suggestions.length
          ? `${suggestions.length} possible temporary blemish${suggestions.length === 1 ? "" : "es"} found. Click a marker to accept it.`
          : "No confident temporary blemishes were found in this photo. You can still use the Heal brush manually.",
      );
    } finally {
      setAnalyzing(false);
    }
  };
  const applySuggestion = (suggestion: BlemishSuggestion) => {
    if (!current) return;
    const operations = [
      ...(healOperations[current.path] || []),
      {
        x: suggestion.x,
        y: suggestion.y,
        radius: suggestion.radius,
        mode: "suggested" as const,
        kind: suggestion.kind,
      },
    ];
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    setBlemishSuggestions((existing) => ({
      ...existing,
      [current.path]: (existing[current.path] || []).filter(
        (item) => item !== suggestion,
      ),
    }));
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations,
        localAdjustments: localAdjustments[current.path] || [],
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [current.path]: preview,
        })),
      )
      .finally(() => setHealing(false));
  };
  const acceptHighConfidence = () => {
    if (!current) return;
    const accepted = (blemishSuggestions[current.path] || []).filter(
      (item) => item.confidence >= 82,
    );
    if (!accepted.length) return;
    const operations = [
      ...(healOperations[current.path] || []),
      ...accepted.map(({ x, y, radius, kind }) => ({
        x,
        y,
        radius,
        kind,
        mode: "suggested" as const,
      })),
    ];
    setHealOperations((existing) => ({
      ...existing,
      [current.path]: operations,
    }));
    setBlemishSuggestions((existing) => ({
      ...existing,
      [current.path]: (existing[current.path] || []).filter(
        (item) => item.confidence < 82,
      ),
    }));
    setHealing(true);
    window.editor
      ?.healPreview({
        preview: current.preview,
        operations,
        localAdjustments: localAdjustments[current.path] || [],
        strength,
        retouchOperations: activeRetouchOperations,
      })
      .then((preview) =>
        setHealedPreviews((existing) => ({
          ...existing,
          [current.path]: preview,
        })),
      )
      .finally(() => setHealing(false));
  };
  const current = created?.previews[selected];
  const currentEdit = current
    ? creativeEdits[current.path] || defaultCreativeEdit
    : defaultCreativeEdit;
  const updateCreative = (change: Partial<CreativeEdit>) => {
    if (!created || !current) return;
    const targets = creativeSelection.size
      ? creativeSelection
      : new Set([current.path]);
    setCreativeEdits((existing) => {
      const next = { ...existing };
      for (const target of targets)
        next[target] = {
          ...(existing[target] || defaultCreativeEdit),
          ...change,
        };
      return next;
    });
  };
  const toggleCreativePhoto = (
    photoPath: string,
    index: number,
    additive: boolean,
  ) => {
    setSelected(index);
    setCreativeSelection((existing) => {
      if (!additive) return new Set([photoPath]);
      const next = new Set(existing);
      next.has(photoPath) ? next.delete(photoPath) : next.add(photoPath);
      return next;
    });
  };
  const pasteCreative = () => {
    if (copiedEdit) updateCreative(copiedEdit);
  };
  const resetCreative = () => updateCreative(defaultCreativeEdit);
  const startCropDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (currentEdit.crop === "Original" || !cropViewRef.current) return;
    cropDragRef.current = {
      x: event.clientX,
      y: event.clientY,
      startX: currentEdit.cropX,
      startY: currentEdit.cropY,
    };
    cropViewRef.current.setPointerCapture(event.pointerId);
  };
  const moveCropDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!cropDragRef.current || !cropViewRef.current) return;
    const rect = cropViewRef.current.getBoundingClientRect();
    updateCreative({
      cropX: Math.max(
        0,
        Math.min(
          100,
          cropDragRef.current.startX +
            ((event.clientX - cropDragRef.current.x) / rect.width) * 100,
        ),
      ),
      cropY: Math.max(
        0,
        Math.min(
          100,
          cropDragRef.current.startY +
            ((event.clientY - cropDragRef.current.y) / rect.height) * 100,
        ),
      ),
    });
  };
  const stopCropDrag = () => {
    cropDragRef.current = null;
  };
  const activeCount = operations.filter(
    (operation) => operation.enabled,
  ).length;
  const retouchFilter =
    strength === 0
      ? "none"
      : `brightness(${1 + strength * 0.012}) contrast(${1 + strength * 0.018}) saturate(${1 + strength * 0.014})`;
  const editedFilter = "brightness(1.025) contrast(1.035) saturate(1.025)";
  const creativeFilter =
    currentEdit.style === "Black & White"
      ? "grayscale(1) brightness(1.015) contrast(1.18)"
      : currentEdit.style === "Sepia"
        ? "grayscale(1) sepia(.72) contrast(1.04)"
        : currentEdit.style === "Studio Punch"
          ? "brightness(1.01) contrast(1.13) saturate(1.04)"
        : currentEdit.style === "High Contrast"
          ? "contrast(1.28) saturate(1.15)"
          : "none";
  const cropRatio =
    currentEdit.crop === "Original"
      ? undefined
      : currentEdit.crop
          .split(":")
          .map(Number)
          .reduce((a, b) => a / b);

  return (
    <main>
      <aside>
        <div className="brand">
          <span className="mark">C</span>
          <div>
            <strong>THE EDITOR</strong>
            <small>Capture the Chapter Studio</small>
          </div>
        </div>
        <nav>
          <button
            className={stage === "shoots" ? "active" : ""}
            onClick={() => setStage("shoots")}
          >
            ⌂ <span>Shoots</span>
          </button>
          <button
            className={stage === "retouch" ? "active" : ""}
            disabled={!created}
            onClick={() => created && setStage("retouch")}
          >
            ✦ <span>Retouch review</span>
          </button>
          <button
            className={stage === "creative" ? "active" : ""}
            disabled={!created}
            onClick={() => created && setStage("creative")}
          >
            ◫ <span>Editing profiles</span>
          </button>
          <button
            className={stage === "watermark" ? "active" : ""}
            onClick={() => setStage("watermark")}
          >
            ◇ <span>Watermarks</span>
          </button>
          <button
            className={stage === "export" ? "active" : ""}
            disabled={!created}
            onClick={() => created && setStage("export")}
          >
            ⇩ <span>Export setup</span>
          </button>
        </nav>
        <div className="engine">
          <span className={darktable?.available ? "dot good" : "dot"} />
          <div>
            <b>
              {darktable?.available
                ? `darktable ${darktable.version}`
                : "Checking darktable"}
            </b>
            <small>
              {darktable?.available
                ? "RAW engine ready"
                : "RAW engine unavailable"}
            </small>
          </div>
        </div>
      </aside>
      <section className="content">
        {stage === "watermark" ? (
          <div className="exportStage quickWatermarkStage">
            <header>
              <div>
                <p className="eyebrow">STANDALONE TOOL · ORIGINALS UNCHANGED</p>
                <h1>Quick watermark</h1>
              </div>
              <button className="secondary" onClick={() => setStage("shoots")}>
                ← Back to shoots
              </button>
            </header>
            <div className="exportIntro">
              <p className="eyebrow">ONE PHOTO OR A SMALL BATCH</p>
              <h2>Protect finished photographs without creating a shoot.</h2>
              <p>
                Choose existing JPEG, PNG, TIFF, or WebP files. The Editor creates
                new 2048 px watermarked JPEG copies and never changes the originals.
              </p>
            </div>
            <div className="quickWatermarkGrid">
              <article className="quickStep">
                <span className="exportIcon">1</span>
                <div>
                  <h3>Choose photographs</h3>
                  <p>{quickPhotos.length ? `${quickPhotos.length} selected` : "No photographs selected"}</p>
                </div>
                <button className="secondary" onClick={chooseQuickPhotos}>
                  {quickPhotos.length ? "Choose different photos" : "Choose photos"}
                </button>
              </article>
              {quickPhotos.length > 0 && (
                <div className="quickPhotoStrip">
                  {quickPhotos.map((photo) => (
                    <div className="quickPhoto" key={photo.path}>
                      {quickThumbnails[photo.path] ? (
                        <img src={quickThumbnails[photo.path]} alt={photo.name} />
                      ) : (
                        <span>Loading…</span>
                      )}
                      <b>{photo.name}</b>
                      <button
                        aria-label={`Remove ${photo.name}`}
                        onClick={() => setQuickPhotos((items) => items.filter((item) => item.path !== photo.path))}
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
              <article className="quickStep">
                <span className="exportIcon">2</span>
                <div>
                  <h3>Choose saved watermark</h3>
                  <p>{watermark ? "Watermark ready" : "Select or upload a watermark"}</p>
                  {watermarkPreview && <img className="quickMarkPreview" src={watermarkPreview} alt="Selected watermark" />}
                </div>
                <div className="watermarkPicker">
                  {watermarkLibrary.length > 0 && (
                    <select value={watermark} onChange={(event) => selectWatermark(event.target.value)}>
                      <option value="">Select saved watermark</option>
                      {watermarkLibrary.map((item) => <option key={item.path} value={item.path}>{item.name}</option>)}
                    </select>
                  )}
                  <button className="secondary" onClick={chooseWatermark}>Upload new watermark</button>
                </div>
              </article>
            </div>
            <div className="watermarkOptions">
              <label>
                <input type="checkbox" checked={tiledWatermark} onChange={(event) => setTiledWatermark(event.target.checked)} />
                <span><b>Repeat across photograph</b><small>Turn off for one bottom-right mark.</small></span>
              </label>
              <label className="opacity">
                <span><b>Watermark opacity</b><small>Adjust protection and visibility.</small></span>
                <input type="range" min="5" max="40" value={watermarkOpacity} onChange={(event) => setWatermarkOpacity(Number(event.target.value))} />
                <strong>{watermarkOpacity}%</strong>
              </label>
            </div>
            <div className="destination">
              <div><b>Save copies to</b><span>{outputFolder || "Choose an output folder."}</span></div>
              <button className="secondary" onClick={chooseOutput}>{outputFolder ? "Change folder" : "Choose folder"}</button>
            </div>
            <div className="exportFooter">
              <div>
                <b>{quickPhotos.length} photograph{quickPhotos.length === 1 ? "" : "s"} queued</b>
                <span>Files will be named with “-watermarked” and originals stay untouched.</span>
              </div>
              <button className="primary" onClick={startQuickWatermark} disabled={!quickPhotos.length || !watermark || !outputFolder || exporting}>
                {exporting ? "Watermarking…" : "Create watermarked copies →"}
              </button>
            </div>
            {quickResult && <div className="notice success"><b>Quick watermark result</b><span>{quickResult}</span></div>}
          </div>
        ) : stage === "export" && created ? (
          <div className="exportStage">
            <header>
              <div>
                <p className="eyebrow">FINAL STEP · DUAL EXPORT</p>
                <h1>Export setup</h1>
              </div>
              <button
                className="secondary"
                onClick={() => setStage("creative")}
              >
                ← Back to creative review
              </button>
            </header>
            <div className="exportIntro">
              <p className="eyebrow">ONE BATCH · TWO DELIVERABLES</p>
              <h2>Clean masters and client-ready copies.</h2>
              <p>
                Darktable development is applied to both outputs and originals
                remain untouched. Retouch choices remain saved separately until
                the pixel-retouching engine is connected.
              </p>
            </div>
            <div className="exportCards">
              <article>
                <span className="exportIcon">M</span>
                <div>
                  <p className="eyebrow">MASTERS</p>
                  <h3>Full-resolution clean JPEGs</h3>
                  <ul>
                    <li>JPEG quality 95</li>
                    <li>Full resolution</li>
                    <li>sRGB output</li>
                    <li>No watermark</li>
                  </ul>
                  <code>
                    {outputFolder ? `${outputFolder}\\final` : "final/"}
                  </code>
                </div>
                <span className="ready">Ready</span>
              </article>
              <article>
                <span className="exportIcon">W</span>
                <div>
                  <p className="eyebrow">CLIENT / WEB</p>
                  <h3>Protected proof JPEGs</h3>
                  <ul>
                    <li>2048 px long edge</li>
                    <li>JPEG quality 88</li>
                    <li>
                      {tiledWatermark
                        ? "Repeated across photograph"
                        : "Single bottom-right mark"}
                    </li>
                    <li>{watermarkOpacity}% opacity</li>
                  </ul>
                  <code>{watermark || "No watermark selected"}</code>
                  {watermarkPreview && (
                    <div className="watermarkPreview">
                      <img src={watermarkPreview} alt="Selected watermark" />
                      <span>Selected watermark preview</span>
                    </div>
                  )}
                </div>
                <div className="watermarkPicker">
                  {watermarkLibrary.length > 0 && (
                    <select
                      aria-label="Saved watermark"
                      value={watermark}
                      onChange={(event) => selectWatermark(event.target.value)}
                    >
                      <option value="">Select saved watermark</option>
                      {watermarkLibrary.map((item) => (
                        <option key={item.path} value={item.path}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="secondary" onClick={chooseWatermark}>
                    Upload new watermark
                  </button>
                </div>
              </article>
            </div>
            <div className="watermarkOptions">
              <label>
                <input
                  type="checkbox"
                  checked={tiledWatermark}
                  onChange={(event) => setTiledWatermark(event.target.checked)}
                />
                <span>
                  <b>Repeat watermark across photograph</b>
                  <small>
                    Recommended for client proofs; makes cropping the watermark
                    out difficult.
                  </small>
                </span>
              </label>
              <label className="opacity">
                <span>
                  <b>Watermark opacity</b>
                  <small>
                    Light enough to view the image while protecting it.
                  </small>
                </span>
                <input
                  type="range"
                  min="5"
                  max="40"
                  value={watermarkOpacity}
                  onChange={(event) =>
                    setWatermarkOpacity(Number(event.target.value))
                  }
                />
                <strong>{watermarkOpacity}%</strong>
              </label>
            </div>
            <div className="creativeSummary">
              <div>
                <p className="eyebrow">APPROVED CREATIVE EDITS</p>
                <b>
                  {Object.keys(creativeEdits).length} individualized ·{" "}
                  {created.previews.length - Object.keys(creativeEdits).length}{" "}
                  natural defaults
                </b>
                <span>
                  Each photograph will export using its assigned look, crop, and
                  vignette.
                </span>
              </div>
              <button
                className="secondary"
                onClick={() => setStage("creative")}
              >
                Review or change
              </button>
            </div>
            <div className="destination">
              <div>
                <b>Export destination</b>
                <span>
                  {outputFolder ||
                    "Choose where the final and watermarked folders will be created."}
                </span>
              </div>
              <button className="secondary" onClick={chooseOutput}>
                {outputFolder ? "Change folder" : "Choose folder"}
              </button>
            </div>
            <div className="exportFooter">
              <div>
                <b>{created.total} selected photographs queued</b>
                <span>
                  {watermark && outputFolder
                    ? "Ready for simultaneous master and protected-proof export."
                    : "Choose a watermark and destination to continue."}
                </span>
              </div>
              <button
                className="primary"
                onClick={startExport}
                disabled={!watermark || !outputFolder || exporting}
              >
                {exporting ? "Exporting…" : "Start dual export →"}
              </button>
            </div>
            {exportResult && (
              <div className="notice success">
                <b>Export result</b>
                <span>{exportResult}</span>
                <div className="exportAgainActions">
                  <button
                    className="secondary"
                    onClick={() => setStage("retouch")}
                  >
                    Back to retouch
                  </button>
                  <button
                    className="secondary"
                    onClick={() => setStage("creative")}
                  >
                    Back to creative review
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : stage === "creative" && created ? (
          <div className="creativeStage">
            <header>
              <div>
                <p className="eyebrow">CREATIVE REVIEW · NON-DESTRUCTIVE</p>
                <h1>Crop and finishing look</h1>
              </div>
              <div className="headerActions">
                <button
                  className="secondary"
                  onClick={() => setStage("retouch")}
                >
                  ← Back to retouch
                </button>
                <button className="primary" onClick={() => setStage("export")}>
                  Approve & continue to export →
                </button>
              </div>
            </header>
            <div className="creativeLayout">
              <div className="creativeViewer">
                {current ? (
                  <div
                    ref={cropViewRef}
                    className="creativeCanvas"
                    style={{ aspectRatio: cropRatio }}
                    onPointerDown={startCropDrag}
                    onPointerMove={moveCropDrag}
                    onPointerUp={stopCropDrag}
                    onPointerCancel={stopCropDrag}
                  >
                    <img
                      src={current.preview}
                      alt={current.name}
                      style={{
                        filter: creativeFilter,
                        objectFit:
                          currentEdit.crop === "Original" ? "contain" : "cover",
                        objectPosition: `${currentEdit.cropX}% ${currentEdit.cropY}%`,
                      }}
                    />
                    <i style={{ opacity: currentEdit.vignette / 100 }} />
                    {currentEdit.crop !== "Original" && (
                      <>
                        <div className="cropGrid">
                          <span />
                          <span />
                          <span />
                          <span />
                        </div>
                        <div className="cropPosition">
                          Drag to reframe · {Math.round(currentEdit.cropX)}%,{" "}
                          {Math.round(currentEdit.cropY)}%
                        </div>
                      </>
                    )}
                  </div>
                ) : (
                  <div className="placeholder">No preview available</div>
                )}
                <div className="photoMeta">
                  <b>{current?.name}</b>
                  <span>
                    {selected + 1} of {created.previews.length} ·{" "}
                    {currentEdit.crop} crop · {currentEdit.style}
                  </span>
                </div>
              </div>
              <div className="creativeControls">
                <p className="eyebrow">LOOK</p>
                <div className="lookGrid">
                  {[
                    "Natural",
                    "Black & White",
                    "Studio Punch",
                    "Sepia",
                    "High Contrast",
                  ].map((style) => (
                      <button
                        key={style}
                        className={
                          currentEdit.style === style ? "selected" : ""
                        }
                        onClick={() => updateCreative({ style })}
                      >
                        <span
                          className={`lookSwatch look-${style.toLowerCase().replaceAll(" ", "-")}`}
                        />
                        <b>{style}</b>
                      </button>
                  ))}
                </div>
                <div className="creativeControl">
                  <label htmlFor="crop">Crop ratio</label>
                  <select
                    id="crop"
                    value={currentEdit.crop}
                    onChange={(event) =>
                      updateCreative({ crop: event.target.value })
                    }
                  >
                    {["Original", "1:1", "4:5", "3:2", "16:9"].map((aspect) => (
                      <option key={aspect}>{aspect}</option>
                    ))}
                  </select>
                  <small>
                    Choose a ratio, then drag the photograph in the preview to
                    reframe it.
                  </small>
                </div>
                <div className="creativeControl">
                  <label htmlFor="vignette">
                    Vignette <strong>{currentEdit.vignette}%</strong>
                  </label>
                  <input
                    id="vignette"
                    type="range"
                    min="0"
                    max="60"
                    value={currentEdit.vignette}
                    onChange={(event) =>
                      updateCreative({ vignette: Number(event.target.value) })
                    }
                  />
                  <small>Darkens the edges to draw attention inward.</small>
                </div>
                <div className="editTools">
                  <button onClick={() => setCopiedEdit(currentEdit)}>
                    Copy edit
                  </button>
                  <button disabled={!copiedEdit} onClick={pasteCreative}>
                    Paste to selected
                  </button>
                  <button onClick={resetCreative}>Reset selected</button>
                </div>
                <p className="selectionHint">
                  {creativeSelection.size || 1} photo
                  {(creativeSelection.size || 1) === 1 ? "" : "s"} targeted.
                  Ctrl-click thumbnails to select multiple.
                </p>
              </div>
            </div>
            <div className="filmstrip">
              {created.previews.map((photo, i) => (
                <button
                  key={photo.path}
                  className={`${i === selected ? "selected" : ""} ${creativeSelection.has(photo.path) ? "multiSelected" : ""}`}
                  onClick={(event) =>
                    toggleCreativePhoto(
                      photo.path,
                      i,
                      event.ctrlKey || event.metaKey,
                    )
                  }
                >
                  <img src={photo.preview} alt="" />
                  <span>{i + 1}</span>
                  <em>
                    {(creativeEdits[photo.path] || defaultCreativeEdit).style}
                  </em>
                </button>
              ))}
            </div>
          </div>
        ) : stage === "retouch" && created ? (
          <div className="retouch">
            <header>
              <div>
                <p className="eyebrow">RETOUCH ANALYSIS · NON-DESTRUCTIVE</p>
                <h1>Natural portrait review</h1>
              </div>
              <div className="headerActions">
                <button
                  className="secondary"
                  onClick={() => setStage("shoots")}
                >
                  ← Back to shoot
                </button>
                <button
                  className="secondary removePhoto"
                  onClick={removeCurrentPhoto}
                  disabled={created.previews.length <= 1}
                  title={
                    created.previews.length <= 1
                      ? "A shoot must keep at least one photo"
                      : "Remove this photo from retouch, creative review, and export"
                  }
                >
                  Remove this photo
                </button>
                <div className="compare">
                  {(["Original", "Edited", "Retouched"] as const).map(
                    (mode) => (
                      <button
                        className={
                          compare === mode && !splitView ? "selected" : ""
                        }
                        onClick={() => {
                          setCompare(mode);
                          setSplitView(false);
                        }}
                        key={mode}
                      >
                        {mode}
                      </button>
                    ),
                  )}
                  <button
                    className={splitView ? "selected" : ""}
                    onClick={() => setSplitView((value) => !value)}
                  >
                    Split
                  </button>
                </div>
              </div>
            </header>
            <div className="retouchLayout">
              <div className="canvasPanel">
                <div className="zoomBar">
                  <button
                    className={healMode ? "selected healActive" : ""}
                    onClick={() => {
                      setHealMode((value) => !value);
                      setLocalBrushMode(null);
                      setSplitView(false);
                      setCompare("Retouched");
                    }}
                  >
                    Heal brush
                  </button>
                  <button
                    className={localBrushMode === "dodge" ? "selected" : ""}
                    onClick={() => {
                      setLocalBrushMode((value) =>
                        value === "dodge" ? null : "dodge",
                      );
                      setHealMode(false);
                      setSplitView(false);
                      setCompare("Retouched");
                    }}
                  >
                    Dodge
                  </button>
                  <button
                    className={localBrushMode === "burn" ? "selected" : ""}
                    onClick={() => {
                      setLocalBrushMode((value) =>
                        value === "burn" ? null : "burn",
                      );
                      setHealMode(false);
                      setSplitView(false);
                      setCompare("Retouched");
                    }}
                  >
                    Burn
                  </button>
                  <button
                    onClick={() => setZoom(0)}
                    className={zoom === 0 ? "selected" : ""}
                  >
                    Fit
                  </button>
                  <label className="brushSize">
                    Brush{" "}
                    <input
                      type="range"
                      min="8"
                      max="60"
                      value={Math.round(healRadius * 1000)}
                      onChange={(event) =>
                        setHealRadius(Number(event.target.value) / 1000)
                      }
                    />
                  </label>
                  <button
                    disabled={!current || !healOperations[current.path]?.length}
                    onClick={undoHeal}
                  >
                    Undo heal
                  </button>
                  <button
                    disabled={
                      !current || !localAdjustments[current.path]?.length
                    }
                    onClick={undoLocalAdjustment}
                  >
                    Undo dodge/burn
                  </button>
                  <button
                    onClick={analyzeCurrent}
                    disabled={!current || analyzing}
                  >
                    {analyzing ? "Analyzing…" : "Find blemishes"}
                  </button>
                  <button
                    onClick={acceptHighConfidence}
                    disabled={
                      !current ||
                      !(blemishSuggestions[current.path] || []).some(
                        (item) => item.confidence >= 82,
                      )
                    }
                  >
                    Accept 82%+
                  </button>
                  <button
                    disabled={
                      !current ||
                      !(blemishSuggestions[current.path] || []).length
                    }
                    onClick={() =>
                      current &&
                      setBlemishSuggestions((existing) => ({
                        ...existing,
                        [current.path]: [],
                      }))
                    }
                  >
                    Dismiss suggestions
                  </button>
                  <button
                    onClick={() => setZoom(100)}
                    className={zoom === 100 ? "selected" : ""}
                  >
                    100%
                  </button>
                  <button
                    aria-label="Zoom out"
                    onClick={() =>
                      setZoom((value) => Math.max(50, (value || 100) - 25))
                    }
                  >
                    −
                  </button>
                  <span>{zoom === 0 ? "Fit" : `${zoom}%`}</span>
                  <button
                    aria-label="Zoom in"
                    onClick={() =>
                      setZoom((value) => Math.min(400, (value || 100) + 25))
                    }
                  >
                    ＋
                  </button>
                </div>
                {analysisMessage && (
                  <div className="analysisMessage">{analysisMessage}</div>
                )}
                {current ? (
                  <>
                    <div
                      ref={photoViewRef}
                      onPointerDown={(event) => {
                        const started = healMode
                          ? startHealStroke(event)
                          : localBrushMode
                            ? startLocalStroke(event)
                            : false;
                        if (!started) startPan(event);
                      }}
                      onPointerMove={(event) => {
                        trackBrush(event);
                        if (healMode) continueHealStroke(event);
                        else if (localBrushMode) continueLocalStroke(event);
                        else movePan(event);
                      }}
                      onPointerUp={() => {
                        endHealStroke();
                        endLocalStroke();
                        stopPan();
                      }}
                      onPointerCancel={() => {
                        endHealStroke();
                        endLocalStroke();
                        stopPan();
                      }}
                      onPointerLeave={() => setBrushCursor(null)}
                      className={`photoView ${zoom && !healMode && !localBrushMode ? "zoomed pannable" : zoom ? "zoomed healCanvas" : healMode || localBrushMode ? "healCanvas" : ""}`}
                    >
                      {splitView ? (
                        <div className="splitPreview">
                          <div>
                            <img
                              draggable={false}
                              src={current.preview}
                              alt="Original proxy"
                            />
                            <span>Original proxy</span>
                          </div>
                          <div>
                            <img
                              draggable={false}
                              src={
                                healedPreviews[current.path] ||
                                levelPreviews[
                                  retouchPreviewKey(
                                    current.path,
                                    strength,
                                    operations,
                                  )
                                ] ||
                                current.preview
                              }
                              alt={`Rendered Level ${strength} retouch`}
                            />
                            <span>
                              {strength < 2
                                ? `Core retouch · Level ${strength}`
                                : levelPreviews[
                                      retouchPreviewKey(
                                        current.path,
                                        strength,
                                        operations,
                                      )
                                    ]
                                  ? `Rendered retouch · Level ${strength}`
                                  : "Rendering…"}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="healImageStage">
                          <img
                            ref={healImageRef}
                            draggable={false}
                            style={{
                              ...(zoom ? { width: `${zoom}%` } : {}),
                              filter:
                                compare === "Edited" ? editedFilter : "none",
                            }}
                            src={
                              compare === "Retouched"
                                ? healedPreviews[current.path] ||
                                  levelPreviews[
                                    retouchPreviewKey(
                                      current.path,
                                      strength,
                                      operations,
                                    )
                                  ] ||
                                  current.preview
                                : current.preview
                            }
                            alt={current.name}
                          />
                          {(blemishSuggestions[current.path] || []).map(
                            (suggestion, index) => (
                              <button
                                key={`${suggestion.x}-${suggestion.y}-${index}`}
                                className={`blemishMarker ${suggestion.confidence >= 82 ? "high" : ""}`}
                                style={{
                                  left: `${suggestion.x * 100}%`,
                                  top: `${suggestion.y * 100}%`,
                                }}
                                title={`${suggestion.kind} · ${suggestion.confidence}% heuristic confidence — click to heal`}
                                onPointerDown={(event) =>
                                  event.stopPropagation()
                                }
                                onClick={() => applySuggestion(suggestion)}
                              >
                                <span>
                                  {suggestion.kind} · {suggestion.confidence}%
                                </span>
                              </button>
                            ),
                          )}
                        </div>
                      )}{" "}
                      {compare === "Retouched" && !splitView && (
                        <span className="previewBadge">
                          {healing
                            ? "Rendering local work…"
                            : `${healOperations[current.path]?.length || 0} healed · ${localAdjustments[current.path]?.length || 0} dodge/burn marks`}
                        </span>
                      )}
                      {(healMode || localBrushMode) && brushCursor && (
                        <span
                          className="healCursor"
                          style={{
                            left: brushCursor.x,
                            top: brushCursor.y,
                            width: brushCursor.size,
                            height: brushCursor.size,
                          }}
                        />
                      )}
                      {!healMode &&
                        !localBrushMode &&
                        (blemishSuggestions[current.path] || []).length > 0 && (
                          <div className="suggestionLegend">
                            {blemishSuggestions[current.path].length}{" "}
                            skin-region suggestions · Click a marker to accept
                          </div>
                        )}
                    </div>
                    <div className="photoMeta">
                      <b>{current.name}</b>
                      <span>
                        {healMode
                          ? "Click a blemish to heal · "
                          : zoom
                            ? "Drag photo to pan · "
                            : ""}
                        {selected + 1} of {created.previews.length}
                      </span>
                    </div>
                  </>
                ) : (
                  <div className="placeholder">No preview available</div>
                )}
              </div>
              <div className="controls">
                <p className="eyebrow">CORE FINISH</p>
                <div className="strengthName">
                  <strong>Level {strength}</strong>
                  <span>{strengthNames[strength]}</span>
                </div>
                <input
                  aria-label="Core finish strength"
                  type="range"
                  min="0"
                  max="4"
                  value={strength}
                  onChange={(e) => setStrength(Number(e.target.value))}
                />
                <p className="hint">
                  Controls the subject-aware foundation. Each operation below
                  has its own independent 0–4 strength.
                </p>
                <div className="retouchEngineStatus ready">
                  <b>Manual blemish healing available</b>
                  <span>
                    Choose Heal brush above, adjust its size, then click or drag
                    across temporary blemishes. Dodge gently lifts an area; Burn
                    reduces distracting brightness. Levels 3 and 4 use a
                    feathered subject mask and measure the brightness gap before
                    lifting facial midtones or suppressing competing highlights.
                    Eye-specific enhancement, flyaways, and under-eye
                    localization remain pending.
                  </span>
                </div>
                <div className="operationHead">
                  <b>Planned retouch operations</b>
                  <span>
                    {operations.filter((o) => o.enabled).length} enabled
                  </span>
                </div>
                <div className="operations">
                  {operations.map((op) => {
                    const wired = op.id === "tone" || op.id === "soften";
                    return (
                      <div
                        key={op.id}
                        role="button"
                        tabIndex={op.action === "Preserve" ? -1 : 0}
                        className={`operation ${wired ? "engineActive" : "pending"} ${op.enabled ? "on" : ""} ${op.action === "Preserve" ? "locked" : ""}`}
                        onClick={() => toggleOperation(op.id)}
                        title={
                          wired
                            ? "This control changes the live preview and final export"
                            : "Saved as intent; this engine component is not connected yet"
                        }
                      >
                        <span className="check">
                          {op.action === "Preserve"
                            ? "◆"
                            : op.enabled
                              ? "✓"
                              : ""}
                        </span>
                        <span>
                          <b>{op.label}</b>
                          <small>{op.detail}</small>
                        </span>
                        <em>{op.action}</em>
                        <label
                          className="operationLevel"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <span>0</span>
                          <input
                            aria-label={`${op.label} strength`}
                            type="range"
                            min="0"
                            max="4"
                            value={op.enabled ? op.level : 0}
                            disabled={op.action === "Preserve"}
                            onChange={(event) =>
                              setOperationLevel(
                                op.id,
                                Number(event.target.value),
                              )
                            }
                          />
                          <span>4</span>
                          <b>Level {op.enabled ? op.level : 0}</b>
                        </label>
                        <strong className="pendingBadge">
                          {wired
                            ? op.enabled
                              ? "Engine active"
                              : "Engine off"
                            : "Engine pending"}
                        </strong>
                      </div>
                    );
                  })}
                </div>
                <button className="primary save" onClick={savePlan}>
                  Approve & save retouch plan
                </button>
                {saved && (
                  <>
                    <small className="saved">{saved}</small>
                    <button
                      className="primary continue"
                      onClick={() => setStage("creative")}
                    >
                      Continue to creative review →
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="filmstrip">
              {created.previews.map((photo, i) => (
                <button
                  key={photo.path}
                  className={i === selected ? "selected" : ""}
                  onClick={() => {
                    setSelected(i);
                    setAnalysisMessage("");
                  }}
                >
                  <img src={photo.preview} alt="" />
                  <span>{i + 1}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            <header>
              <div>
                <p className="eyebrow">LOCAL WORKSPACE</p>
                <h1>Your shoots</h1>
              </div>
              <div className="headerActions">
                {shoot && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setShoot(null);
                      setCreated(null);
                      setThumbnails({});
                      setSelectedPaths(new Set());
                    }}
                  >
                    ← Back to start
                  </button>
                )}
                <button className="primary" onClick={chooseShoot}>
                  ＋ New shoot
                </button>
              </div>
            </header>
            {!shoot ? (
              <div className="hero">
                <div className="aperture">◉</div>
                <p className="eyebrow">FROM CARD TO CLIENT GALLERY</p>
                <h2>
                  Spend less time editing.
                  <br />
                  <em>Keep your signature look.</em>
                </h2>
                <p className="lede">
                  Import a session, approve a representative look, and let
                  Darktable process every photograph non-destructively.
                </p>
                <button className="primary large" onClick={chooseShoot}>
                  Choose a shoot folder <span>→</span>
                </button>
                <div className="promise">
                  <span>✓ Originals stay untouched</span>
                  <span>✓ Local processing</span>
                  <span>✓ Clean + watermarked export</span>
                </div>
              </div>
            ) : (
              <div className="shoot">
                <div className="shootHead">
                  <div>
                    <p className="eyebrow">NEW SHOOT</p>
                    <h2>{shoot.folder.split(/[\\/]/).pop()}</h2>
                    <p>{shoot.folder}</p>
                  </div>
                  <div className="count">
                    <strong>
                      {created ? shoot.files.length : selectedPaths.size}
                    </strong>
                    <span>
                      {created
                        ? "photographs in shoot"
                        : `of ${shoot.files.length} selected`}
                    </span>
                  </div>
                </div>
                {!created && (
                  <div className="selectionBar">
                    <div>
                      <b>Choose photographs for this shoot</b>
                      <span>
                        Only selected files will be previewed, stored, and
                        exported.
                      </span>
                    </div>
                    <div>
                      <div className="densityControl">
                        <span>Thumbnail size</span>
                        {(["small", "medium", "large"] as const).map((size) => (
                          <button
                            key={size}
                            className={gridDensity === size ? "selected" : ""}
                            onClick={() => setGridDensity(size)}
                          >
                            {size}
                          </button>
                        ))}
                      </div>
                      <button
                        className="secondary"
                        onClick={() => setSelectedPaths(new Set())}
                      >
                        Clear
                      </button>
                      <button
                        className="secondary"
                        onClick={() =>
                          setSelectedPaths(
                            new Set(shoot.files.map((file) => file.path)),
                          )
                        }
                      >
                        Select all
                      </button>
                    </div>
                  </div>
                )}
                <div
                  className={`fileGrid selectionGrid density-${gridDensity}`}
                >
                  {(created?.previews || shoot.files).map((photo, i) => (
                    <article
                      role={!created ? "button" : undefined}
                      tabIndex={!created ? 0 : undefined}
                      onClick={() => togglePhoto(photo)}
                      className={
                        !created
                          ? selectedPaths.has(photo.path)
                            ? "photoSelected"
                            : "photoExcluded"
                          : ""
                      }
                      key={photo.path}
                    >
                      {!created && (
                        <span className="selectCheck">
                          {selectedPaths.has(photo.path) ? "✓" : ""}
                        </span>
                      )}
                      {"preview" in photo ? (
                        <img src={photo.preview} alt={photo.name} />
                      ) : thumbnails[photo.path] ? (
                        <img src={thumbnails[photo.path]} alt={photo.name} />
                      ) : (
                        <div className="placeholder">
                          <span>{String(i + 1).padStart(2, "0")}</span>
                        </div>
                      )}
                      <b>{photo.name}</b>
                      <small>
                        {photo.type} ·{" "}
                        {"preview" in photo
                          ? "Preview ready"
                          : selectedPaths.has(photo.path)
                            ? "Selected"
                            : "Not selected"}
                      </small>
                    </article>
                  ))}
                </div>
                {error && (
                  <div className="notice error">
                    <b>Could not create previews</b>
                    <span>{error}</span>
                  </div>
                )}
                {created && (
                  <div
                    className={
                      created.previews.length
                        ? "notice success"
                        : "notice error"
                    }
                  >
                    <b>
                      {created.previews.length
                        ? "Shoot created"
                        : "Preview generation failed"}
                    </b>
                    <span>
                      {created.previews.length} previews generated
                      {created.failures.length
                        ? ` · ${created.failures.length} could not be processed`
                        : ""}
                      . Originals were not changed.
                      {created.failures[0]
                        ? ` First error: ${created.failures[0].message}`
                        : ""}
                    </span>
                  </div>
                )}
                <footer>
                  <span>
                    {processing
                      ? "Darktable is creating previews…"
                      : created
                        ? `Local project: ${created.projectDir}`
                        : selectedPaths.size
                          ? `${selectedPaths.size} selected. Ready to create previews without changing originals.`
                          : "Select at least one photograph."}
                  </span>
                  {created?.previews.length ? (
                    <button
                      className="primary"
                      onClick={() => setStage("retouch")}
                    >
                      Retouch review →
                    </button>
                  ) : (
                    <button
                      className="primary"
                      onClick={createShoot}
                      disabled={!selectedPaths.size || processing}
                    >
                      {processing
                        ? "Creating previews…"
                        : "Create selected shoot →"}
                    </button>
                  )}
                </footer>
              </div>
            )}
          </>
        )}
        {progress && (
          <div
            className={`progressTray ${progress.kind === "complete" ? "complete" : ""}`}
          >
            <div>
              <b>{progress.message}</b>
              <span>
                {progress.current} / {progress.total}
              </span>
            </div>
            <div className="progressTrack">
              <i
                style={{
                  width: `${progress.total ? Math.round((progress.current / progress.total) * 100) : 0}%`,
                }}
              />
            </div>
            {progress.kind === "complete" && (
              <button onClick={() => setProgress(null)}>×</button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
