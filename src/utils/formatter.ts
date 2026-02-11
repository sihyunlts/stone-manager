import { invoke } from "@tauri-apps/api/core";

export function toHex(value: number, width: number) {
  return value.toString(16).toUpperCase().padStart(width, "0");
}

export function parseHexBytes(input: string): number[] {
  const cleaned = input.replace(/[^0-9a-fA-F]/g, "");
  if (cleaned.length === 0) return [];
  if (cleaned.length % 2 !== 0) {
    throw new Error("Payload hex must have even length");
  }
  const bytes: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    bytes.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return bytes;
}

export function logLine(line: string, tone: "IN" | "OUT" | "SYS" = "SYS") {
  void invoke("log_line", { line, tone, ts: "" });
}
