import type { MasterRecord } from "./schema";

const requiredFields: Array<keyof MasterRecord> = [
  "id",
  "start_time",
  "end_time",
  "instruction",
  "answer",
  "split",
  "image_path",
  "clip_path",
];

export function validateMaster(records: MasterRecord[]): string[] {
  const errors: string[] = [];

  records.forEach((record, index) => {
    requiredFields.forEach((field) => {
      const value = record[field];
      if (value === undefined || value === null || value === "") {
        errors.push(`${index + 1}件目の${String(field)}が不足しています。`);
      }
    });

    if (record.end_time <= record.start_time) {
      errors.push(`${index + 1}件目のend_timeはstart_timeより後にしてください。`);
    }
  });

  return errors;
}
