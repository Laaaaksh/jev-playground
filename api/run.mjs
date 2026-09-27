import { handleRun } from "../lib/relay.mjs";

export function POST(request) {
  return handleRun(request);
}
