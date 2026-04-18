import { registry } from "./registry.js";
import type { AnyPlugin, SlotKind, SlotToPlugin } from "./types.js";

export function stableStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(",")}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((obj as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(",")}}`;
}

export class PluginCache {
  private instances = new Map<string, AnyPlugin>();

  private key(kind: SlotKind, name: string, config: Record<string, unknown> = {}): string {
    return `${kind}:${name}:${stableStringify(config)}`;
  }

  async get<K extends SlotKind>(
    kind: K,
    name: string,
    config: Record<string, unknown> = {}
  ): Promise<SlotToPlugin<K>> {
    const cacheKey = this.key(kind, name, config);
    const cached = this.instances.get(cacheKey);
    if (cached) return cached as SlotToPlugin<K>;
    const instance = await registry.create(kind, name, config);
    this.instances.set(cacheKey, instance);
    return instance;
  }

  async teardownAll(): Promise<void> {
    for (const p of this.instances.values()) {
      await p.teardown?.().catch(() => undefined);
    }
    this.instances.clear();
  }
}
