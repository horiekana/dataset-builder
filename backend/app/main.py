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
from pydantic import BaseModel


ROOT_DIR = Path(__file__).resolve().parents[2]
DATASET_DIR = ROOT_DIR / "dataset"
RAW_VIDEO_DIR = DATASET_DIR / "raw" / "videos"
ANNOTATION_DIR = DATASET_DIR / "annotations"
PROCESSED_CLIP_DIR = DATASET_DIR / "processed" / "clips"
PROCESSED_FRAME_DIR = DATASET_DIR / "processed" / "frames"
EXPORT_DIR = DATASET_DIR / "exports"
VIDEOS_JSONL = ANNOTATION_DIR / "videos.jsonl"
MASTER_JSONL = ANNOTATION_DIR / "master.jsonl"

VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
SRT_EXTENSIONS = {".srt"}


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


class MasterExportResponse(BaseModel):
    path: str
    count: int
    video_id: str
    clip_count: int = 0
    frame_count: int = 0


def ensure_dataset_dirs() -> None:
    for directory in (
        RAW_VIDEO_DIR,
        ANNOTATION_DIR,
        PROCESSED_CLIP_DIR,
        PROCESSED_FRAME_DIR,
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


@app.post("/api/master/utterances", response_model=MasterExportResponse)
def export_utterances(request: MasterExportRequest) -> MasterExportResponse:
    ensure_dataset_dirs()

    if not request.video_id:
        raise HTTPException(status_code=400, detail="video_id is required")
    if not request.subtitles:
        raise HTTPException(status_code=400, detail="subtitles are required")

    video_path = resolve_dataset_path(request.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    existing_records = read_jsonl(MASTER_JSONL)
    kept_records = [record for record in existing_records if record.get("video_id") != request.video_id]
    sample_number = next_sample_number(kept_records)
    created_at = datetime.now(timezone.utc).isoformat()

    if request.export_clips:
        clear_existing_clips(request.video_id)

    clear_existing_frames(request.video_id)

    new_records: list[dict] = []
    clip_count = 0
    frame_count = 0
    for subtitle in request.subtitles:
        if subtitle.end_time <= subtitle.start_time:
            continue

        if subtitle.representative_time is not None and not (
            subtitle.start_time <= subtitle.representative_time <= subtitle.end_time
        ):
            raise HTTPException(
                status_code=400,
                detail="representative_time must be between start_time and end_time",
            )

        transcript = subtitle.text.strip()
        sample_id = f"sample_{sample_number:06d}"
        sample_number += 1
        duration = round(subtitle.end_time - subtitle.start_time, 3)
        clip_path = ""
        representative_frame_path = ""

        if request.export_clips:
            clip_path = write_clip(
                video_path=video_path,
                video_id=request.video_id,
                sample_id=sample_id,
                start_time=subtitle.start_time,
                duration=duration,
            )
            clip_count += 1

        if subtitle.representative_time is not None:
            representative_frame_path = write_representative_frame(
                video_path=video_path,
                video_id=request.video_id,
                sample_id=sample_id,
                frame_time=subtitle.representative_time,
            )
            frame_count += 1

        new_records.append(
            {
                "sample_id": sample_id,
                "video_id": request.video_id,
                "start_time": round(subtitle.start_time, 3),
                "end_time": round(subtitle.end_time, 3),
                "duration": duration,
                "video_path": request.video_path,
                "clip_path": clip_path,
                "representative_frame_path": representative_frame_path,
                "frame_paths": [representative_frame_path] if representative_frame_path else [],
                "representative_time": round(subtitle.representative_time, 3)
                if subtitle.representative_time is not None
                else None,
                "transcript": transcript,
                "scene_description": "",
                "notes": "",
                "annotation_status": "draft",
                "created_at": created_at,
            }
        )

    write_jsonl(MASTER_JSONL, kept_records + new_records)

    return MasterExportResponse(
        path=relative_to_root(MASTER_JSONL),
        count=len(new_records),
        video_id=request.video_id,
        clip_count=clip_count,
        frame_count=frame_count,
    )
