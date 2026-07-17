from __future__ import annotations

import json
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


ROOT_DIR = Path(__file__).resolve().parents[2]
DATASET_DIR = ROOT_DIR / "dataset"
RAW_VIDEO_DIR = DATASET_DIR / "raw" / "videos"
ANNOTATION_DIR = DATASET_DIR / "annotations"
PROCESSED_CLIP_DIR = DATASET_DIR / "processed" / "clips"
PROCESSED_FRAME_DIR = DATASET_DIR / "processed" / "frames"
PROCESSED_AUDIO_DIR = DATASET_DIR / "processed" / "audio"
EXPORT_DIR = DATASET_DIR / "exports"
VIDEOS_JSONL = ANNOTATION_DIR / "videos.jsonl"
MASTER_JSONL = ANNOTATION_DIR / "master.jsonl"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
SRT_EXTENSIONS = {".srt"}
APP_VERSION = "0.2.0"
DEFAULT_INSTRUCTION = "この歩行動画クリップと代表フレームを見て、発話内容を答えてください。"
SUPPORTED_EXPORT_FORMATS = {"master", "qwen", "llava", "trl"}


class VideoUploadResponse(BaseModel):
    video_id: str
    filename: str
    stored_path: str
    stream_url: str


class SubtitleItem(BaseModel):
    index: int | None
    start_time: float
    end_time: float
    text: str


class SrtUploadResponse(BaseModel):
    subtitle_id: str
    filename: str
    stored_path: str
    subtitles: list[SubtitleItem]


class SrtSaveRequest(BaseModel):
    path: str
    subtitles: list[SubtitleItem]


class SrtSaveResponse(BaseModel):
    path: str
    count: int


class TranscribeRequest(BaseModel):
    video_id: str
    video_path: str
    model_size: str = "base"
    language: str = "ja"


class MasterSubtitleInput(BaseModel):
    index: int | None = None
    start_time: float
    end_time: float
    text: str
    representative_time: float | None = None


class MasterExportRequest(BaseModel):
    video_id: str
    video_path: str
    subtitles: list[MasterSubtitleInput]
    export_clips: bool = False
    export_formats: list[str] = Field(default_factory=lambda: ["master"])


class MasterExportResponse(BaseModel):
    path: str
    count: int
    video_id: str
    clip_count: int = 0
    frame_count: int = 0
    export_path: str | None = None
    manifest_path: str | None = None
    selected_formats: list[str] = []
    files: list[str] = []


def ensure_dataset_dirs() -> None:
    for directory in (
        RAW_VIDEO_DIR,
        ANNOTATION_DIR,
        PROCESSED_CLIP_DIR,
        PROCESSED_FRAME_DIR,
        PROCESSED_AUDIO_DIR,
        EXPORT_DIR,
    ):
        directory.mkdir(parents=True, exist_ok=True)


def relative_to_root(path: Path) -> str:
    return path.resolve().relative_to(ROOT_DIR.resolve()).as_posix()


def safe_filename(filename: str) -> str:
    name = Path(filename).name.strip()
    stem = Path(name).stem
    suffix = Path(name).suffix.lower()
    safe_stem = re.sub(r"[^\w_.-]+", "_", stem, flags=re.UNICODE).strip("._")
    return f"{safe_stem or 'file'}{suffix}"


def safe_identifier(value: str) -> str:
    safe_value = re.sub(r"[^\w.-]+", "_", value, flags=re.UNICODE).strip("._-")
    return safe_value or "item"


def unique_path(directory: Path, filename: str) -> Path:
    candidate = directory / filename
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while True:
        candidate = directory / f"{stem}_{counter:03d}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def save_upload(file: UploadFile, directory: Path, allowed_extensions: set[str]) -> Path:
    original_name = file.filename or "uploaded"
    filename = safe_filename(original_name)
    suffix = Path(filename).suffix.lower()

    if suffix not in allowed_extensions:
        allowed = ", ".join(sorted(allowed_extensions))
        raise HTTPException(status_code=400, detail=f"Unsupported file type. Allowed: {allowed}")

    destination = unique_path(directory, filename)

    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return destination


def unique_video_id(original_filename: str) -> str:
    base_id = f"video_{safe_identifier(Path(original_filename or 'video').stem)}"
    used_ids = {
        str(record.get("video_id"))
        for record in read_jsonl(VIDEOS_JSONL) + read_jsonl(MASTER_JSONL)
        if record.get("video_id")
    }

    if base_id not in used_ids and not clip_directory(base_id).exists() and not frame_directory(base_id).exists():
        return base_id

    counter = 1
    while True:
        candidate = f"{base_id}_{counter:03d}"
        if candidate not in used_ids and not clip_directory(candidate).exists() and not frame_directory(candidate).exists():
            return candidate
        counter += 1


def save_srt_upload(file: UploadFile) -> Path:
    original_name = file.filename or "subtitle.srt"
    filename = safe_filename(original_name)
    suffix = Path(filename).suffix.lower()

    if suffix not in SRT_EXTENSIONS:
        allowed = ", ".join(sorted(SRT_EXTENSIONS))
        raise HTTPException(status_code=400, detail=f"Unsupported file type. Allowed: {allowed}")

    destination = unique_path(ANNOTATION_DIR, filename)

    with destination.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    return destination


def decode_srt_bytes(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "cp932", "shift_jis"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def parse_srt_timestamp(value: str) -> float:
    match = re.fullmatch(
        r"\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*",
        value,
    )
    if not match:
        raise ValueError(f"Invalid SRT timestamp: {value}")

    hours, minutes, seconds, milliseconds = match.groups()
    millis = int(milliseconds.ljust(3, "0")[:3])
    return int(hours) * 3600 + int(minutes) * 60 + int(seconds) + millis / 1000


def parse_srt(content: str) -> list[SubtitleItem]:
    normalized = content.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not normalized:
        return []

    blocks = re.split(r"\n{2,}", normalized)
    subtitles: list[SubtitleItem] = []

    for block in blocks:
        lines = [line.strip() for line in block.split("\n") if line.strip()]
        if not lines:
            continue

        index: int | None = None
        timing_line_position = 0

        if lines[0].isdigit():
            index = int(lines[0])
            timing_line_position = 1

        if timing_line_position >= len(lines) or "-->" not in lines[timing_line_position]:
            continue

        start_text, end_text = [part.strip() for part in lines[timing_line_position].split("-->", 1)]
        end_text = end_text.split(" ", 1)[0].strip()

        try:
            start_time = parse_srt_timestamp(start_text)
            end_time = parse_srt_timestamp(end_text)
        except ValueError:
            continue

        text = "\n".join(lines[timing_line_position + 1 :]).strip()
        subtitles.append(
            SubtitleItem(
                index=index,
                start_time=start_time,
                end_time=end_time,
                text=text,
            )
        )

    return subtitles


def format_srt_timestamp(seconds: float) -> str:
    total_milliseconds = max(0, round(seconds * 1000))
    hours = total_milliseconds // 3_600_000
    minutes = (total_milliseconds % 3_600_000) // 60_000
    secs = (total_milliseconds % 60_000) // 1000
    millis = total_milliseconds % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def build_srt(subtitles: list[SubtitleItem]) -> str:
    blocks: list[str] = []
    for idx, subtitle in enumerate(subtitles, start=1):
        text = subtitle.text.replace("\r\n", "\n").replace("\r", "\n").strip()
        blocks.append(
            "\n".join(
                [
                    str(idx),
                    f"{format_srt_timestamp(subtitle.start_time)} --> {format_srt_timestamp(subtitle.end_time)}",
                    text,
                ]
            )
        )
    if not blocks:
        return ""
    return "\n\n".join(blocks) + "\n"


def resolve_annotation_path(relative_path: str) -> Path:
    requested_path = resolve_dataset_path(relative_path)
    try:
        requested_path.relative_to(ANNOTATION_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid annotation path") from exc
    if requested_path.suffix.lower() not in SRT_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only SRT files can be saved")
    return requested_path


def next_sample_number(records: list[dict]) -> int:
    max_number = 0
    for record in records:
        sample_id = str(record.get("sample_id", ""))
        match = re.fullmatch(r"sample_(\d+)", sample_id)
        if match:
            max_number = max(max_number, int(match.group(1)))
    return max_number + 1


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []

    records: list[dict] = []
    with path.open("r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def write_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")


def resolve_dataset_path(relative_path: str) -> Path:
    requested_path = (ROOT_DIR / relative_path).resolve()
    try:
        requested_path.relative_to(ROOT_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid dataset path") from exc
    return requested_path


def clip_directory(video_id: str) -> Path:
    clip_dir = (PROCESSED_CLIP_DIR / video_id).resolve()
    try:
        clip_dir.relative_to(PROCESSED_CLIP_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid video_id") from exc
    return clip_dir


def frame_directory(video_id: str) -> Path:
    frame_dir = (PROCESSED_FRAME_DIR / video_id).resolve()
    try:
        frame_dir.relative_to(PROCESSED_FRAME_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid video_id") from exc
    return frame_dir


def clear_existing_clips(video_id: str) -> None:
    clip_dir = clip_directory(video_id)
    if clip_dir.exists():
        shutil.rmtree(clip_dir)


def clear_existing_frames(video_id: str) -> None:
    frame_dir = frame_directory(video_id)
    if frame_dir.exists():
        shutil.rmtree(frame_dir)


def write_clip(video_path: Path, video_id: str, sample_id: str, start_time: float, duration: float) -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed")

    clip_dir = clip_directory(video_id)
    clip_dir.mkdir(parents=True, exist_ok=True)
    output_path = clip_dir / f"{sample_id}.mp4"

    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(video_path),
        "-ss",
        f"{start_time:.3f}",
        "-t",
        f"{duration:.3f}",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "veryfast",
        "-c:a",
        "aac",
        "-movflags",
        "+faststart",
        str(output_path),
    ]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "ffmpeg failed"
        raise HTTPException(status_code=500, detail=f"Failed to write clip {sample_id}: {detail}")

    return relative_to_root(output_path)


def write_representative_frame(video_path: Path, video_id: str, sample_id: str, frame_time: float) -> str:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed")

    frame_dir = frame_directory(video_id)
    frame_dir.mkdir(parents=True, exist_ok=True)
    output_path = frame_dir / f"{sample_id}.jpg"

    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(video_path),
        "-ss",
        f"{frame_time:.3f}",
        "-frames:v",
        "1",
        "-q:v",
        "2",
        str(output_path),
    ]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "ffmpeg failed"
        raise HTTPException(status_code=500, detail=f"Failed to write representative frame {sample_id}: {detail}")

    return relative_to_root(output_path)


def extract_audio_for_transcription(video_path: Path, video_id: str) -> Path:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="ffmpeg is not installed")

    audio_dir = (PROCESSED_AUDIO_DIR / video_id).resolve()
    try:
        audio_dir.relative_to(PROCESSED_AUDIO_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid video_id") from exc

    audio_dir.mkdir(parents=True, exist_ok=True)
    output_path = audio_dir / "transcription.wav"
    command = [
        ffmpeg_path,
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(output_path),
    ]

    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        detail = result.stderr.strip().splitlines()[-1] if result.stderr.strip() else "ffmpeg failed"
        raise HTTPException(status_code=500, detail=f"Failed to extract audio: {detail}")

    return output_path


def transcribe_audio(audio_path: Path, model_size: str, language: str) -> list[SubtitleItem]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise HTTPException(
            status_code=500,
            detail="faster-whisper がインストールされていません。`cd backend && source .venv/bin/activate && pip install -r requirements.txt` を実行してください。",
        ) from exc

    try:
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        segments, _info = model.transcribe(
            str(audio_path),
            language=language or None,
            vad_filter=True,
            beam_size=5,
            word_timestamps=True,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {exc}") from exc

    subtitles: list[SubtitleItem] = []
    for idx, segment in enumerate(segments, start=1):
        text = segment.text.strip()
        if not text:
            continue
        start_time, end_time = segment_speech_bounds(segment)
        subtitles.append(
            SubtitleItem(
                index=idx,
                start_time=round(start_time, 3),
                end_time=round(end_time, 3),
                text=text,
            )
        )

    return subtitles


def segment_speech_bounds(segment: object) -> tuple[float, float]:
    words = getattr(segment, "words", None) or []
    timed_words = [
        word
        for word in words
        if getattr(word, "start", None) is not None and getattr(word, "end", None) is not None
    ]
    if timed_words:
        return float(timed_words[0].start), float(timed_words[-1].end)

    return float(segment.start), float(segment.end)


def save_transcribed_srt(video_path: Path, subtitles: list[SubtitleItem]) -> Path:
    filename = safe_filename(f"{video_path.stem}_transcribed.srt")
    destination = unique_path(ANNOTATION_DIR, filename)
    destination.write_text(build_srt(subtitles), encoding="utf-8")
    return destination


def write_export_jsonl(path: Path, records: list[dict]) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return relative_to_root(path)


def write_export_json(path: Path, payload: object) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return relative_to_root(path)


def unique_export_directory(video_id: str) -> Path:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base_name = f"export_{timestamp}_{safe_identifier(video_id)}"
    return unique_path(EXPORT_DIR, base_name)


def split_records(records: list[dict]) -> dict[str, list[dict]]:
    total = len(records)
    if total == 0:
        return {"train": [], "val": [], "test": []}

    if total == 1:
        split_names = ["train"]
    elif total == 2:
        split_names = ["train", "val"]
    else:
        train_count = max(1, round(total * 0.8))
        val_count = max(1, round(total * 0.1))
        if train_count + val_count >= total:
            train_count = max(1, total - 2)
            val_count = 1
        test_count = total - train_count - val_count
        split_names = ["train"] * train_count + ["val"] * val_count + ["test"] * test_count

    result = {"train": [], "val": [], "test": []}
    for idx, record in enumerate(records):
        split = split_names[min(idx, len(split_names) - 1)]
        record["split"] = split
        result[split].append(record)
    return result


def export_media_file(source_relative_path: str, export_root: Path, media_kind: str) -> str:
    source_path = resolve_dataset_path(source_relative_path)
    if not source_path.exists():
        raise HTTPException(status_code=500, detail=f"Media file not found: {source_relative_path}")

    destination = export_root / "media" / media_kind / source_path.name
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, destination)
    return destination.relative_to(export_root).as_posix()


def validate_master_records(records: list[dict]) -> None:
    required_fields = ("id", "start_time", "end_time", "instruction", "answer", "split")
    for idx, record in enumerate(records, start=1):
        missing = [field for field in required_fields if record.get(field) in (None, "")]
        if missing:
            raise HTTPException(status_code=400, detail=f"{idx}件目の必須項目が不足しています: {', '.join(missing)}")

        image_path = record.get("image_path") or record.get("representative_frame_path")
        clip_path = record.get("clip_path")
        if not image_path:
            raise HTTPException(status_code=400, detail=f"{idx}件目に代表フレーム画像がありません。")
        if not clip_path:
            raise HTTPException(status_code=400, detail=f"{idx}件目に動画クリップがありません。")
        if record["end_time"] <= record["start_time"]:
            raise HTTPException(status_code=400, detail=f"{idx}件目の終了時刻は開始時刻より後にしてください。")


def export_master(records_by_split: dict[str, list[dict]], export_root: Path) -> list[str]:
    records = [record for split in ("train", "val", "test") for record in records_by_split[split]]
    return [write_export_jsonl(export_root / "master" / "master.jsonl", records)]


def qwen_record(record: dict) -> dict:
    return {
        "id": record["id"],
        "split": record["split"],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": record["image_path"]},
                    {"type": "video", "video": record["clip_path"]},
                    {"type": "text", "text": record["instruction"]},
                ],
            },
            {"role": "assistant", "content": [{"type": "text", "text": record["answer"]}]},
        ],
        "metadata": {
            "start_time": record["start_time"],
            "end_time": record["end_time"],
            "duration": record["duration"],
            "video_id": record["video_id"],
        },
    }


def export_qwen(records_by_split: dict[str, list[dict]], export_root: Path) -> list[str]:
    files: list[str] = []
    for split, records in records_by_split.items():
        files.append(write_export_jsonl(export_root / "qwen" / f"{split}.jsonl", [qwen_record(record) for record in records]))
    return files


def llava_record(record: dict) -> dict:
    return {
        "id": record["id"],
        "image": record["image_path"],
        "video": record["clip_path"],
        "conversations": [
            {"from": "human", "value": f"<image>\n{record['instruction']}"},
            {"from": "gpt", "value": record["answer"]},
        ],
        "metadata": {
            "split": record["split"],
            "start_time": record["start_time"],
            "end_time": record["end_time"],
            "duration": record["duration"],
            "video_id": record["video_id"],
        },
    }


def export_llava(records_by_split: dict[str, list[dict]], export_root: Path) -> list[str]:
    files: list[str] = []
    for split, records in records_by_split.items():
        files.append(write_export_json(export_root / "llava" / f"{split}.json", [llava_record(record) for record in records]))
    return files


def trl_record(record: dict) -> dict:
    return {
        "id": record["id"],
        "split": record["split"],
        "image": record["image_path"],
        "video": record["clip_path"],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image"},
                    {"type": "text", "text": record["instruction"]},
                ],
            },
            {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": record["answer"]},
                ],
            },
        ],
        "start_time": record["start_time"],
        "end_time": record["end_time"],
        "duration": record["duration"],
    }


def export_trl(records_by_split: dict[str, list[dict]], export_root: Path) -> list[str]:
    files: list[str] = []
    for split, records in records_by_split.items():
        files.append(write_export_jsonl(export_root / "trl" / f"{split}.jsonl", [trl_record(record) for record in records]))
    return files


def run_selected_exporters(records_by_split: dict[str, list[dict]], export_root: Path, selected_formats: list[str]) -> list[str]:
    files: list[str] = []
    if "master" in selected_formats:
        files.extend(export_master(records_by_split, export_root))
    if "qwen" in selected_formats:
        files.extend(export_qwen(records_by_split, export_root))
    if "llava" in selected_formats:
        files.extend(export_llava(records_by_split, export_root))
    if "trl" in selected_formats:
        files.extend(export_trl(records_by_split, export_root))
    return files


app = FastAPI(title="Walking Video Dataset Builder API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    ensure_dataset_dirs()


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/videos", response_model=VideoUploadResponse)
def upload_video(file: Annotated[UploadFile, File(...)]) -> VideoUploadResponse:
    ensure_dataset_dirs()
    stored_path = save_upload(file, RAW_VIDEO_DIR, VIDEO_EXTENSIONS)
    video_id = unique_video_id(file.filename or stored_path.name)

    video_record = {
        "video_id": video_id,
        "filename": file.filename,
        "stored_path": relative_to_root(stored_path),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    with VIDEOS_JSONL.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(video_record, ensure_ascii=False) + "\n")

    return VideoUploadResponse(
        video_id=video_id,
        filename=file.filename or stored_path.name,
        stored_path=relative_to_root(stored_path),
        stream_url=f"/api/videos/{video_id}/stream?path={relative_to_root(stored_path)}",
    )


@app.get("/api/videos/{video_id}/stream")
def stream_video(video_id: str, path: str) -> FileResponse:
    requested_path = (ROOT_DIR / path).resolve()

    try:
        requested_path.relative_to(RAW_VIDEO_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid video path") from exc

    if not requested_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")

    return FileResponse(requested_path)


@app.post("/api/srt", response_model=SrtUploadResponse)
async def upload_srt(file: Annotated[UploadFile, File(...)]) -> SrtUploadResponse:
    ensure_dataset_dirs()
    stored_path = save_srt_upload(file)
    raw = stored_path.read_bytes()
    content = decode_srt_bytes(raw)
    subtitles = parse_srt(content)

    return SrtUploadResponse(
        subtitle_id=f"srt_{Path(stored_path).stem}",
        filename=file.filename or stored_path.name,
        stored_path=relative_to_root(stored_path),
        subtitles=subtitles,
    )


@app.post("/api/srt/parse", response_model=list[SubtitleItem])
async def parse_srt_file(file: Annotated[UploadFile, File(...)]) -> list[SubtitleItem]:
    raw = await file.read()
    return parse_srt(decode_srt_bytes(raw))


@app.post("/api/srt/save", response_model=SrtSaveResponse)
def save_srt(request: SrtSaveRequest) -> SrtSaveResponse:
    ensure_dataset_dirs()
    for subtitle in request.subtitles:
        if subtitle.end_time <= subtitle.start_time:
            raise HTTPException(status_code=400, detail="Each subtitle end_time must be greater than start_time")

    stored_path = resolve_annotation_path(request.path)
    stored_path.write_text(build_srt(request.subtitles), encoding="utf-8")

    return SrtSaveResponse(
        path=relative_to_root(stored_path),
        count=len(request.subtitles),
    )


@app.post("/api/transcribe", response_model=SrtUploadResponse)
def transcribe_video(request: TranscribeRequest) -> SrtUploadResponse:
    ensure_dataset_dirs()
    if not request.video_id:
        raise HTTPException(status_code=400, detail="video_id is required")

    video_path = resolve_dataset_path(request.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    audio_path = extract_audio_for_transcription(video_path, request.video_id)
    subtitles = transcribe_audio(audio_path, request.model_size, request.language)
    if not subtitles:
        raise HTTPException(status_code=500, detail="文字起こし結果が空でした。音声が含まれているか確認してください。")

    stored_path = save_transcribed_srt(video_path, subtitles)
    return SrtUploadResponse(
        subtitle_id=f"srt_{Path(stored_path).stem}",
        filename=stored_path.name,
        stored_path=relative_to_root(stored_path),
        subtitles=subtitles,
    )


@app.post("/api/master/utterances", response_model=MasterExportResponse)
def export_utterances(request: MasterExportRequest) -> MasterExportResponse:
    ensure_dataset_dirs()

    if not request.video_id:
        raise HTTPException(status_code=400, detail="video_id is required")
    if not request.subtitles:
        raise HTTPException(status_code=400, detail="subtitles are required")

    selected_formats = list(dict.fromkeys(request.export_formats or ["master"]))
    invalid_formats = [export_format for export_format in selected_formats if export_format not in SUPPORTED_EXPORT_FORMATS]
    if invalid_formats:
        raise HTTPException(status_code=400, detail=f"Unsupported export format: {', '.join(invalid_formats)}")

    video_path = resolve_dataset_path(request.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    for idx, subtitle in enumerate(request.subtitles, start=1):
        if subtitle.end_time <= subtitle.start_time:
            raise HTTPException(status_code=400, detail=f"{idx}件目の終了時刻は開始時刻より後にしてください。")
        if not subtitle.text.strip():
            raise HTTPException(status_code=400, detail=f"{idx}件目のanswerが空です。字幕本文を入力してください。")
        if subtitle.representative_time is None:
            raise HTTPException(status_code=400, detail=f"{idx}件目に代表フレームがありません。")
        if not (subtitle.start_time <= subtitle.representative_time <= subtitle.end_time):
            raise HTTPException(status_code=400, detail=f"{idx}件目の代表フレーム秒数が字幕区間外です。")

    existing_records = read_jsonl(MASTER_JSONL)
    kept_records = [record for record in existing_records if record.get("video_id") != request.video_id]
    sample_number = next_sample_number(kept_records)
    created_at = datetime.now(timezone.utc).isoformat()
    export_root = unique_export_directory(request.video_id)

    clear_existing_clips(request.video_id)
    clear_existing_frames(request.video_id)

    canonical_records: list[dict] = []
    clip_count = 0
    frame_count = 0
    for subtitle in request.subtitles:
        transcript = subtitle.text.strip()
        sample_id = f"sample_{sample_number:06d}"
        sample_number += 1
        duration = round(subtitle.end_time - subtitle.start_time, 3)

        clip_path = write_clip(
            video_path=video_path,
            video_id=request.video_id,
            sample_id=sample_id,
            start_time=subtitle.start_time,
            duration=duration,
        )
        clip_count += 1

        representative_frame_path = write_representative_frame(
            video_path=video_path,
            video_id=request.video_id,
            sample_id=sample_id,
            frame_time=subtitle.representative_time,
        )
        frame_count += 1

        canonical_records.append(
            {
                "id": sample_id,
                "sample_id": sample_id,
                "video_id": request.video_id,
                "start_time": round(subtitle.start_time, 3),
                "end_time": round(subtitle.end_time, 3),
                "duration": duration,
                "video_path": request.video_path,
                "clip_path": clip_path,
                "image_path": representative_frame_path,
                "representative_frame_path": representative_frame_path,
                "frame_paths": [representative_frame_path],
                "representative_time": round(subtitle.representative_time, 3),
                "instruction": DEFAULT_INSTRUCTION,
                "answer": transcript,
                "split": "",
                "transcript": transcript,
                "scene_description": "",
                "notes": "",
                "annotation_status": "draft",
                "created_at": created_at,
            }
        )

    export_records: list[dict] = []
    for record in canonical_records:
        export_record = dict(record)
        export_record["original_clip_path"] = record["clip_path"]
        export_record["original_image_path"] = record["image_path"]
        export_record["clip_path"] = export_media_file(record["clip_path"], export_root, "clips")
        export_record["image_path"] = export_media_file(record["image_path"], export_root, "images")
        export_record["representative_frame_path"] = export_record["image_path"]
        export_record["frame_paths"] = [export_record["image_path"]]
        export_records.append(export_record)

    records_by_split = split_records(export_records)
    canonical_by_id = {record["id"]: record for record in canonical_records}
    for export_record in export_records:
        canonical_record = canonical_by_id[export_record["id"]]
        canonical_record["split"] = export_record["split"]

    validate_master_records(export_records)
    write_jsonl(MASTER_JSONL, kept_records + canonical_records)

    files = run_selected_exporters(records_by_split, export_root, selected_formats)
    split_counts = {split: len(records) for split, records in records_by_split.items()}
    manifest = {
        "app_version": APP_VERSION,
        "created_at": created_at,
        "video_id": request.video_id,
        "record_count": len(export_records),
        "clip_count": clip_count,
        "frame_count": frame_count,
        "selected_formats": selected_formats,
        "split_strategy": {"train": 0.8, "val": 0.1, "test": 0.1},
        "split_counts": split_counts,
        "files": [Path(file_path).relative_to(relative_to_root(export_root)).as_posix() if file_path.startswith(relative_to_root(export_root)) else file_path for file_path in files],
    }
    manifest_path = write_export_json(export_root / "manifest.json", manifest)

    return MasterExportResponse(
        path=relative_to_root(MASTER_JSONL),
        count=len(export_records),
        video_id=request.video_id,
        clip_count=clip_count,
        frame_count=frame_count,
        export_path=relative_to_root(export_root),
        manifest_path=manifest_path,
        selected_formats=selected_formats,
        files=files + [manifest_path],
    )
