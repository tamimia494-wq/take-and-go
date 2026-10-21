import type { NextConfig } from "next";
import path from "node:path";

const workspaceRoot = path.join(__dirname, "../..");
const config: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot }
};
export default config;
