import { parse } from "smol-toml";
import { isRecord, isRpcRequest, type RpcMessage } from "./rpc.js";

export function mergeClientConfig(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map((key) => {
    const value = overrides[key];
    return [key, Object.hasOwn(overrides, key)
      ? isRecord(base[key]) && isRecord(value) ? mergeClientConfig(base[key], value) : value
      : base[key]];
  }));
}

export function clientConfigFromArgs(args: readonly string[]): Record<string, unknown> {
  let config: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-c" || arg === "--config" || arg.startsWith("--config=")) {
      const raw = arg.startsWith("--config=") ? arg.slice(9) : args[++i];
      if (!raw) throw new Error("Missing client config override");
      // Use the actual TOML grammar for quoted keys, inline tables and arrays.
      let parsed: Record<string, unknown>;
      try { parsed = parse(raw); }
      catch {
        const separator = raw.indexOf("=");
        if (separator < 1) throw new Error("Invalid client config override");
        parsed = parse(`${raw.slice(0, separator)}=${JSON.stringify(raw.slice(separator + 1))}`);
      }
      config = mergeClientConfig(config, parsed);
    } else if (arg === "--enable" || arg === "--disable") {
      const feature = args[++i];
      if (!feature || !/^[a-zA-Z0-9_]+$/.test(feature)) throw new Error("Invalid feature override");
      config = mergeClientConfig(config, { features: { [feature]: arg === "--enable" } });
    } else if (!["app-server", "--analytics-default-enabled", "--stdio"].includes(arg)) {
      throw new Error("Unsupported shared-client launch option; refusing to silently discard it");
    }
  }
  return config;
}

export function withClientConfig(message: RpcMessage, config: Record<string, unknown>): RpcMessage {
  if (!isRpcRequest(message) || !["thread/start", "thread/resume", "thread/fork"].includes(message.method) || Object.keys(config).length === 0) return message;
  const params = isRecord(message.params) ? message.params : {};
  return { ...message, params: { ...params, config: mergeClientConfig(config, isRecord(params.config) ? params.config : {}) } };
}
