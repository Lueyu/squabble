/** One transient image attachment. Never serialize this into durable task records. */
export interface NativeAgentImage {
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export const MAX_NATIVE_IMAGE_BYTES = 8 * 1024 * 1024;
