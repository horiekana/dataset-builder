import type { ExportedDatasetFile, ExporterContext } from "../core/schema";

export function exportMaster(context: ExporterContext): ExportedDatasetFile[] {
  return [
    {
      path: "master/master.jsonl",
      format: "master",
      content: context.records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    },
  ];
}
