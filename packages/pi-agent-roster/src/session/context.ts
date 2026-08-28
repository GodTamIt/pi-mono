import type { TextContent } from "@earendil-works/pi-ai";

function isTextContent(content: unknown): content is TextContent {
  return (
    typeof content === "object" &&
    content !== null &&
    (content as { type?: unknown }).type === "text"
  );
}

/** Extract text blocks from child-owned message content. */
export function extractText(content: unknown[]): string {
  return content
    .filter(isTextContent)
    .map((block) => block.text)
    .join("\n");
}
