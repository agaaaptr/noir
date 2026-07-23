import * as z from 'zod/v4';

export const NoirConfigSchema = z.object({
  host: z.literal('claude'),
  name: z.string().optional(),
  mode: z.enum(['full', 'quick']).default('full'),
  daemon: z
    .object({
      idleTimeoutSec: z.number().int().positive().default(900),
      port: z.number().int().min(0).max(65535).optional(),
    })
    .default({ idleTimeoutSec: 900 }),
});

export type NoirConfig = z.infer<typeof NoirConfigSchema>;

export function parseConfig(raw: unknown): NoirConfig {
  return NoirConfigSchema.parse(raw);
}
