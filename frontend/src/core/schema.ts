export type ExportFormat = "master" | "qwen" | "llava" | "trl";

export type MasterSplit = "train" | "val" | "test";

export type MasterRecord = {
  id: string;
  sample_id: string;
  video_id: string;
  start_time: number;
  end_time: number;
  duration: number;
  video_path: string;
  clip_path: string;
  image_path: string;
  representative_frame_path: string;
  frame_paths: string[];
  representative_time: number;
  instruction: string;
  answer: string;
  transcript: string;
  split: MasterSplit;
  scene_description: string;
  notes: string;
  annotation_status: "draft" | "reviewed" | "done";
  created_at: string;
};

export type ExportedDatasetFile = {
  path: string;
  format: ExportFormat;
  content: string;
};

export type ExporterContext = {
  records: MasterRecord[];
  recordsBySplit: Record<MasterSplit, MasterRecord[]>;
};

export type ExportManifest = {
  app_version: string;
  created_at: string;
  record_count: number;
  selected_formats: ExportFormat[];
  split_strategy: Record<MasterSplit, number>;
  split_counts: Record<MasterSplit, number>;
  files: string[];
};
