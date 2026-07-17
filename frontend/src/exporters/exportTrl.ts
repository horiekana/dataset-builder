import type { ExportedDatasetFile, ExporterContext, MasterRecord, MasterSplit } from "../core/schema";

function toTrlRecord(record: MasterRecord) {
  return {
    id: record.id,
    split: record.split,
    image: record.image_path,
    video: record.clip_path,
    messages: [
      {
        role: "user",
        content: [
          { type: "image" },
          { type: "text", text: record.instruction },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: record.answer }],
      },
    ],
    start_time: record.start_time,
    end_time: record.end_time,
    duration: record.duration,
  };
}

export function exportTrl(context: ExporterContext): ExportedDatasetFile[] {
  return (["train", "val", "test"] as MasterSplit[]).map((split) => ({
    path: `trl/${split}.jsonl`,
    format: "trl",
    content: context.recordsBySplit[split].map((record) => JSON.stringify(toTrlRecord(record))).join("\n") + "\n",
  }));
}
