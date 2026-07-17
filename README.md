# Walking Video Dataset Builder

研究用の歩行動画データセット作成ツールです。現時点では、動画ファイルと外部ツールで作成済みのSRT字幕ファイルを読み込み、またはfaster-whisperで動画から字幕下書きを作成し、ブラウザ上で動画再生、現在秒数コピー、字幕一覧表示、字幕編集、字幕の追加・削除、発話区間編集、代表フレーム指定、SRT上書き保存、発話単位の内部master形式への正規化、モデル別データセット出力、発話ごとの動画クリップ書き出しを行います。

字幕間の `+` を押すと、その位置に空字幕を追加します。新しい字幕は基本2秒間で、次の字幕が近い場合は次の開始時刻までの区間になります。SRTは `Command+S`、または `Ctrl+S` で上書き保存します。データセット出力では `master.jsonl`、Qwen2.5-VL用JSONL、LLaVA用JSON、TRL/SFTTrainer用JSONLをチェックボックスで選択できます。`master.jsonl` はデフォルトONです。

この段階では、文字起こし機能は実装していません。

## 構成

```text
dataset/
  raw/
    videos/
  processed/
    audio/
    clips/
    frames/
  annotations/
    videos.jsonl
    master.jsonl
  exports/
backend/
  app/
frontend/
  src/
    core/
    exporters/
```

## Backend

通常は、ルートディレクトリで次の1コマンドだけ実行します。

```bash
python run.py
```

起動後、ブラウザで `http://127.0.0.1:5173` が開きます。止めるときはターミナルで `Ctrl+C` を押します。

ブラウザを自動で開かない場合:

```bash
python run.py --no-open
```

## 初回セットアップ

初回だけ、backend と frontend の依存関係をインストールします。

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`faster-whisper` は初回の文字起こし時にモデルをダウンロードします。まずは `base` モデル、日本語指定で字幕下書きを作成します。

別の場所から続けて:

```bash
cd ../frontend
npm install
```

以後はルートディレクトリで `python run.py` を使えます。

## Backend API

API:

- `POST /api/videos`: 動画ファイルを `dataset/raw/videos/` に保存します。
- `GET /api/videos/{video_id}/stream`: 保存済み動画をブラウザ再生用に返します。
- `POST /api/srt`: SRTファイルを `dataset/annotations/` に保存し、字幕配列を返します。同名ファイルがある場合は `_001` のような連番を付けます。
- `POST /api/srt/parse`: SRTファイルを保存せずにパース結果だけ返します。
- `POST /api/srt/save`: 画面で編集・追加・削除した字幕本文と区間を、読み込み済みSRTファイルへ上書き保存します。字幕をすべて削除した場合は空のSRTとして保存します。
- `POST /api/transcribe`: 動画から音声を抽出し、faster-whisperで字幕下書きを作成します。結果は `dataset/annotations/` にSRTとして保存され、画面の字幕一覧に読み込まれます。
- `POST /api/master/utterances`: 編集済み字幕を内部master形式に正規化し、`dataset/annotations/master.jsonl` を更新します。代表フレーム画像は `dataset/processed/frames/{video_id}/`、動画クリップは `dataset/processed/clips/{video_id}/` に書き出します。選択された形式は `dataset/exports/export_.../` にまとめて出力します。

`videos.jsonl` は読み込んだ動画の登録台帳です。現時点の `master.jsonl` 書き出しだけなら必須ではありませんが、複数動画の `video_id`、元ファイル名、保存先パスを後から確認できるように残しています。
`video_id` は元動画ファイル名ベースで作成します。たとえば `テスト用2.mp4` は `video_テスト用2` になり、同じIDが既にある場合は `video_テスト用2_001` のように連番を付けます。

SRTの返却形式:

```json
[
  {
    "index": 1,
    "start_time": 72.4,
    "end_time": 78.7,
    "text": "subtitle text"
  }
]
```

`master.jsonl` の1行は発話1件です。`clip_path` にクリップの相対パス、`representative_frame_path`、`image_path`、`frame_paths` に代表フレーム画像パスが入ります。書き出し時は、同じ `video_id` の古いクリップと代表フレームを削除してから現在の編集済み区間だけを書き出します。
アプリ上で直接打ち込み編集した発話区間は、`start_time`、`end_time`、`duration` に反映されます。
動画クリップは区間の正確さを優先し、ffmpeg の `libx264 -crf 18 -preset veryfast` で高品質再エンコードします。

モデル別出力は必ず内部master形式を経由します。出力前に、`id`、`start_time`、`end_time`、`instruction`、`answer`、`split`、`image_path`、`clip_path` が揃っているかを検証します。字幕本文が空、代表フレーム未設定、区間不正の場合は出力せずエラーにします。

出力フォルダ例:

```text
dataset/exports/export_20260708T120000Z_video_example/
  manifest.json
  media/
    clips/
    images/
  master/
    master.jsonl
  qwen/
    train.jsonl
    val.jsonl
    test.jsonl
  llava/
    train.json
    val.json
    test.json
  trl/
    train.jsonl
    val.jsonl
    test.jsonl
```

`manifest.json` には、出力日時、件数、選択形式、データ分割、アプリバージョン、出力ファイル一覧が入ります。

TRL/SFTTrainer用JSONLはVLM向けに、`image` 列と structured `messages.content` を出力します。`messages[0].content` は `{"type": "image"}` と `{"type": "text"}` の配列です。`video` には対応する動画クリップのパスも残しますが、SFTTrainerでまず使う主入力は代表フレーム画像です。

```json
{
  "sample_id": "sample_000001",
  "video_id": "video_001",
  "start_time": 72.4,
  "end_time": 78.7,
  "duration": 6.3,
  "video_path": "dataset/raw/videos/example.mp4",
  "clip_path": "dataset/processed/clips/video_001/sample_000001.mp4",
  "image_path": "dataset/processed/frames/video_001/sample_000001.jpg",
  "representative_frame_path": "dataset/processed/frames/video_001/sample_000001.jpg",
  "frame_paths": [
    "dataset/processed/frames/video_001/sample_000001.jpg"
  ],
  "representative_time": 75.2,
  "instruction": "この歩行動画クリップと代表フレームを見て、発話内容を答えてください。",
  "answer": "edited subtitle text",
  "split": "train",
  "transcript": "edited subtitle text",
  "scene_description": "",
  "notes": "",
  "annotation_status": "draft"
}
```

## 手動起動

必要な場合は、従来どおり別ターミナルで個別起動できます。

```bash
cd frontend
npm run dev
```

ブラウザで `http://localhost:5173` を開きます。

バックエンドURLを変える場合:

```bash
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```
