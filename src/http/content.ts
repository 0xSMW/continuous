export function isJsonContentType(contentType: string | null) {
  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();

  return mediaType === "application/json";
}
