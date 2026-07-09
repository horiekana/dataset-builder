import type { ExportedDatasetFile, ExporterContext, MasterRecord, MasterSplit } from "../core/schema";

function toQwenRecord(record: MasterRecord) {
  return {
    id: record.id,
    split: record.split,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", image: record.image_path },
          { type: "video", video: record.clip_path },
          { type: "text", text: record.instruction },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: record.answer }],
      },
    ],
    metadata: {
      start_time: record.start_time,
      end_time: record.end_time,
      duration: record.duration,
      video_id: record.video_id,
    },
  };
}

export function exportQwen(context: ExporterContext): ExportedDatasetFile[] {
  return (["train", "val", "test"] as MasterSplit[]).map((split) => ({
    path: `qwen/${split}.jsonl`,
    format: "qwen",
    content: context.recordsBySplit[split].map((record) => JSON.stringify(toQwenRecord(record))).join("\n") + "\n",
  }));
}
