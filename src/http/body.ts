import { isJsonContentType } from "./content";

export const defaultMaxJsonBodyBytes = 1_048_576;

type BodyError = {
  code: string;
  message: string;
};

type ReadJsonObjectBodyOptions = {
  maxBytes?: number;
  invalidContentType: BodyError;
  invalidJson: BodyError;
  invalidObject: BodyError;
  tooLarge: (maxBytes: number) => BodyError;
};

export type JsonObjectBodyResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: BodyError };

function bodyTooLarge(maxBytes: number, options: ReadJsonObjectBodyOptions) {
  return {
    ok: false,
    status: 413,
    error: options.tooLarge(maxBytes),
  } as const;
}

async function readBoundedBodyText(
  request: Request,
  options: ReadJsonObjectBodyOptions,
): Promise<
  | { ok: true; value: string }
  | { ok: false; status: number; error: BodyError }
> {
  const maxBytes = options.maxBytes ?? defaultMaxJsonBodyBytes;
  const contentLength = Number(request.headers.get("content-length") ?? 0);

  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return bodyTooLarge(maxBytes, options);
  }

  if (!request.body) {
    return { ok: true, value: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    totalBytes += value.byteLength;

    if (totalBytes > maxBytes) {
      await reader.cancel();
      return bodyTooLarge(maxBytes, options);
    }

    chunks.push(value);
  }

  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, value: new TextDecoder().decode(bodyBytes) };
}

export async function readJsonObjectBody(
  request: Request,
  options: ReadJsonObjectBodyOptions,
): Promise<JsonObjectBodyResult> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      status: 415,
      error: options.invalidContentType,
    };
  }

  try {
    const bodyText = await readBoundedBodyText(request, options);

    if (!bodyText.ok) {
      return bodyText;
    }

    const value = JSON.parse(bodyText.value) as unknown;

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        ok: false,
        status: 400,
        error: options.invalidObject,
      };
    }

    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return {
      ok: false,
      status: 400,
      error: options.invalidJson,
    };
  }
}
