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

function createSubtitle(startTime = 0, endTime = startTime + 2) {
  return {
    index: null,
    start_time: startTime,
    end_time: endTime,
    start_time_input: formatSeconds(startTime),
    end_time_input: formatSeconds(endTime),
    text: "",
    representative_time: null,
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

export default function App() {
  const videoRef = useRef(null);
  const copyToastTimerRef = useRef(null);
  const stopAtTimeRef = useRef(null);
  const [video, setVideo] = useState(null);
  const [srt, setSrt] = useState(null);
  const [activeSubtitleIndex, setActiveSubtitleIndex] = useState(null);
  const [currentVideoTime, setCurrentVideoTime] = useState(0);
  const [isUploadingVideo, setIsUploadingVideo] = useState(false);
  const [isUploadingSrt, setIsUploadingSrt] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isSavingSrt, setIsSavingSrt] = useState(false);
  const [isExportingMaster, setIsExportingMaster] = useState(false);
  const [isExportingClips, setIsExportingClips] = useState(false);
  const [selectedExportFormats, setSelectedExportFormats] = useState(DEFAULT_EXPORT_FORMATS);
  const [transcriptionModelSize, setTranscriptionModelSize] = useState("base");
  const [statusMessage, setStatusMessage] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const [error, setError] = useState("");

  const videoUrl = useMemo(() => {
    if (!video?.stream_url) return "";
    return `${API_BASE}${video.stream_url}`;
  }, [video]);

  const activityMessage = isExportingClips
    ? "選択された形式のデータセットを書き出しています..."
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
        representative_time: null,
      })),
    };
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
    setActiveSubtitleIndex(idx);
    setError("");
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
        return { ...subtitle, [field]: seconds, [inputField]: value };
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
        return { ...subtitle, [field]: seconds, [inputField]: formatSeconds(seconds) };
      });

      return { ...currentSrt, subtitles };
    });
  }

  function setRepresentativeFrame(idx) {
    if (!videoRef.current) {
      setError("先に動画ファイルを選択してください。");
      return;
    }

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
      setActiveSubtitleIndex(idx);
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
    setActiveSubtitleIndex(idx);
  }

  function clearRepresentativeFrame(idx) {
    setSrt((currentSrt) => {
      if (!currentSrt) return currentSrt;

      const subtitles = currentSrt.subtitles.map((subtitle, subtitleIndex) => {
        if (subtitleIndex !== idx) return subtitle;
        return { ...subtitle, representative_time: null };
      });

      return { ...currentSrt, subtitles };
    });
  }

  function addSubtitleAtPosition(insertIndex) {
    setSrt((currentSrt) => {
      if (!currentSrt) {
        setError("先にSRTファイルを選択してください。");
        return currentSrt;
      }

      const subtitles = [...currentSrt.subtitles];
      const boundedInsertIndex = Math.min(Math.max(insertIndex, 0), subtitles.length);
      const { startTime, endTime } = getInsertSubtitleTimes(subtitles, boundedInsertIndex);
      const nextSubtitle = createSubtitle(startTime, endTime);
      subtitles.splice(boundedInsertIndex, 0, nextSubtitle);
      setActiveSubtitleIndex(boundedInsertIndex);

      setError("");
      return { ...currentSrt, subtitles };
    });
  }

  function deleteSubtitle(idx) {
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
        })),
      });
      setStatusMessage(`${result.path} を ${result.count} 件の字幕で上書き保存しました。`);
    } catch (saveError) {
      setError(saveError.message);
    } finally {
      setIsSavingSrt(false);
    }
  }

  useEffect(() => {
    function handleKeyDown(event) {
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
        })),
      });
      setStatusMessage(
        `${result.export_path} に ${result.count} 件の発話、${result.clip_count} 件のクリップ、${result.frame_count} 件の代表フレームを書き出しました。`,
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

      <section className="toolbar" aria-label="ファイル読み込み">
        <label className="file-field">
          <span>動画ファイル</span>
          <input type="file" accept="video/*,.mkv" onChange={handleVideoChange} />
        </label>
        <label className="file-field">
          <span>SRT字幕</span>
          <input type="file" accept=".srt" onChange={handleSrtChange} />
        </label>
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
          className="export-button secondary"
          disabled={!video || isUploadingVideo || isUploadingSrt || isTranscribing || isSavingSrt || isExportingClips}
          onClick={transcribeVideo}
          type="button"
        >
          {isTranscribing ? "文字起こし中..." : "動画から文字起こし"}
        </button>
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
          {isExportingClips ? "書き出し中..." : "選択形式を書き出す"}
        </button>
      </section>

      {(isUploadingVideo || isUploadingSrt || isTranscribing || isSavingSrt || isExportingMaster || isExportingClips || statusMessage || error) && (
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
              <span>{srt ? `${srt.subtitles.length} 件` : "未選択"}</span>
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
                  className={`subtitle-row ${activeSubtitleIndex === idx ? "active" : ""}`}
                >
                  <div className="subtitle-controls">
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
                    <div className="subtitle-edit-actions">
                      <button className="danger" onClick={() => deleteSubtitle(idx)} type="button">
                        削除
                      </button>
                    </div>
                  </div>
                  <textarea
                    aria-label={`${formatTime(subtitle.start_time)} の字幕`}
                    className="subtitle-editor"
                    onChange={(event) => updateSubtitleText(idx, event.target.value)}
                    rows={Math.max(2, subtitle.text.split("\n").length)}
                    value={subtitle.text}
                  />
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
