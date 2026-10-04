const mediaTypes: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
};

/** Shared by the preview selector and the authenticated download response. */
export function mediaType(title: string, language?: string): string | undefined {
  if (language?.toLowerCase() === "pdf") return "application/pdf";
  return mediaTypes[title.split(".").pop()?.toLowerCase() ?? ""];
}
