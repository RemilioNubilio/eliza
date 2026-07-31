/**
 * Runtime exports for the Showcase plugin: the plugin itself plus the shared
 * use case and DTO types consumers read to describe elizaOS.
 */

export { default as plugin, describeElizaAction } from "./plugin.js";
export type {
  ElizaFeature,
  ElizaPrimitive,
  ElizaShowcase,
  ElizaStat,
} from "./showcase.js";
export { formatShowcaseText, getElizaShowcase } from "./showcase.js";
