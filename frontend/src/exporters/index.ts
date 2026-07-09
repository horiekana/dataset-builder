import { validateMaster } from "../core/validateMaster";
import type { ExportedDatasetFile, ExporterContext, ExportFormat } from "../core/schema";
import { exportLlava } from "./exportLlava";
import { exportMaster } from "./exportMaster";
import { exportQwen } from "./exportQwen";
import { exportTrl } from "./exportTrl";

export const DEFAULT_EXPORT_FORMATS: ExportFormat[] = ["master"];

export const EXPORT_FORMAT_OPTIONS: Array<{ id: ExportFormat; label: string }> = [
  { id: "master", label: "master.jsonl" },
  { id: "qwen", label: "Qwen2.5-VL JSONL" },
  { id: "llava", label: "LLaVA JSON" },
  { id: "trl", label: "TRL/SFTTrainer JSONL" },
];

const exporters: Record<ExportFormat, (context: ExporterContext) => ExportedDatasetFile[]> = {
  master: exportMaster,
  qwen: exportQwen,
  llava: exportLlava,
  trl: exportTrl,
};

export function runSelectedExporters(context: ExporterContext, selectedFormats: ExportFormat[]): ExportedDatasetFile[] {
  const validationErrors = validateMaster(context.records);
  if (validationErrors.length > 0) {
    throw new Error(validationErrors.join("\n"));
  }

  return selectedFormats.flatMap((format) => exporters[format](context));
}
