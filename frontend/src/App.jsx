import React, { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_EXPORT_FORMATS, EXPORT_FORMAT_OPTIONS } from "./exporters";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:8000";

function formatTime(seconds) {
  const totalMilliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(totalMilliseconds / 3600000);
  const minutes = Math.floor((totalMilliseconds % 3600000) / 60000);
  const secs = Math.floor((totalMilliseconds % 60000) / 1000);
  const millis = totalMilliseconds % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function formatSeconds(seconds) {
  return Number(seconds || 0).toFixed(3);
}

function parseSeconds(value) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed);
}

function secondsInputIsValid(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function keepRepresentativeFrameInRange(subtitle) {
  if (
    subtitle.representative_time === null ||
    subtitle.representative_time === undefined ||
    subtitle.end_time <= subtitle.start_time ||
    (subtitle.start_time <= subtitle.representative_time && subtitle.representative_time <= subtitle.end_time)
  ) {
    return subtitle;
  }

  return { ...subtitle, representative_time: subtitle.end_time };
}

function representativeFramePreviewUrl(video, subtitle) {
  if (!video?.stored_path || subtitle.representative_time === null || subtitle.representative_time === undefined) {
    return "";
  }

  const params = new URLSearchParams({
    video_path: video.stored_path,
    time: formatSeconds(subtitle.representative_time),
  });
  return `${API_BASE}/api/frame-preview?${params.toString()}`;
}

const EXCLUDE_REASON_OPTIONS = [
  "経路説明",
  "訓練特有の発話",
  "対話・雑談",
  "映像に対象なし",
  "聞き取り不明瞭",
  "その他",
];

// 以前の候補名で保存された理由を新しい候補名にそろえる
const LEGACY_EXCLUDE_REASONS = {
  "経路説明（映像に根拠なし）": "経路説明",
  "映像に対象が写っていない": "映像に対象なし",
};

function normalizeExcludeReason(reason) {
  const value = (reason || "").trim();
  return LEGACY_EXCLUDE_REASONS[value] ?? value;
}

function createSubtitle(startTime = 0, endTime = startTime + 2) {
  return {
    index: null,
    start_time: startTime,
    end_time: endTime,
    start_time_input: formatSeconds(startTime),
    end_time_input: formatSeconds(endTime),
    text: "",
    representative_time: null,
    exclude_from_training: false,
    exclude_reason: "",
  };
}

function getInsertSubtitleTimes(subtitles, insertIndex) {
  const previousSubtitle = subtitles[insertIndex - 1] || null;
  const nextSubtitle = subtitles[insertIndex] || null;

  if (!previousSubtitle && nextSubtitle) {
    const startTime = Math.max(0, nextSubtitle.start_time - 2);
    const endTime = nextSubtitle.start_time > startTime ? nextSubtitle.start_time : startTime + 2;
    return { startTime, endTime };
  }

  const startTime = previousSubtitle ? previousSubtitle.end_time : 0;
  let endTime = startTime + 2;

  if (nextSubtitle && nextSubtitle.start_time > startTime) {
    endTime = Math.min(endTime, nextSubtitle.start_time);
  }

  if (endTime <= startTime) {
    endTime = startTime + 2;
  }

  return { startTime, endTime };
}

function mergeSubtitleText(subtitles) {
  return subtitles
    .map((subtitle) => subtitle.text.trim())
    .filter(Boolean)
    .join("");
}

async function uploadFile(endpoint, file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail || "Upload failed");
  }

  return response.json();
}

async function postJson(endpoint, payload) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail || "Request failed");
  }

  return response.json();
}

async function getJson(endpoint) {
  const response = await fetch(`${API_BASE}${endpoint}`);

  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.detail || "Request failed");
  }

  return response.json();
}

export default function App() {
  const videoRef = useRef(null);
  const copyToastTimerRef = useRef(null);
  const stopAtTimeRef = useRef(null);
  const lastPersistedProgressRef = useRef({ projectId: null, index: null });
  const [video, setVideo] = useState(null);
  const [srt, setSrt] = useState(null);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(null);
  const [selectedSubtitleIndices, setSelectedSubtitleIndices] = useState([]);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [isUploadingSrt, setIsUploadingSrt] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSavingSrt, setIsSavingSrt] = useState(false);
  const [isExportingMaster, setIsExportingMaster] = useState(false);
  const [isExportingClips, setIsExportingClips] = useState(false);
  const [selectedExportFormats, setSelectedExportFormats] = useState(DEFAULT_EXPORT_FORMATS);
  const [transcriptionModelSize, setTranscriptionModelSize] = useState("base");
  const [datasetDir, setDatasetDir] = useState("");
  const [datasetDirInput, setDatasetDirInput] = useState("");
  const [isSavingDatasetDir, setIsSavingDatasetDir] = useState(false);
  const [isChoosingDatasetDir, setIsChoosingDatasetDir] = useState(false);
  const [savedProjects, setSavedProjects] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [currentProjectId, setCurrentProjectId] = useState(null);
  const [isLoadingProject, setIsLoadingProject] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [error, setError] = useState("");

  const videoUrl = useMemo(() => {
    if (!video?.stream_url) return "";
    return `${API_BASE}${video.stream_url}`;
  }, [video]);

  const activityMessage = isExportingClips
    ? "選択された形式のデータセットを書き出しています..."
    : isLoadingProject
    ? "保存済みの作業を読み込んでいます..."
    : isChoosingDatasetDir
    ? "フォルダを選択しています..."
    : isSavingDatasetDir
    ? "データ保存先を変更しています..."
    : isTranscribing
    ? "faster-whisperで文字起こししています..."
    : isSavingSrt
    ? "SRTを保存しています..."
    : isExportingMaster
    ? "master.jsonlに書き出しています..."
    : "ファイルを読み込んでいます...";

  function normalizeLoadedSubtitles(result) {
    return {
      ...result,
      subtitles: result.subtitles.map((subtitle) => ({
        ...subtitle,
        start_time_input: formatSeconds(subtitle.start_time),
        end_time_input: formatSeconds(subtitle.end_time),
        representative_time: subtitle.representative_time ?? null,
        exclude_from_training: subtitle.exclude_from_training ?? false,
        exclude_reason: normalizeExcludeReason(subtitle.exclude_reason),
      })),
    };
  }

  async function refreshSavedProjects() {
    const result = await getJson("/api/projects");
    setSavedProjects(result.projects);
  }

  useEffect(() => {
    let ignore = false;

    async function loadDatasetSettings() {
      try {
        const result = await getJson("/api/settings/dataset");
        if (ignore) return;
        setDatasetDir(result.dataset_dir);
        setDatasetDirInput(result.dataset_dir);
      } catch (settingsError) {
        if (!ignore) {
          setError(settingsError.message);
        }
      }
    }

    loadDatasetSettings();
    refreshSavedProjects().catch((settingsError) => {
      if (!ignore) {
        setError(settingsError.message);
      }
    });

    return () => {
      ignore = true;
    };
  }, []);

  async function applyDatasetDir(nextDatasetDir) {
    if (!nextDatasetDir.trim()) {
      setError("データ保存先を入力してください。");
      return;
    }

    setError("");
    setStatusMessage("");
    setIsSavingDatasetDir(true);
    try {
      const result = await postJson("/api/settings/dataset", {
        dataset_dir: nextDatasetDir,
      });
      setDatasetDir(result.dataset_dir);
      setDatasetDirInput(result.dataset_dir);
      setVideo(null);
      setSrt(null);
      setActiveSubtitleIndex(null);
      setSelectedSubtitleIndices([]);
      setSavedProjects([]);
      setSelectedProjectId("");
      setCurrentProjectId(null);
      lastPersistedProgressRef.current = { projectId: null, index: null };
      stopAtTimeRef.current = null;
      setCurrentVideoTime(0);
      await refreshSavedProjects();
      setStatusMessage("データ保存先を変更しました。動画とSRTを読み込み直してください。");
    } catch (settingsError) {
      setError(settingsError.message);
    } finally {
      setIsSavingDatasetDir(false);
    }
  }

  async function saveDatasetDir() {
    await applyDatasetDir(datasetDirInput);
  }

  async function chooseDatasetDir() {
    setError("");
    setStatusMessage("");
    setIsChoosingDatasetDir(true);
    try {
      const result = await getJson("/api/settings/dataset/select");
      if (result.dataset_dir) {
        setDatasetDirInput(result.dataset_dir);
        await applyDatasetDir(result.dataset_dir);
      }
    } catch (settingsError) {
      setError(settingsError.message);
    } finally {
      setIsChoosingDatasetDir(false);
    }
  }

  async function openSavedProject() {
    if (!selectedProjectId) {
      return;
    }

    setError("");
    setStatusMessage("");
    setIsLoadingProject(true);
    try {
      const result = await getJson(`/api/projects/${encodeURIComponent(selectedProjectId)}`);
      setVideo(result.video);
      setSrt(normalizeLoadedSubtitles(result.srt));
      setSelectedSubtitleIndices([]);
      const resumeIndex = result.last_worked_subtitle_index;
      const canResume = Number.isInteger(resumeIndex) && resumeIndex >= 1 && resumeIndex <= result.srt.subtitles.length;
      setActiveSubtitleIndex(canResume ? resumeIndex - 1 : null);
      setCurrentProjectId(result.project_id);
      lastPersistedProgressRef.current = { projectId: result.project_id, index: canResume ? resumeIndex : null };
      stopAtTimeRef.current = null;
      setCurrentVideoTime(0);
      setStatusMessage(
        canResume
          ? `${result.video.filename} と ${result.srt.filename} を読み込みました。前回は No. ${resumeIndex} まで作業していました。`
          : `${result.video.filename} と ${result.srt.filename} を読み込みました。`,
      );
      if (canResume) {
        window.setTimeout(() => {
          document.getElementById(`subtitle-row-${resumeIndex}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        }, 0);
      }
    } catch (projectError) {
      setError(projectError.message);
    } finally {
      setIsLoadingProject(false);
    }
  }

  function toggleExportFormat(format) {
    setSelectedExportFormats((currentFormats) => {
      if (currentFormats.includes(format)) {
        return currentFormats.filter((currentFormat) => currentFormat !== format);
      }
      return [...currentFormats, format];
    });
  }

  async function handleVideoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError("");
    setStatusMessage("");
    setIsUploadingVideo(true);
    try {
      const result = await uploadFile("/api/videos", file);
      setVideo(result);
      setCurrentVideoTime(0);
      stopAtTimeRef.current = null;
      setActiveSubtitleIndex(null);
      setSelectedSubtitleIndices([]);
      setCurrentProjectId(null);
      lastPersistedProgressRef.current = { projectId: null, index: null };
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setIsUploadingVideo(false);
    }
  }

  async function handleSrtChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    setError("");
    setStatusMessage("");
    setIsUploadingSrt(true);
    try {
      const result = await uploadFile("/api/srt", file);
      setSrt(normalizeLoadedSubtitles(result));
      setActiveSubtitleIndex(null);
      setSelectedSubtitleIndices([]);
      setCurrentProjectId(null);
      lastPersistedProgressRef.current = { projectId: null, index: null };
    } catch (uploadError) {
      setError(uploadError.message);
    } finally {
      setIsUploadingSrt(false);
    }
  }

  async function transcribeVideo() {
    if (!video) {
      setError("先に動画ファイルを選択してください。");
      return;
    }

    setError("");
    setStatusMessage("");
    setIsTranscribing(true);
    try {
      const result = await postJson("/api/transcribe", {
        video_id: video.video_id,
        video_path: video.stored_path,
        model_size: transcriptionModelSize,
        language: "ja",
      });
      setSrt(normalizeLoadedSubtitles(result));
      setActiveSubtitleIndex(null);
      setSelectedSubtitleIndices([]);
      setCurrentProjectId(null);
      lastPersistedProgressRef.current = { projectId: null, index: null };
      setStatusMessage(`${result.filename} を ${result.subtitles.length} 件の字幕下書きとして作成しました。`);
    } catch (transcribeError) {
      setError(transcribeError.message);
    } finally {
      setIsTranscribing(false);
    }
  }

  function jumpToSubtitle(subtitle, idx) {
    if (!videoRef.current) {
      setError("先に動画ファイルを選択してください。");
      return;
    }

    videoRef.current.currentTime = subtitle.start_time;
    stopAtTimeRef.current = subtitle.end_time;
    videoRef.current.play().catch(() => {});
    setCurrentVideoTime(subtitle.start_time);
    rememberWorkPosition(idx);
    setError("");
  }

  function rememberWorkPosition(idx) {
    setActiveSubtitleIndex(idx);

    if (!currentProjectId) return;

    const subtitleNumber = idx + 1;
    if (
      lastPersistedProgressRef.current.projectId === currentProjectId &&
      lastPersistedProgressRef.current.index === subtitleNumber
    ) {
      return;
    }

    lastPersistedProgressRef.current = { projectId: currentProjectId, index: subtitleNumber };
    postJson(`/api/projects/${encodeURIComponent(currentProjectId)}/progress`, {
      last_worked_subtitle_index: subtitleNumber,
    })
      .then((project) => {
        setSavedProjects((projects) =>
          projects.map((item) => (item.project_id === project.project_id ? project : item)),
        );
      })
      .catch((progressError) => {
        lastPersistedProgressRef.current = { projectId: null, index: null };
        setError(progressError.message);
      });
  }

  function handleVideoTimeUpdate(event) {
    const videoElement = event.currentTarget;
    const currentTime = videoElement.currentTime;
    setCurrentVideoTime(currentTime);

    if (stopAtTimeRef.current !== null && currentTime >= stopAtTimeRef.current) {
      videoElement.pause();
      videoElement.currentTime = stopAtTimeRef.current;
      setCurrentVideoTime(stopAtTimeRef.current);
      stopAtTimeRef.current = null;
    }
  }

  function clearSubtitleStop() {
    stopAtTimeRef.current = null;
  }

  function updateSubtitleText(idx, text) {
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        return { ...subtitle, text };
      });

      return { ...currentSrt, subtitles };
    });
  }

  function updateSubtitleExclusion(idx, changes) {
    rememberWorkPosition(idx);
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        return { ...subtitle, ...changes };
      });

      return { ...currentSrt, subtitles };
    });
  }

  function updateSubtitleTime(idx, field, value) {
    const seconds = parseSeconds(value);
    const inputField = `${field}_input`;

    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        if (!secondsInputIsValid(value)) {
          return { ...subtitle, [inputField]: value };
        }
        return keepRepresentativeFrameInRange({ ...subtitle, [field]: seconds, [inputField]: value });
      });

      return { ...currentSrt, subtitles };
    });
  }

  function normalizeSubtitleTime(idx, field) {
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const inputField = `${field}_input`;
      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        const rawValue = subtitle[inputField] ?? String(subtitle[field]);
        const seconds = parseSeconds(rawValue);
        return keepRepresentativeFrameInRange({ ...subtitle, [field]: seconds, [inputField]: formatSeconds(seconds) });
      });

      return { ...currentSrt, subtitles };
    });
  }

  function setRepresentativeFrame(idx) {
    if (!videoRef.current) {
      setError("先に動画ファイルを選択してください。");
      return;
    }

    rememberWorkPosition(idx);

    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitle = currentSrt.subtitles[idx];
      if (!subtitle) return currentSrt;

      if (currentVideoTime < subtitle.start_time || currentVideoTime > subtitle.end_time) {
        setError("代表フレームは字幕区間内の再生位置で設定してください。");
        setActiveSubtitleIndex(idx);
        return currentSrt;
      }

      const subtitles = currentSrt.subtitles.map((item, subtitleIndex) => {
        if (subtitleIndex !== idx) return item;
        return { ...item, representative_time: currentVideoTime };
      });

      setError("");
      return { ...currentSrt, subtitles };
    });
  }

  function jumpToRepresentativeFrame(subtitle, idx) {
    if (!videoRef.current || subtitle.representative_time === null || subtitle.representative_time === undefined) {
      return;
    }

    stopAtTimeRef.current = null;
    videoRef.current.currentTime = subtitle.representative_time;
    videoRef.current.pause();
    setCurrentVideoTime(subtitle.representative_time);
    rememberWorkPosition(idx);
  }

  function clearRepresentativeFrame(idx) {
    rememberWorkPosition(idx);
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        return { ...subtitle, representative_time: null };
      });

      return { ...currentSrt, subtitles };
    });
  }

  function autoSetMissingRepresentativeFrames() {
    setSrt((currentSrt) => {
      if (!currentSrt?.subtitles?.length) {
        setError("字幕がありません。");
        return currentSrt;
      }

      let updatedCount = 0;
      const subtitles = currentSrt.subtitles.map((subtitle) => {
        if (subtitle.representative_time !== null && subtitle.representative_time !== undefined) {
          return subtitle;
        }
        if (subtitle.end_time <= subtitle.start_time) {
          return subtitle;
        }

        updatedCount += 1;
        return {
          ...subtitle,
          representative_time: subtitle.start_time + (subtitle.end_time - subtitle.start_time) / 2,
        };
      });

      setError("");
      setStatusMessage(`${updatedCount} 件の代表フレームを区間中央に自動設定しました。`);
      return { ...currentSrt, subtitles };
    });
  }

  function toggleSubtitleSelection(idx) {
    rememberWorkPosition(idx);
    setSelectedSubtitleIndices((currentIndices) =>
      currentIndices.includes(idx)
        ? currentIndices.filter((currentIndex) => currentIndex !== idx)
        : [...currentIndices, idx].sort((left, right) => left - right),
    );
  }

  function mergeSelectedSubtitles() {
    if (!srt) return;

    const selectedIndices = [...selectedSubtitleIndices].sort((left, right) => left - right);
    if (selectedIndices.length < 2) {
      setError("結合する字幕を2件以上選択してください。");
      return;
    }

    const firstIndex = selectedIndices[0];
    const lastIndex = selectedIndices[selectedIndices.length - 1];
    if (lastIndex - firstIndex + 1 !== selectedIndices.length) {
      setError("結合できるのは連続した字幕だけです。");
      return;
    }

    const subtitlesToMerge = srt.subtitles.slice(firstIndex, lastIndex + 1);
    const startTime = subtitlesToMerge[0].start_time;
    const endTime = subtitlesToMerge[subtitlesToMerge.length - 1].end_time;
    const midpoint = startTime + (endTime - startTime) / 2;
    const representativeTime = subtitlesToMerge
      .map((subtitle) => subtitle.representative_time)
      .filter((time) => time !== null && time !== undefined && time >= startTime && time <= endTime)
      .sort((left, right) => Math.abs(left - midpoint) - Math.abs(right - midpoint))[0] ?? null;
    const mergedSubtitle = {
      ...subtitlesToMerge[0],
      start_time: startTime,
      end_time: endTime,
      start_time_input: formatSeconds(startTime),
      end_time_input: formatSeconds(endTime),
      text: mergeSubtitleText(subtitlesToMerge),
      representative_time: representativeTime,
      exclude_from_training: subtitlesToMerge.some((subtitle) => subtitle.exclude_from_training),
      exclude_reason:
        subtitlesToMerge.map((subtitle) => (subtitle.exclude_reason || "").trim()).find(Boolean) ?? "",
    };

    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;
      return {
        ...currentSrt,
        subtitles: [
          ...currentSrt.subtitles.slice(0, firstIndex),
          mergedSubtitle,
          ...currentSrt.subtitles.slice(lastIndex + 1),
        ],
      };
    });
    setSelectedSubtitleIndices([]);
    rememberWorkPosition(firstIndex);
    setError("");
    setStatusMessage(`No. ${firstIndex + 1} から No. ${lastIndex + 1} を1件の字幕に結合しました。Command + S で保存できます。`);
  }

  function addSubtitleAtPosition(insertIndex) {
    if (!srt) {
      setError("先にSRTファイルを選択してください。");
      return;
    }

    const boundedInsertIndex = Math.min(Math.max(insertIndex, 0), srt.subtitles.length);
    rememberWorkPosition(boundedInsertIndex);
    setSelectedSubtitleIndices([]);

    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = [...currentSrt.subtitles];
      const { startTime, endTime } = getInsertSubtitleTimes(subtitles, boundedInsertIndex);
      const nextSubtitle = createSubtitle(startTime, endTime);
      subtitles.splice(boundedInsertIndex, 0, nextSubtitle);

      setError("");
      return { ...currentSrt, subtitles };
    });
  }

  function deleteSubtitle(idx) {
    setSelectedSubtitleIndices([]);
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.filter((_, subtitleIndex) => subtitleIndex !== idx);
      stopAtTimeRef.current = null;
      setActiveSubtitleIndex((currentIndex) => {
        if (currentIndex === null) return null;
        if (currentIndex === idx) return null;
        if (currentIndex > idx) return currentIndex - 1;
        return currentIndex;
      });
      setError("");
      return { ...currentSrt, subtitles };
    });
  }

  async function copyCurrentVideoTime() {
    const value = formatSeconds(currentVideoTime);

    try {
      await navigator.clipboard.writeText(value);
      setCopyMessage(`現在秒数 ${value} をコピーしました。`);
      setError("");

      if (copyToastTimerRef.current) {
        window.clearTimeout(copyToastTimerRef.current);
      }
      copyToastTimerRef.current = window.setTimeout(() => {
        setCopyMessage("");
      }, 1800);
    } catch {
      setError("現在秒数をコピーできませんでした。");
    }
  }

  function validateSubtitleTimes() {
    if (!srt?.subtitles?.length) return -1;
    const invalidIndex = srt.subtitles.findIndex((subtitle) => {
      const hasInvalidInput =
        !secondsInputIsValid(subtitle.start_time_input ?? String(subtitle.start_time)) ||
        !secondsInputIsValid(subtitle.end_time_input ?? String(subtitle.end_time));
      return hasInvalidInput || subtitle.end_time <= subtitle.start_time;
    });
    return invalidIndex;
  }

  async function saveSrtFile() {
    if (!srt) {
      setError("SRTファイルを読み込んでください。");
      return;
    }

    const invalidIndex = validateSubtitleTimes();
    if (invalidIndex !== -1) {
      setError(`${invalidIndex + 1}件目の終了時刻は開始時刻より後にしてください。`);
      setActiveSubtitleIndex(invalidIndex);
      return;
    }

    setError("");
    setStatusMessage("");
    setIsSavingSrt(true);

    try {
      const result = await postJson("/api/srt/save", {
        path: srt.stored_path,
        subtitles: srt.subtitles.map((subtitle, idx) => ({
          index: idx + 1,
          start_time: subtitle.start_time,
          end_time: subtitle.end_time,
          text: subtitle.text,
          representative_time: subtitle.representative_time,
          exclude_from_training: Boolean(subtitle.exclude_from_training),
          exclude_reason: subtitle.exclude_from_training ? subtitle.exclude_reason || "" : "",
        })),
        video_id: video?.video_id ?? null,
        video_path: video?.stored_path ?? null,
        last_worked_subtitle_index: activeSubtitleIndex === null ? null : activeSubtitleIndex + 1,
      });
      if (result.project_id) {
        setSelectedProjectId(result.project_id);
        setCurrentProjectId(result.project_id);
        lastPersistedProgressRef.current = {
          projectId: result.project_id,
          index: result.last_worked_subtitle_index,
        };
        await refreshSavedProjects();
      }
      setStatusMessage(`${result.path} と代表フレーム情報を ${result.count} 件の字幕で保存しました。`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setIsSavingSrt(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event) {
      const hasCommandModifier = event.metaKey || event.ctrlKey;

      if (hasCommandModifier && event.shiftKey && event.key.toLowerCase() === "m") {
        event.preventDefault();
        if (!isSavingSrt && !isExportingMaster && !isExportingClips && !isTranscribing) {
          mergeSelectedSubtitles();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!isSavingSrt && !isExportingMaster && !isExportingClips && !isTranscribing) {
          saveSrtFile();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  function validateDatasetExportInputs() {
    if (!video || !srt?.subtitles?.length) {
      setError("動画ファイルとSRTファイルを読み込んでください。");
      return false;
    }

    const invalidIndex = validateSubtitleTimes();
    if (invalidIndex !== -1) {
      setError(`${invalidIndex + 1}件目の終了時刻は開始時刻より後にしてください。`);
      setActiveSubtitleIndex(invalidIndex);
      return false;
    }

    const emptyTextIndex = srt.subtitles.findIndex((subtitle) => !subtitle.text.trim());
    if (emptyTextIndex !== -1) {
      setError(`${emptyTextIndex + 1}件目のanswerが空です。字幕本文を入力してください。`);
      setActiveSubtitleIndex(emptyTextIndex);
      return false;
    }

    const missingFrameIndex = srt.subtitles.findIndex(
      (subtitle) => subtitle.representative_time === null || subtitle.representative_time === undefined,
    );
    if (missingFrameIndex !== -1) {
      setError(`${missingFrameIndex + 1}件目に代表フレームがありません。`);
      setActiveSubtitleIndex(missingFrameIndex);
      return false;
    }

    const invalidFrameIndex = srt.subtitles.findIndex(
      (subtitle) => subtitle.representative_time < subtitle.start_time || subtitle.representative_time > subtitle.end_time,
    );
    if (invalidFrameIndex !== -1) {
      setError(`${invalidFrameIndex + 1}件目の代表フレーム秒数が字幕区間外です。`);
      setActiveSubtitleIndex(invalidFrameIndex);
      return false;
    }

    if (!selectedExportFormats.length) {
      setError("出力形式を1つ以上選択してください。");
      return false;
    }

    return true;
  }

  async function exportSelectedDataset() {
    if (!validateDatasetExportInputs()) return;

    setError("");
    setStatusMessage("");
    setIsExportingClips(true);

    try {
      const result = await postJson("/api/master/utterances", {
        video_id: video.video_id,
        video_path: video.stored_path,
        export_clips: true,
        export_formats: selectedExportFormats,
        subtitles: srt.subtitles.map((subtitle, idx) => ({
          index: idx + 1,
          start_time: subtitle.start_time,
          end_time: subtitle.end_time,
          text: subtitle.text,
          representative_time: subtitle.representative_time,
          exclude_from_training: Boolean(subtitle.exclude_from_training),
          exclude_reason: subtitle.exclude_from_training ? subtitle.exclude_reason || "" : "",
        })),
      });
      setStatusMessage(
        `${result.export_path} に ${result.count} 件の発話（うち学習除外 ${srt.subtitles.filter((subtitle) => subtitle.exclude_from_training).length} 件）、${result.clip_count} 件のクリップ、${result.frame_count} 件の代表フレームを書き出しました。`,
      );
    } catch (exportError) {
      setError(exportError.message);
    } finally {
      setIsExportingMaster(false);
      setIsExportingClips(false);
    }
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>Walking Dataset Builder</h1>
          <p>動画とSRTを読み込み、再生しながら字幕区間を確認します。</p>
        </div>
        <div className="status-pill">master.jsonl 未保存</div>
      </header>

      <section className="dataset-settings-card" aria-label="データ保存先">
        <label className="dataset-dir-field">
          <span>データ保存先</span>
          <input
            onChange={(event) => setDatasetDirInput(event.target.value)}
            placeholder="/Users/kanahorie/Documents/修士研究/歩行データセット"
            type="text"
            value={datasetDirInput}
          />
        </label>
        <button
          className="export-button secondary"
          disabled={isSavingDatasetDir || isChoosingDatasetDir || !datasetDirInput.trim() || datasetDirInput === datasetDir}
          onClick={saveDatasetDir}
          type="button"
        >
          {isSavingDatasetDir ? "適用中..." : "適用"}
        </button>
        <button
          className="export-button secondary"
          disabled={isSavingDatasetDir || isChoosingDatasetDir}
          onClick={chooseDatasetDir}
          type="button"
        >
          {isChoosingDatasetDir ? "選択中..." : "フォルダを選択"}
        </button>
      </section>

      <section className="saved-project-card" aria-label="保存済みの作業">
        <label className="saved-project-field">
          <span>保存済みの作業</span>
          <select
            disabled={isLoadingProject || !savedProjects.length}
            onChange={(event) => setSelectedProjectId(event.target.value)}
            value={selectedProjectId}
          >
            <option value="">{savedProjects.length ? "保存済みの作業を選択" : "保存済みの作業はありません"}</option>
            {savedProjects.map((project) => (
              <option key={project.project_id} value={project.project_id}>
                {project.video_filename} / {project.srt_filename}
                {project.last_worked_subtitle_index ? ` (No. ${project.last_worked_subtitle_index} まで)` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className="export-button secondary"
          disabled={!selectedProjectId || isLoadingProject}
          onClick={openSavedProject}
          type="button"
        >
          {isLoadingProject ? "読み込み中..." : "開く"}
        </button>
      </section>

      <section className="toolbar" aria-label="ファイル読み込みと書き出し">
        <div className="toolbar-card import-card" aria-label="インポート">
          <label className="file-field">
            <span>動画ファイル</span>
            <input type="file" accept="video/*,.mkv" onChange={handleVideoChange} />
          </label>
          <div className="subtitle-import-group">
            <label className="file-field">
              <span>SRT字幕</span>
              <input type="file" accept=".srt" onChange={handleSrtChange} />
            </label>
            <div className="transcribe-controls">
              <label className="select-field">
                <span>Whisperモデル</span>
                <select
                  disabled={isUploadingVideo || isUploadingSrt || isTranscribing || isSavingSrt || isExportingClips}
                  onChange={(event) => setTranscriptionModelSize(event.target.value)}
                  value={transcriptionModelSize}
                >
                  <option value="base">base</option>
                  <option value="small">small</option>
                </select>
              </label>
              <button
                className="export-button secondary transcribe-button"
                disabled={!video || isUploadingVideo || isUploadingSrt || isTranscribing || isSavingSrt || isExportingClips}
                onClick={transcribeVideo}
                type="button"
              >
                {isTranscribing ? "文字起こし中..." : "文字起こし"}
              </button>
            </div>
          </div>
        </div>
        <div className="toolbar-card export-card" aria-label="書き出し">
          <fieldset className="export-format-field">
            <legend>出力形式</legend>
            <div className="export-format-options">
              {EXPORT_FORMAT_OPTIONS.map((option) => (
                <label className="export-format-option" key={option.id}>
                  <input
                    checked={selectedExportFormats.includes(option.id)}
                    disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                    onChange={() => toggleExportFormat(option.id)}
                    type="checkbox"
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button
            className="export-button"
            disabled={
              !video ||
              !srt?.subtitles?.length ||
              !selectedExportFormats.length ||
              isSavingSrt ||
              isTranscribing ||
              isExportingMaster ||
              isExportingClips
            }
            onClick={exportSelectedDataset}
            type="button"
          >
            {isExportingClips ? "書き出し中..." : "書き出し"}
          </button>
        </div>
      </section>

      {(isUploadingVideo ||
        isUploadingSrt ||
        isLoadingProject ||
        isChoosingDatasetDir ||
        isSavingDatasetDir ||
        isTranscribing ||
        isSavingSrt ||
        isExportingMaster ||
        isExportingClips ||
        statusMessage ||
        error) && (
        <div className={error ? "message error" : "message"}>
          {error || statusMessage || activityMessage}
        </div>
      )}

      <section className="workspace">
        <div className="video-pane">
          <div className="pane-header">
            <h2>動画</h2>
            <span>{video?.filename || "未選択"}</span>
          </div>
          {videoUrl ? (
            <>
              <video
                ref={videoRef}
                className="video-player"
                controls
                onLoadedMetadata={(event) => setCurrentVideoTime(event.currentTarget.currentTime)}
                onPause={clearSubtitleStop}
                onTimeUpdate={handleVideoTimeUpdate}
                preload="metadata"
                src={videoUrl}
              />
              <div className="video-timebar">
                <div className="current-time-group">
                  <span>現在秒数</span>
                  <button
                    className="current-time-button"
                    onClick={copyCurrentVideoTime}
                    type="button"
                  >
                    {formatSeconds(currentVideoTime)}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="empty-state">動画ファイルを選択してください。</div>
          )}
        </div>

        <div className="subtitle-pane">
          <div className="pane-header">
            <div>
              <h2>字幕一覧</h2>
              <span>
                {srt
                  ? `${srt.subtitles.length} 件（学習除外 ${srt.subtitles.filter((subtitle) => subtitle.exclude_from_training).length} 件）`
                  : "未選択"}
              </span>
            </div>
            <div className="pane-actions">
              <button
                className="pane-action-button"
                disabled={selectedSubtitleIndices.length < 2 || isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                onClick={mergeSelectedSubtitles}
                title="選択した連続字幕を結合 (Command + Shift + M)"
                type="button"
              >
                選択を結合{selectedSubtitleIndices.length ? ` (${selectedSubtitleIndices.length})` : ""}
              </button>
              <button
                className="pane-action-button"
                disabled={!srt?.subtitles?.length || isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                onClick={autoSetMissingRepresentativeFrames}
                type="button"
              >
                代表フレーム自動設定
              </button>
            </div>
          </div>
          {srt?.subtitles?.length ? (
            <div className="subtitle-list">
              <div className="subtitle-insert-divider">
                <button
                  aria-label="この位置に字幕を追加"
                  disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                  onClick={() => addSubtitleAtPosition(0)}
                  type="button"
                >
                  +
                </button>
              </div>
              {srt.subtitles.map((subtitle, idx) => (
                <React.Fragment key={idx}>
                <article
                  className={`subtitle-row ${activeSubtitleIndex === idx ? "active" : ""} ${selectedSubtitleIndices.includes(idx) ? "selected" : ""} ${subtitle.exclude_from_training ? "excluded" : ""}`}
                  id={`subtitle-row-${idx + 1}`}
                  onFocusCapture={() => rememberWorkPosition(idx)}
                >
                  <div className="subtitle-controls">
                    <label className="subtitle-selection">
                      <input
                        aria-label={`No. ${idx + 1} を結合対象に選択`}
                        checked={selectedSubtitleIndices.includes(idx)}
                        disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                        onChange={() => toggleSubtitleSelection(idx)}
                        type="checkbox"
                      />
                      <span>No. {idx + 1}</span>
                    </label>
                    <button
                      className="subtitle-jump"
                      onClick={() => jumpToSubtitle(subtitle, idx)}
                      type="button"
                    >
                      {formatTime(subtitle.start_time)}
                    </button>
                    <label className="time-field">
                      <span>start</span>
                      <input
                        className={!secondsInputIsValid(subtitle.start_time_input ?? "") ? "invalid" : ""}
                        inputMode="decimal"
                        min="0"
                        onBlur={() => normalizeSubtitleTime(idx, "start_time")}
                        onChange={(event) => updateSubtitleTime(idx, "start_time", event.target.value)}
                        step="0.001"
                        type="text"
                        value={subtitle.start_time_input ?? formatSeconds(subtitle.start_time)}
                      />
                    </label>
                    <label className="time-field">
                      <span>end</span>
                      <input
                        className={!secondsInputIsValid(subtitle.end_time_input ?? "") ? "invalid" : ""}
                        inputMode="decimal"
                        min="0"
                        onBlur={() => normalizeSubtitleTime(idx, "end_time")}
                        onChange={(event) => updateSubtitleTime(idx, "end_time", event.target.value)}
                        step="0.001"
                        type="text"
                        value={subtitle.end_time_input ?? formatSeconds(subtitle.end_time)}
                      />
                    </label>
                    <div className={subtitle.end_time <= subtitle.start_time ? "duration invalid" : "duration"}>
                      {formatSeconds(subtitle.end_time - subtitle.start_time)} sec
                    </div>
                    <div className="representative-frame-control">
                      <span>representative</span>
                      <button onClick={() => setRepresentativeFrame(idx)} type="button">
                        現在を設定
                      </button>
                      {subtitle.representative_time !== null && subtitle.representative_time !== undefined ? (
                        <>
                          <button
                            className="representative-time"
                            onClick={() => jumpToRepresentativeFrame(subtitle, idx)}
                            type="button"
                          >
                            {formatSeconds(subtitle.representative_time)}
                          </button>
                          <button onClick={() => clearRepresentativeFrame(idx)} type="button">
                            解除
                          </button>
                        </>
                      ) : (
                        <em>未設定</em>
                      )}
                    </div>
                    <div className="exclude-control">
                      <label>
                        <input
                          checked={Boolean(subtitle.exclude_from_training)}
                          onChange={(event) => updateSubtitleExclusion(idx, { exclude_from_training: event.target.checked })}
                          type="checkbox"
                        />
                        <span>学習に使わない</span>
                      </label>
                      {subtitle.exclude_from_training && (
                        <select
                          aria-label={`No. ${idx + 1} の除外理由`}
                          className="exclude-reason"
                          onChange={(event) => updateSubtitleExclusion(idx, { exclude_reason: event.target.value })}
                          value={subtitle.exclude_reason || ""}
                        >
                          <option value="">理由を選択（任意）</option>
                          {EXCLUDE_REASON_OPTIONS.map((reason) => (
                            <option key={reason} value={reason}>
                              {reason}
                            </option>
                          ))}
                          {subtitle.exclude_reason && !EXCLUDE_REASON_OPTIONS.includes(subtitle.exclude_reason) && (
                            <option value={subtitle.exclude_reason}>{subtitle.exclude_reason}</option>
                          )}
                        </select>
                      )}
                    </div>
                    <div className="subtitle-edit-actions">
                      <button className="danger" onClick={() => deleteSubtitle(idx)} type="button">
                        削除
                      </button>
                    </div>
                  </div>
                  <div className="subtitle-main">
                    <textarea
                      aria-label={`${formatTime(subtitle.start_time)} の字幕`}
                      className="subtitle-editor"
                      onChange={(event) => updateSubtitleText(idx, event.target.value)}
                      rows={Math.max(2, subtitle.text.split("\n").length)}
                      value={subtitle.text}
                    />
                    <div className="representative-preview">
                      {representativeFramePreviewUrl(video, subtitle) ? (
                        <button
                          aria-label="代表フレームの位置へ移動"
                          className="representative-preview-button"
                          onClick={() => jumpToRepresentativeFrame(subtitle, idx)}
                          type="button"
                        >
                          <img
                            alt=""
                            loading="lazy"
                            src={representativeFramePreviewUrl(video, subtitle)}
                          />
                        </button>
                      ) : (
                        <div className="representative-preview-empty">代表フレーム未設定</div>
                      )}
                    </div>
                  </div>
                </article>
                {idx < srt.subtitles.length - 1 && (
                  <div className="subtitle-insert-divider">
                    <button
                      aria-label="この位置に字幕を追加"
                      disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                      onClick={() => addSubtitleAtPosition(idx + 1)}
                      type="button"
                    >
                      +
                    </button>
                  </div>
                )}
                </React.Fragment>
              ))}
              <div className="subtitle-insert-divider">
                <button
                  aria-label="この位置に字幕を追加"
                  disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                  onClick={() => addSubtitleAtPosition(srt.subtitles.length)}
                  type="button"
                >
                  +
                </button>
              </div>
            </div>
          ) : srt ? (
            <div className="empty-state">
              <button
                className="subtitle-add-empty-button"
                disabled={isTranscribing || isSavingSrt || isExportingMaster || isExportingClips}
                onClick={() => addSubtitleAtPosition(0)}
                type="button"
              >
                +
              </button>
            </div>
          ) : (
            <div className="empty-state">SRTファイルを選択してください。</div>
          )}
        </div>
      </section>
      {copyMessage && <div className="copy-toast">{copyMessage}</div>}
    </main>
  );
}
