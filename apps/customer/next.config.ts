import type { NextConfig } from "next";
import path from "node:path";

const workspaceRoot = path.join(__dirname, "../..");
const config: NextConfig = {
  outputFileTracingRoot: workspaceRoot,
  turbopack: { root: workspaceRoot },
  // lets phones on the same Wi-Fi load the dev server
  allowedDevOrigins: ["10.206.5.18", "192.168.*.*", "10.*.*.*"]
};
export default config;
