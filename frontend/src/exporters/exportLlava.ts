import type { ExportedDatasetFile, ExporterContext, MasterRecord, MasterSplit } from "../core/schema";

function toLlavaRecord(record: MasterRecord) {
  return {
    id: record.id,
    image: record.image_path,
    video: record.clip_path,
    conversations: [
      { from: "human", value: `<image>\n${record.instruction}` },
      { from: "gpt", value: record.answer },
    ],
    metadata: {
      split: record.split,
      start_time: record.start_time,
      end_time: record.end_time,
      duration: record.duration,
      video_id: record.video_id,
    },
  };
}

export function exportLlava(context: ExporterContext): ExportedDatasetFile[] {
  return (["train", "val", "test"] as MasterSplit[]).map((split) => ({
    path: `llava/${split}.json`,
    format: "llava",
    content: JSON.stringify(context.recordsBySplit[split].map((record) => toLlavaRecord(record)), null, 2) + "\n",
  }));
}
