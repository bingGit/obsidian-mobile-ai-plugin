export type ContextAttachmentType = "file" | "current-file" | "selection";

export interface ContextAttachment {
  id: string;
  type: ContextAttachmentType;
  label: string;
  path?: string;
  content?: string;
  addedAt: number;
}

export interface BuiltContext {
  prompt: string;
  attachments: ContextAttachment[];
  warnings: string[];
  characterCount: number;
}
